const { app, BrowserWindow, ipcMain, clipboard, dialog, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const crypto = require('crypto');
const { execFileSync, execFile, spawn } = require('child_process');
const { fileURLToPath, pathToFileURL } = require('url');
const pty = require('node-pty');
const { upsertProjectMixerHook } = require('./hook-settings.cjs');
const { PLUGIN_SOURCE: OPENCODE_PLUGIN_SOURCE } = require('./src/main/opencode-plugin-source.cjs');
const { startMcpServer } = require('./src/mcp/server.cjs');
const { buildAgentMcpArgs, buildPowerShellInvocation } = require('./src/mcp/launch.cjs');
const { buildResumeArgs } = require('./src/main/resume-args.cjs');
const {
  parseDevinSessionList,
  pickDevinResumeCandidate,
  isSafeCwd,
  MAX_JSON_BYTES,
} = require('./src/main/devin-session-index.cjs');
const {
  WRAPPER_SOURCE: CODEX_WRAPPER_SOURCE,
  planCodexNotifyInstall,
} = require('./src/main/codex-notify.cjs');
const { buildPortRecord, writeJsonAtomic, writeTextAtomic } = require('./src/ports/state.cjs');
const { isProbablyBinary } = require('./src/files/content.cjs');
const { readConfig, writeConfig, validateProjects, validateLayout, validateSettings, ConfigParseError } = require('./src/main/config-service.cjs');
const { normalizeAgentNotification, resolveNotificationTarget } = require('./src/main/agent-notification-service.cjs');
const { DevinSessionMonitor } = require('./src/main/devin-session-monitor.cjs');
const { assertPathString, resolveProjectPath, resolveProjectRoot } = require('./src/main/path-safety.cjs');

function normalizeCommandName(command) {
  return String(command || '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

function canonicalProjectPath(value) {
  try {
    return fs.realpathSync.native(path.resolve(value));
  } catch {
    return path.resolve(value);
  }
}

// --- Profile separation (Phase 0.1) ---
// --dev flag or PM_PROFILE env var selects a separate userData directory
const IS_DEV = process.argv.includes('--dev') || process.env.PM_PROFILE === 'dev';
const PROFILE = IS_DEV ? 'dev' : 'default';

if (IS_DEV) {
  const defaultUserData = app.getPath('userData');
  app.setPath('userData', path.join(path.dirname(defaultUserData), 'Project Mixer Dev'));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock({ profile: PROFILE });
if (!hasSingleInstanceLock) app.quit();

app.on('second-instance', (_event, additionalData) => {
  if (additionalData?.profile && additionalData.profile !== PROFILE) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

let mainWindow;
let applicationMenu;
const ptys = new Map(); // id -> { process, cwd, command }
let ptyCounter = 0;

// --- Port separation (Phase 0.2) ---
// Base port differs by profile; actual port is auto-selected and written to a file
const BASE_PORT = IS_DEV ? 47842 : 47832;
const MCP_BASE_PORT = IS_DEV ? 47852 : 47822;
let HOOK_PORT = null;
let MCP_PORT = null;
let hookServer = null;
let mcpControl = null;
let devinMonitor = null;
let runtimeStarted = false;
let shutdownPromise = null;
let resolveMcpReady;
let resolveHookReady;
let rejectHookReady;
let mcpReady = Promise.resolve(null);
let hookReady = Promise.resolve(null);
let mcpReadyResult = mcpReady;
let hookReadyResult = hookReady;
const pendingPtyCreates = new Set();
const hookTokens = new Map();

function resetServiceReadiness() {
  mcpReady = new Promise((resolve) => { resolveMcpReady = resolve; });
  mcpReadyResult = mcpReady;
  hookReady = new Promise((resolve, reject) => {
    resolveHookReady = resolve;
    rejectHookReady = reject;
  });
  hookReadyResult = hookReady.catch((error) => {
    console.error('[Project Mixer] Hook server unavailable:', error.message);
    return null;
  });
}

resetServiceReadiness();

const configDir = path.join(app.getPath('userData'), 'project-mixer');
const projectsFile = path.join(configDir, 'projects.json');
const layoutFile = path.join(configDir, 'layout.json');
const portFile = path.join(configDir, 'port.json');
const settingsFile = path.join(configDir, 'settings.json');
let appSettings = { resumeMode: 'ask' };
let settingsCorrupt = false;
let layoutCorrupt = false;

function validateAppSettings(value) {
  if (value === null) value = { resumeMode: 'ask' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'settings.json must contain an object' };
  }
  const validation = validateSettings(value);
  if (!validation.ok) return validation;
  return { ok: true, value: { ...validation.value, resumeMode: validation.value.resumeMode || 'ask' } };
}

function loadAppSettings() {
  try {
    const data = readConfig(settingsFile, { resumeMode: 'ask' });
    const validation = validateAppSettings(data);
    if (!validation.ok) throw new ConfigParseError(settingsFile, new Error(validation.message));
    appSettings = validation.value;
  } catch (e) {
    settingsCorrupt = true;
    console.error(`[Project Mixer] ${e.message}; settings were not modified`);
    dialog.showErrorBox(
      'Project Mixer — corrupt settings',
      `${e.message}\n\nThe original file was preserved. Repair or remove it, then relaunch.`,
    );
    app.quit();
  }
}

function saveAppSettings() {
  if (settingsCorrupt) throw new Error('settings.json is corrupt; repair it before changing settings');
  const current = validateAppSettings(readConfig(settingsFile, { resumeMode: 'ask' }));
  if (!current.ok) {
    settingsCorrupt = true;
    throw new Error(`settings.json is invalid: ${current.message}`);
  }
  appSettings = { ...current.value, resumeMode: appSettings.resumeMode };
  ensureConfigDir();
  writeConfig(settingsFile, appSettings);
}

function ensureConfigDir() {
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
}

// R4: config reads/writes go through config-service. On corrupt config,
// readConfig throws ConfigParseError instead of silently returning the
// fallback — this prevents overwriting corrupt data with defaults.
// layout.json is allowed to be missing (returns null fallback); a corrupt
// layout is non-fatal and logged, but projects.json corruption stops startup.
function loadProjectsConfig() {
  try {
    const data = readConfig(projectsFile, []);
    const validation = validateProjects(data);
    if (!validation.ok) {
      throw new ConfigParseError(projectsFile, new Error(validation.message));
    }
    return validation.value;
  } catch (e) {
    if (e instanceof ConfigParseError) {
      console.error(`[config] ${e.message}`);
      throw e;
    }
    throw e;
  }
}

function loadLayoutConfig() {
  try {
    const data = readConfig(layoutFile, null);
    const validation = validateLayout(data);
    if (!validation.ok) {
      layoutCorrupt = true;
      console.error(`[config] layout.json invalid: ${validation.message}`);
      return null;
    }
    return validation.value;
  } catch (e) {
    // A corrupt layout is non-fatal — log and use null rather than blocking
    // startup. The user can still work; layout resets to defaults.
    if (e instanceof ConfigParseError) {
      layoutCorrupt = true;
      console.error(`[config] ${e.message} — continuing without overwriting it`);
      return null;
    }
    throw e;
  }
}

function saveProjectsConfig(projects) {
  const validation = validateProjects(projects);
  if (!validation.ok) throw new Error(`Refusing to persist invalid projects.json: ${validation.message}`);
  if (fs.existsSync(projectsFile)) loadProjectsConfig();
  ensureConfigDir();
  writeConfig(projectsFile, validation.value);
}

function saveLayoutConfig(layout) {
  if (layoutCorrupt) throw new Error('layout.json is corrupt; repair or remove it before saving layout');
  const validation = validateLayout(layout);
  if (!validation.ok) throw new Error(`Refusing to persist invalid layout.json: ${validation.message}`);
  if (fs.existsSync(layoutFile)) {
    const current = validateLayout(readConfig(layoutFile, null));
    if (!current.ok) {
      layoutCorrupt = true;
      throw new Error(`Refusing to overwrite invalid layout.json: ${current.message}`);
    }
  }
  ensureConfigDir();
  writeConfig(layoutFile, validation.value);
}

// --- Port discovery (Phase 0.2) ---
// The actual hook server retries binding; port.json is written only after
// successful listen, eliminating the race between test-bind and real-bind.
function startHookServerWithRetry(server, port, maxRetries, onReady, onFailed) {
  server.listen(port, '127.0.0.1');
  server.on('error', function onError(e) {
    if (e.code === 'EADDRINUSE' && port - BASE_PORT < maxRetries) {
      port++;
      server.listen(port, '127.0.0.1');
    } else if (e.code === 'EADDRINUSE') {
      console.error(`[Project Mixer] Hook server: no available port after ${maxRetries} retries from ${BASE_PORT}.`);
      if (onFailed) onFailed(e);
    } else {
      console.error('Hook server error:', e);
      if (onFailed) onFailed(e);
    }
  });
  server.on('listening', () => {
    HOOK_PORT = server.address().port;
    console.log(`[Project Mixer] Profile: ${PROFILE}, Hook port: ${HOOK_PORT}`);
    savePortJson();
    if (onReady) onReady(HOOK_PORT);
  });
}

const mainIndexPath = path.join(__dirname, 'index.html');

function isMainDocumentUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:') return false;
    const actualPath = path.resolve(fileURLToPath(parsed));
    const expectedPath = path.resolve(mainIndexPath);
    return process.platform === 'win32'
      ? actualPath.toLowerCase() === expectedPath.toLowerCase()
      : actualPath === expectedPath;
  } catch {
    return false;
  }
}

function assertTrustedMainIpcEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Main window is unavailable');
  if (event?.sender !== mainWindow.webContents) throw new Error('Untrusted IPC sender');
  if (!event.senderFrame || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Untrusted IPC sender frame');
  }
  const frameUrl = event.senderFrame.url || mainWindow.webContents.getURL();
  if (!isMainDocumentUrl(frameUrl)) throw new Error('Untrusted IPC origin');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Project Mixer',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#16181c',
      symbolColor: '#c8ccd4',
      height: 32,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const blockUnexpectedNavigation = (event, url) => {
    if (!isMainDocumentUrl(url)) event.preventDefault();
  };
  mainWindow.webContents.on('will-navigate', blockUnexpectedNavigation);
  mainWindow.webContents.on('will-redirect', blockUnexpectedNavigation);
  mainWindow.loadFile(mainIndexPath);
  setupApplicationMenu();

  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const pending of pendingPtyCreates) pending.cancelled = true;
    for (const [, proc] of activeSearches.entries()) {
      try { proc.process.kill(); } catch {}
    }
    activeSearches.clear();
  });
}

// A8: Application menu — calls renderer dispatch for existing commands.
// R1: errors are logged and the promise is returned so callers can handle
// failures. The old .catch(() => {}) silently swallowed dispatch errors.
function dispatchToRenderer(name, args = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve();
  return mainWindow.webContents.executeJavaScript(
    `window.__pmDispatch && window.__pmDispatch(${JSON.stringify(name)}, ${JSON.stringify(args)})`,
  ).catch((error) => {
    console.error(`[main] dispatchToRenderer(${name}) failed:`, error);
    throw error;
  });
}

function setupApplicationMenu() {
  const isMac = process.platform === 'darwin';

  // メニューのアクセラレータは keydown より先に Electron が消費するため、
  // ターミナルが使うキー（Ctrl+S=XOFF / Ctrl+B=tmux prefix / Ctrl+N=履歴 /
  // Ctrl+Enter・Ctrl+Shift+Z=エディタ内限定）を登録すると機能後退になる。
  // registerAccelerator:false なら「メニューに表示するが横取りしない」ため、
  // 発見可能性（A8 の目的）だけを得られる。
  const displayOnly = (accelerator) => ({ accelerator, registerAccelerator: false });

  const template = [
    // macOS ではテンプレート先頭がアプリメニューの位置に昇格する。
    // これを置かないと File の項目がアプリ名の下に吸収され、
    // quit role がどこにも無いため Cmd+Q が効かなくなる。
    ...(isMac ? [{ role: 'appMenu' }] : []),
    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'Add Project...',
          ...displayOnly('CmdOrCtrl+Shift+A'),
          click: () => dispatchToRenderer('add_project'),
        },
        {
          label: 'New File',
          click: () => dispatchToRenderer('new_file'),
        },
        {
          label: 'New Folder',
          ...displayOnly('CmdOrCtrl+Shift+N'),
          click: () => dispatchToRenderer('new_folder'),
        },
        { type: 'separator' },
        {
          label: 'Save Active File',
          ...displayOnly('CmdOrCtrl+S'),
          click: () => dispatchToRenderer('save_active_file'),
        },
        { type: 'separator' },
        {
          type: 'checkbox',
          label: 'Auto-Resume Previous Sessions',
          checked: appSettings.resumeMode === 'auto',
          click: (menuItem) => {
            appSettings.resumeMode = menuItem.checked ? 'auto' : 'ask';
            saveAppSettings();
            dispatchToRenderer('resume_mode_changed', { mode: appSettings.resumeMode });
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Close Window' } : { role: 'quit', label: 'Exit' },
      ],
    },
    // Edit menu
    // All roles use displayOnly so terminal shortcuts (Ctrl+C=SIGINT,
    // Ctrl+Z=suspend, Ctrl+V=paste, Ctrl+X, Ctrl+A) are not intercepted.
    {
      label: 'Edit',
      submenu: [
        { ...displayOnly('CmdOrCtrl+Z'), role: 'undo' },
        { ...displayOnly('CmdOrCtrl+Shift+Z'), role: 'redo' },
        { type: 'separator' },
        { ...displayOnly('CmdOrCtrl+X'), role: 'cut' },
        { ...displayOnly('CmdOrCtrl+C'), role: 'copy' },
        { ...displayOnly('CmdOrCtrl+V'), role: 'paste' },
        { ...displayOnly('CmdOrCtrl+A'), role: 'selectAll' },
      ],
    },
    // View menu
    // reload (Ctrl+R) and zoom (Ctrl+=/-) use displayOnly so terminal
    // reverse-search (Ctrl+R) and other shortcuts are not intercepted.
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          ...displayOnly('CmdOrCtrl+B'),
          click: () => dispatchToRenderer('toggle_sidebar'),
        },
        { type: 'separator' },
        { ...displayOnly('CmdOrCtrl+R'), role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { ...displayOnly('CmdOrCtrl+0'), role: 'resetZoom' },
        { ...displayOnly('CmdOrCtrl+='), role: 'zoomIn' },
        { ...displayOnly('CmdOrCtrl+-'), role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    // Terminal menu
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'New Terminal',
          ...displayOnly('CmdOrCtrl+Shift+T'),
          click: () => dispatchToRenderer('create_terminal'),
        },
        {
          label: 'Send to Terminal',
          ...displayOnly('CmdOrCtrl+Enter'),
          click: () => dispatchToRenderer('send_to_terminal'),
        },
        {
          label: 'Undo Last Send',
          ...displayOnly('CmdOrCtrl+Shift+Z'),
          click: () => dispatchToRenderer('undo_last_send'),
        },
      ],
    },
    // Help menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Project Mixer',
          click: () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Project Mixer',
              message: 'Project Mixer',
              detail: 'A multi-project terminal and editor manager with AI integration.\n\nPhase 2.5 — Adjustment Phase',
              buttons: ['OK'],
            });
          },
        },
      ],
    },
  ];

  applicationMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(applicationMenu);
}

ipcMain.handle('menu:popup', (event, payload = {}) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload !== 'object' || (payload.x !== undefined && !Number.isFinite(payload.x))
    || (payload.y !== undefined && !Number.isFinite(payload.y))) {
    throw new TypeError('menu:popup payload is invalid');
  }
  const ownerWindow = mainWindow;
  if (!applicationMenu || !ownerWindow || ownerWindow.isDestroyed()) return false;
  return new Promise((resolve) => {
    const options = {
      window: ownerWindow,
      callback: () => resolve(true),
    };
    if (Number.isFinite(payload.x)) options.x = Math.round(payload.x);
    if (Number.isFinite(payload.y)) options.y = Math.round(payload.y);
    applicationMenu.popup(options);
  });
});

function createDevinMonitor() {
  return new DevinSessionMonitor({
    token: process.env.DEVIN_API_TOKEN,
    orgId: process.env.DEVIN_ORG_ID,
    baseUrl: process.env.DEVIN_API_BASE_URL,
    onLifecycleEvent: forwardAgentLifecycleEvent,
    onError: forwardDevinMonitorError,
  });
}

function startRuntimeServices() {
  if (runtimeStarted) return;
  runtimeStarted = true;
  resetServiceReadiness();
  startHookServer();
  mcpControl = startMcpServer(MCP_BASE_PORT, async (commandName, args = {}, sessionContext = null) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { error: 'no window' };
    const commandArgs = sessionContext ? { ...args, $session: sessionContext } : args;
    return await mainWindow.webContents.executeJavaScript(
      `window.__pmDispatch && window.__pmDispatch(${JSON.stringify(commandName)}, ${JSON.stringify(commandArgs)})`
    );
  }, (port) => {
    MCP_PORT = port;
    resolveMcpReady(port);
    console.log(`[Project Mixer] MCP port: ${MCP_PORT}`);
    savePortJson();
  }, () => {
    resolveMcpReady(null);
  });
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  if (process.platform === 'win32') app.setAppUserModelId('com.projectmixer.app');
  loadAppSettings();
  if (settingsCorrupt) return;
  try {
    loadProjectsConfig();
  } catch (e) {
    if (e instanceof ConfigParseError) {
      dialog.showErrorBox(
        'Project Mixer — corrupt config',
        `${e.message}\n\nThe file was not overwritten. Please repair or remove it and relaunch.`,
      );
      app.quit();
      return;
    }
    throw e;
  }
  createWindow();
  devinMonitor = createDevinMonitor();
  startRuntimeServices();
});

app.on('activate', async () => {
  if (!hasSingleInstanceLock || !app.isReady() || (mainWindow && !mainWindow.isDestroyed())) return;
  if (shutdownPromise) await shutdownPromise;
  if (mainWindow && !mainWindow.isDestroyed()) return;
  createWindow();
  devinMonitor = createDevinMonitor();
  startRuntimeServices();
});

async function shutdownRuntimeServices() {
  if (shutdownPromise) return shutdownPromise;
  const promise = (async () => {
    for (const pending of pendingPtyCreates) pending.cancelled = true;
    for (const [, record] of ptys) {
      try { record.process.kill(); } catch {}
      if (record.hookToken) hookTokens.delete(record.hookToken);
      if (record.mcpToken) await mcpControl?.revokeSession(record.mcpToken);
    }
    ptys.clear();
    for (const [, record] of activeSearches) {
      try { record.process.kill(); } catch {}
    }
    activeSearches.clear();
    devinMonitor?.dispose();
    devinMonitor = null;
    resolveMcpReady?.(null);
    resolveHookReady?.(null);
    if (mcpControl) await mcpControl.close();
    mcpControl = null;
    if (hookServer) {
      await new Promise((resolve) => {
        try {
          hookServer.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
    hookServer = null;
    HOOK_PORT = null;
    MCP_PORT = null;
    runtimeStarted = false;
  })();
  shutdownPromise = promise;
  return promise.finally(() => {
    if (shutdownPromise === promise) shutdownPromise = null;
  });
}

// --- Atomic port.json writer ---
// Both hook server and MCP server call this when they become ready.
// It publishes only ports that are currently listening, then atomically
// replaces the discovery file so readers never see a partial JSON document.
function savePortJson() {
  ensureConfigDir();
  writeJsonAtomic(portFile, buildPortRecord({
    hookPort: HOOK_PORT,
    mcpPort: MCP_PORT,
    profile: PROFILE,
    pid: process.pid,
  }));
}

app.on('window-all-closed', async () => {
  await shutdownRuntimeServices();
  if (process.platform !== 'darwin') app.quit();
});

function validatePtyPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('PTY payload must be an object');
  }
  const command = payload.command ?? null;
  if (command !== null && (typeof command !== 'string' || !command.trim() || command.length > 512 || command.includes('\0'))) {
    throw new TypeError('PTY command is invalid');
  }
  const args = payload.args ?? [];
  if (!Array.isArray(args) || args.length > 256 || args.some((arg) => typeof arg !== 'string' || arg.length > 1024 || arg.includes('\0'))) {
    throw new TypeError('PTY args are invalid');
  }
  const cwd = payload.cwd ?? os.homedir();
  assertPathString(cwd, 'PTY cwd');
  if (!fs.statSync(cwd).isDirectory()) throw new TypeError('PTY cwd must be a directory');
  const projectId = payload.projectId ?? null;
  if (projectId !== null && (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 200)) {
    throw new TypeError('PTY projectId is invalid');
  }
  const cols = payload.cols ?? 80;
  const rows = payload.rows ?? 30;
  if (!Number.isInteger(cols) || cols < 1 || cols > 1000 || !Number.isInteger(rows) || rows < 1 || rows > 1000) {
    throw new TypeError('PTY dimensions are invalid');
  }
  const resumeSessionId = payload.resumeSessionId ?? null;
  if (resumeSessionId !== null && (typeof resumeSessionId !== 'string' || resumeSessionId.length > 512 || resumeSessionId.includes('\0'))) {
    throw new TypeError('PTY resumeSessionId is invalid');
  }
  const projects = loadProjectsConfig();
  if (projectId !== null) {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error('PTY project is not configured');
    const owned = resolveProjectPath(projects, cwd, { allowRoot: true, requireExisting: true, type: 'directory' });
    if (owned.project.id !== projectId) throw new Error('PTY cwd is outside its project');
  } else if (cwd !== os.homedir()) {
    resolveProjectPath(projects, cwd, { allowRoot: true, requireExisting: true, type: 'directory' });
  }
  return { command, args, cwd: path.resolve(cwd), projectId, cols, rows, resumeSessionId };
}

ipcMain.handle('pty:create', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  const options = validatePtyPayload(payload);
  const id = ++ptyCounter;
  const pending = { cancelled: false };
  pendingPtyCreates.add(pending);
  let mcpToken = null;
  let hookToken = null;
  try {
    const [mcpPort, hookPort] = await Promise.all([
      MCP_PORT || mcpReadyResult,
      HOOK_PORT ? Promise.resolve(HOOK_PORT) : hookReadyResult,
    ]);
    if (pending.cancelled || !mainWindow || mainWindow.isDestroyed()) throw new Error('PTY creation cancelled');
    if (mcpPort && !mcpControl) throw new Error('MCP server is unavailable');
    if (mcpPort) {
      mcpToken = mcpControl.registerSession({
        ptyId: id,
        projectId: options.projectId,
        cwd: options.cwd,
      });
    }
    const mcpUrl = mcpToken ? `http://127.0.0.1:${mcpPort}/s/${mcpToken}` : null;
    const resumeArgs = buildResumeArgs(options.command, options.resumeSessionId);
    const effectiveArgs = resumeArgs ? [...resumeArgs, ...options.args] : options.args;
    const agentMcpArgs = buildAgentMcpArgs(options.command, mcpUrl);

    const isWin = os.platform() === 'win32';
    const winShells = ['pwsh', 'powershell', 'cmd', 'wsl'];
    const unixShells = ['bash', 'zsh', 'sh'];
    const commandName = options.command ? normalizeCommandName(options.command) : '';

    let shell;
    let shellArgs;
    if (!options.command) {
      shell = isWin ? 'pwsh.exe' : 'bash';
      shellArgs = effectiveArgs;
    } else if ((isWin && winShells.includes(commandName)) || (!isWin && unixShells.includes(commandName))) {
      shell = options.command;
      shellArgs = effectiveArgs;
    } else if (isWin) {
      shell = 'pwsh.exe';
      shellArgs = [
        '-NoExit',
        '-Command',
        buildPowerShellInvocation(options.command, [...effectiveArgs, ...agentMcpArgs]),
      ];
    } else {
      shell = options.command;
      shellArgs = [...effectiveArgs, ...agentMcpArgs];
    }

    hookToken = hookPort ? crypto.randomBytes(32).toString('base64url') : null;
    const opencodeEnv = mcpUrl && commandName === 'opencode'
      ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { 'project-mixer': { type: 'remote', url: mcpUrl, enabled: true } } }) }
      : {};
    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        PROJECT_MIXER_PORT_FILE: portFile,
        PROJECT_MIXER_PTY_ID: String(id),
        ...(mcpUrl ? { PM_MCP_URL: mcpUrl } : {}),
        ...(hookPort ? {
          PM_HOOK_URL: `http://127.0.0.1:${hookPort}/hook`,
          PM_HOOK_TOKEN: hookToken,
        } : {}),
        ...opencodeEnv,
      },
    });

    if (pending.cancelled || !mainWindow || mainWindow.isDestroyed()) {
      ptyProcess.kill();
      throw new Error('PTY creation cancelled');
    }
    const ptyRecord = {
      process: ptyProcess,
      cwd: options.cwd,
      command: options.command || shell,
      mcpToken,
      hookToken,
      ready: false,
      pendingData: [],
      pendingExit: null,
    };
    ptys.set(id, ptyRecord);
    if (hookToken) hookTokens.set(hookToken, id);

    ptyProcess.onData((data) => {
      const record = ptys.get(id);
      if (!record) return;
      if (!record.ready) {
        record.pendingData.push(data);
        return;
      }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:data', { id, data });
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      const record = ptys.get(id);
      if (!record) return;
      devinMonitor?.unbind(id);
      if (record.hookToken) hookTokens.delete(record.hookToken);
      void mcpControl?.revokeSession(record.mcpToken);
      if (!record.ready) {
        record.pendingExit = { exitCode, signal };
        return;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:exit', { id, exitCode, signal });
      }
      ptys.delete(id);
    });

    return id;
  } catch (error) {
    if (hookToken) hookTokens.delete(hookToken);
    if (mcpToken) await mcpControl?.revokeSession(mcpToken);
    throw error;
  } finally {
    pendingPtyCreates.delete(pending);
  }
});

ipcMain.handle('hook:test-token', (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!IS_DEV || process.env.PM_TEST_MODE !== '1') throw new Error('Hook test token access is disabled');
  if (!payload || !Number.isInteger(payload.ptyId) || payload.ptyId <= 0) throw new TypeError('PTY id is invalid');
  return ptys.get(payload.ptyId)?.hookToken || null;
});

ipcMain.handle('pty:attach', (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || !Number.isInteger(payload.id) || payload.id <= 0) throw new TypeError('PTY id is invalid');
  const record = ptys.get(payload.id);
  if (!record) return false;
  if (record.ready) return true;
  record.ready = true;
  for (const data of record.pendingData) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pty:data', { id: payload.id, data });
  }
  record.pendingData.length = 0;
  if (record.pendingExit) {
    const { exitCode, signal } = record.pendingExit;
    record.pendingExit = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { id: payload.id, exitCode, signal });
    }
    ptys.delete(payload.id);
    if (record.hookToken) hookTokens.delete(record.hookToken);
  }
  return true;
});

ipcMain.handle('pty:write', (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || !Number.isInteger(payload.id) || payload.id <= 0 || typeof payload.data !== 'string') {
    throw new TypeError('PTY write payload is invalid');
  }
  if (payload.data.length > 1024 * 1024) throw new TypeError('PTY write payload is too large');
  const p = ptys.get(payload.id);
  if (p) p.process.write(payload.data);
});

ipcMain.handle('pty:resize', (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || !Number.isInteger(payload.id) || payload.id <= 0
    || !Number.isInteger(payload.cols) || payload.cols < 1 || payload.cols > 1000
    || !Number.isInteger(payload.rows) || payload.rows < 1 || payload.rows > 1000) {
    throw new TypeError('PTY resize payload is invalid');
  }
  const p = ptys.get(payload.id);
  if (p) p.process.resize(payload.cols, payload.rows);
});

ipcMain.handle('pty:kill', (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || !Number.isInteger(payload.id) || payload.id <= 0) throw new TypeError('PTY id is invalid');
  const p = ptys.get(payload.id);
  if (p) {
    try { p.process.kill(); } catch {}
    ptys.delete(payload.id);
    devinMonitor?.unbind(payload.id);
    if (p.hookToken) hookTokens.delete(p.hookToken);
    if (p.mcpToken) void mcpControl?.revokeSession(p.mcpToken);
  }
});

ipcMain.handle('devin:bind', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || !Number.isInteger(payload.ptyId) || payload.ptyId <= 0
    || typeof payload.sessionId !== 'string' || !payload.sessionId.trim() || payload.sessionId.length > 512) {
    throw new TypeError('Devin bind payload is invalid');
  }
  const terminal = ptys.get(payload.ptyId);
  if (!terminal) return { ok: false, error: 'The terminal is no longer running.' };
  const executable = normalizeCommandName(terminal.command);
  if (executable !== 'devin') {
    return { ok: false, error: 'A Devin Cloud session can only be bound to a Devin terminal.' };
  }
  if (!devinMonitor) return { ok: false, error: 'The Devin monitor is unavailable.' };
  return devinMonitor.bind({ ptyId: payload.ptyId, sessionId: payload.sessionId });
});

ipcMain.handle('devin:unbind', (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || !Number.isInteger(payload.ptyId) || payload.ptyId <= 0) throw new TypeError('PTY id is invalid');
  return { ok: Boolean(devinMonitor?.unbind(payload.ptyId)) };
});

// Devin has no hook, so its session id can only come from the CLI's own
// index: `devin list --format json` is cwd-scoped and machine-readable.
// Runs async (never execFileSync) so a slow or hung CLI cannot freeze the
// main process, and is bounded on both time and output size.
ipcMain.handle('devin:latest-session', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload.cwd !== 'string' || !isSafeCwd(payload.cwd)) {
    throw new TypeError('devin:latest-session payload is invalid');
  }
  const cwd = resolveProjectRoot(loadProjectsConfig(), payload.cwd).target;
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('devin', ['list', '--format', 'json'], {
        cwd,
        encoding: 'utf8',
        timeout: 8000,
        maxBuffer: MAX_JSON_BYTES,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }, (err, out) => (err ? reject(err) : resolve(out)));
    });
    const { sessions, truncated } = parseDevinSessionList(stdout);
    const picked = pickDevinResumeCandidate(sessions, cwd);
    return {
      ok: true,
      candidate: picked.candidate ? {
        id: picked.candidate.id,
        title: picked.candidate.title,
        lastActivityAt: picked.candidate.lastActivityAt,
      } : null,
      count: picked.count,
      ambiguous: picked.ambiguous,
      truncated,
    };
  } catch (e) {
    // Devin CLI missing, not logged in, or timed out: the caller falls
    // back to a fresh session. Never surface as an error toast.
    return { ok: false, candidate: null, count: 0, ambiguous: false, error: String(e.message || e).slice(0, 200) };
  }
});

ipcMain.handle('window:focus', async (event) => {
  assertTrustedMainIpcEvent(event);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

ipcMain.handle('mem:get', async (event) => {
  assertTrustedMainIpcEvent(event);
  const metrics = app.getAppMetrics();
  let totalKB = 0;
  for (const m of metrics) totalKB += m.memory.workingSetSize;
  return {
    workingSetMB: Math.round(totalKB / 1024),
    ptyCount: ptys.size,
  };
});

// --- Command availability check ---

ipcMain.handle('settings:get', (event) => {
  assertTrustedMainIpcEvent(event);
  return { ...appSettings };
});

ipcMain.handle('command:check', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || !Array.isArray(payload.commands) || payload.commands.length > 100
    || payload.commands.some((cmd) => typeof cmd !== 'string' || !cmd.trim() || cmd.length > 256 || cmd.includes('\0'))) {
    throw new TypeError('command:check payload is invalid');
  }
  const result = {};
  const VERSION_FALLBACK_ALLOWED = new Set(['claude', 'codex', 'opencode']);
  for (const cmd of payload.commands) {
    try {
      const locator = os.platform() === 'win32' ? 'where.exe' : 'which';
      execFileSync(locator, [cmd], { stdio: 'ignore', timeout: 5000 });
      result[cmd] = true;
    } catch (e) {
      if (VERSION_FALLBACK_ALLOWED.has(path.basename(cmd).toLowerCase().replace(/\.(exe|cmd|bat)$/i, ''))) {
        try {
          const executable = path.basename(cmd).toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
          if (os.platform() === 'win32') {
            execFileSync('pwsh.exe', ['-NoProfile', '-Command', `& '${executable}' --version`], { stdio: 'ignore', timeout: 10000 });
          } else {
            execFileSync(executable, ['--version'], { stdio: 'ignore', timeout: 10000 });
          }
          result[cmd] = true;
          continue;
        } catch {
          result[cmd] = false;
          continue;
        }
      }
      result[cmd] = false;
    }
  }
  return result;
});

// --- Local HTTP server for hook notifications ---

function startHookServer() {
  const maxBodyBytes = 16 * 1024;
  const server = http.createServer((req, res) => {
    const boundPort = server.address()?.port;
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort || BASE_PORT}`);
    const allowedHosts = new Set([
      `127.0.0.1:${boundPort || BASE_PORT}`,
      `localhost:${boundPort || BASE_PORT}`,
    ]);
    if (!allowedHosts.has(req.headers.host) || req.headers.origin) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method !== 'POST' || requestUrl.pathname !== '/hook') {
      res.writeHead(404);
      res.end();
      return;
    }
    const token = req.headers['x-project-mixer-hook'];
    const ptyId = typeof token === 'string' ? hookTokens.get(token) : null;
    if (!ptyId || !ptys.has(ptyId)) {
      res.writeHead(401);
      res.end();
      return;
    }
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (declaredLength > maxBodyBytes) {
      res.writeHead(413);
      res.end();
      return;
    }
    let body = '';
    let bodyBytes = 0;
    let rejected = false;
    req.setTimeout(5000, () => req.destroy());
    req.on('data', (chunk) => {
      if (rejected) return;
      bodyBytes += chunk.length;
      if (bodyBytes > maxBodyBytes) {
        rejected = true;
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (rejected) return;
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON');
        return;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        res.writeHead(400);
        res.end('Invalid hook payload');
        return;
      }
      const payloadPtyId = Number(data.pty_id ?? data.ptyId);
      if (payloadPtyId !== ptyId) {
        res.writeHead(403);
        res.end();
        return;
      }
      data.pty_id = ptyId;
      handleHookNotification(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  hookServer = server;
  startHookServerWithRetry(
    server,
    BASE_PORT,
    20,
    (port) => resolveHookReady(port),
    (error) => rejectHookReady(error),
  );
}

function handleHookNotification(data) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const notification = normalizeAgentNotification(data);
  if (!notification) {
    console.warn('[hook] Ignoring unsupported agent notification');
    return;
  }
  const target = resolveNotificationTarget(notification, ptys);

  mainWindow.webContents.send('hook:notify', {
    type: notification.eventType,
    source: notification.source,
    kind: notification.kind,
    reason: notification.reason,
    title: notification.title,
    message: notification.message,
    sessionId: notification.sessionId,
    cwd: notification.cwd,
    ...target,
  });
}

function forwardAgentLifecycleEvent(notification) {
  if (!mainWindow || mainWindow.isDestroyed() || !ptys.has(notification.ptyId)) return;
  mainWindow.webContents.send('hook:notify', {
    type: notification.eventType,
    source: notification.source,
    kind: notification.kind,
    reason: notification.reason,
    title: notification.title,
    message: notification.message,
    sessionId: notification.sessionId,
    cwd: null,
    ptyId: notification.ptyId,
    ambiguous: false,
    unattributed: false,
  });
}

function forwardDevinMonitorError(error) {
  if (!mainWindow || mainWindow.isDestroyed() || !ptys.has(error.ptyId)) return;
  mainWindow.webContents.send('devin:monitor-error', error);
}

// --- Project management ---

ipcMain.handle('project:list', async (event) => {
  assertTrustedMainIpcEvent(event);
  try {
    return loadProjectsConfig();
  } catch (e) {
    if (e instanceof ConfigParseError) return [];
    throw e;
  }
});

ipcMain.handle('project:add', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload !== 'object' || typeof payload.name !== 'string'
    || !payload.name.trim() || payload.name.length > 200 || typeof payload.path !== 'string'
    || !payload.path.trim() || payload.path.length > 4096 || !path.isAbsolute(payload.path)) {
    throw new TypeError('project:add payload is invalid');
  }
  const projects = loadProjectsConfig();
  const root = resolveProjectRoot([{ id: 'candidate', path: payload.path }], payload.path).target;
  if (projects.some((project) => path.relative(canonicalProjectPath(project.path), root) === '')) {
    throw new Error('Project is already configured');
  }
  const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const next = [...projects, { id, name: payload.name.trim(), path: root }];
  saveProjectsConfig(next);
  return next;
});

ipcMain.handle('project:remove', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload.id !== 'string' || !payload.id.trim() || payload.id.length > 200) {
    throw new TypeError('project:remove payload is invalid');
  }
  const projects = loadProjectsConfig();
  saveProjectsConfig(projects.filter((project) => project.id !== payload.id));
  return projects.filter((project) => project.id !== payload.id);
});

ipcMain.handle('project:reorder', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || !Array.isArray(payload.orderedIds) || payload.orderedIds.length > 10000
    || payload.orderedIds.some((id) => typeof id !== 'string' || !id || id.length > 200)) {
    throw new TypeError('project:reorder payload is invalid');
  }
  const projects = loadProjectsConfig();
  const ids = new Set(payload.orderedIds);
  if (ids.size !== payload.orderedIds.length || ids.size !== projects.length
    || projects.some((project) => !ids.has(project.id))) {
    throw new Error('project:reorder must contain every project exactly once');
  }
  const map = new Map(projects.map((project) => [project.id, project]));
  const reordered = payload.orderedIds.map((id) => map.get(id));
  saveProjectsConfig(reordered);
  return reordered;
});

// --- File tree ---

const { isTreeIgnored } = require('./src/files/ignore-patterns.cjs');
const { buildSearchCommand, parseSearchLine, resolveSearchPath } = require('./src/files/search-command.cjs');

ipcMain.handle('fs:readDir', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload.dirPath !== 'string') throw new TypeError('fs:readDir payload is invalid');
  const projects = loadProjectsConfig();
  const start = resolveProjectPath(projects, payload.dirPath, { allowRoot: true, requireExisting: true, type: 'directory' });
  try {
    const entries = await fsp.readdir(start.target, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (isTreeIgnored(entry.name)) continue;
      try {
        const entryPath = path.join(start.requested, entry.name);
        resolveProjectPath(projects, entryPath, { allowRoot: false, requireExisting: true });
        result.push({
          name: entry.name,
          path: entryPath,
          isDirectory: entry.isDirectory(),
        });
      } catch {
        continue;
      }
    }
    result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return result;
  } catch {
    return [];
  }
});

// Phase 5 S1: Recursive tree index for filtering.
// Walks the directory tree recursively (skipping TREE_IGNORE entries)
// and returns a flat list of all files and directories with depth/parent
// information. Used by the tree filter to match files in unexpanded folders.
ipcMain.handle('fs:indexTree', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload.dirPath !== 'string') throw new TypeError('fs:indexTree payload is invalid');
  const start = Date.now();
  const projects = loadProjectsConfig();
  const startPath = resolveProjectPath(projects, payload.dirPath, { allowRoot: true, requireExisting: true, type: 'directory' });
  const files = [];
  const MAX_FILES = 50000;
  const visitedDirectories = new Set();

  async function walk(currentPath, depth, parentPath) {
    if (files.length >= MAX_FILES || visitedDirectories.has(currentPath)) return;
    visitedDirectories.add(currentPath);
    let entries;
    try {
      entries = await fsp.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    const sorted = entries.slice().sort((a, b) => {
      const aDir = a.isDirectory();
      const bDir = b.isDirectory();
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of sorted) {
      if (isTreeIgnored(entry.name)) continue;
      if (files.length >= MAX_FILES) break;
      let resolved;
      try {
        resolved = resolveProjectPath(projects, path.join(currentPath, entry.name), {
          allowRoot: false,
          requireExisting: true,
        });
      } catch {
        continue;
      }
      const isDir = fs.statSync(resolved.target).isDirectory();
      files.push({
        path: resolved.target,
        name: entry.name,
        isDirectory: isDir,
        depth,
        parentPath,
      });
      if (isDir) await walk(resolved.target, depth + 1, resolved.target);
    }
  }

  try {
    await walk(startPath.target, 0, null);
    const durationMs = Date.now() - start;
    console.log(`[fs:indexTree] ${files.length} entries indexed in ${durationMs}ms for ${startPath.target}`);
    return { files, count: files.length, durationMs, truncated: files.length >= MAX_FILES };
  } catch (e) {
    return { files: [], count: 0, durationMs: Date.now() - start, truncated: false, error: e.message };
  }
});

// ============================================================
// Phase 5 S2: Project-local text search (git grep / rg)
// ============================================================

// Check if a command is available on the system.
function checkCommandAvailable(cmd) {
  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    execFileSync(locator, [cmd], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const activeSearches = new Map();
let searchIdCounter = 0;

function finishSearch(record, payload) {
  if (!record || record.doneSent) return false;
  record.doneSent = true;
  if (activeSearches.get(record.searchId) === record) activeSearches.delete(record.searchId);
  if (!record.sender.isDestroyed()) record.sender.send('search:done', payload);
  return true;
}

function cancelSearchRecord(record) {
  if (!record || record.doneSent) return false;
  record.cancelled = true;
  try { record.process.kill(); } catch {}
  return finishSearch(record, { searchId: record.searchId, cancelled: true });
}

ipcMain.handle('search:cancel', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || !Number.isInteger(payload.searchId) || payload.searchId <= 0) {
    throw new TypeError('search:cancel payload is invalid');
  }
  const record = activeSearches.get(payload.searchId);
  if (!record || record.sender !== event.sender) return { cancelled: false };
  return { cancelled: cancelSearchRecord(record) };
});

ipcMain.handle('search:text', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload.cwd !== 'string' || typeof payload.query !== 'string'
    || !payload.query.trim() || payload.query.length > 1000
    || (payload.caseSensitive !== undefined && typeof payload.caseSensitive !== 'boolean')) {
    return { searchId: null, error: 'missing or invalid search query or cwd' };
  }
  const projects = loadProjectsConfig();
  let searchCwd;
  try {
    searchCwd = resolveProjectPath(projects, payload.cwd, { allowRoot: true, requireExisting: true, type: 'directory' }).target;
  } catch (error) {
    return { searchId: null, error: error.message };
  }

  const hasRg = checkCommandAvailable('rg');
  const hasGit = checkCommandAvailable('git');
  if (!hasRg && !hasGit) return { searchId: null, error: 'neither rg nor git is available' };

  const cmd = hasRg ? 'rg' : 'git';
  const built = buildSearchCommand(cmd, payload.query, payload.caseSensitive === true);
  if (!built) return { searchId: null, error: 'failed to build search command' };

  const searchId = ++searchIdCounter;
  const sender = event.sender;
  for (const record of activeSearches.values()) {
    if (record.sender === sender) cancelSearchRecord(record);
  }

  let proc;
  try {
    proc = spawn(built.cmd, built.args, {
      cwd: searchCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return { searchId: null, error: error.message };
  }
  const record = {
    searchId,
    process: proc,
    sender,
    cwd: searchCwd,
    cancelled: false,
    doneSent: false,
  };
  activeSearches.set(searchId, record);

  let resultCount = 0;
  let truncated = false;
  const MAX_RESULTS = 500;
  let buffer = '';
  let killed = false;
  let stderrBuffer = '';

  proc.stdout.on('data', (chunk) => {
    if (record.cancelled || record.doneSent || sender.isDestroyed()) return;
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      if (resultCount >= MAX_RESULTS) {
        truncated = true;
        killed = true;
        try { proc.kill(); } catch {}
        return;
      }
      const result = parseSearchLine(line, searchCwd);
      if (result) {
        resultCount++;
        if (!sender.isDestroyed()) sender.send('search:result', { searchId, result });
      }
    }
  });
  proc.stderr.on('data', (chunk) => {
    if (!record.cancelled && !record.doneSent) stderrBuffer += chunk.toString();
  });
  proc.on('close', (code) => {
    if (record.cancelled || record.doneSent) return;
    if (buffer && resultCount < MAX_RESULTS && !killed) {
      const result = parseSearchLine(buffer, searchCwd);
      if (result) {
        resultCount++;
        if (!sender.isDestroyed()) sender.send('search:result', { searchId, result });
      }
    }
    if (code && code !== 1 && resultCount === 0 && !killed) {
      finishSearch(record, {
        searchId,
        error: stderrBuffer.trim() || `Search process exited with code ${code}`,
        totalCount: 0,
        exitCode: code,
      });
      return;
    }
    finishSearch(record, { searchId, truncated, totalCount: resultCount, exitCode: code });
  });
  proc.on('error', (error) => {
    finishSearch(record, { searchId, error: error.message, totalCount: resultCount });
  });

  return { searchId, command: built.cmd };
});

// --- File read/write ---

const MAX_READ_FILE_BYTES = 8 * 1024 * 1024;

ipcMain.handle('fs:readFile', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload.filePath !== 'string') return { success: false, error: 'invalid file path' };
  try {
    const projects = loadProjectsConfig();
    const resolved = resolveProjectPath(projects, payload.filePath, { allowRoot: false, requireExisting: true, type: 'file' });
    const handle = await fsp.open(resolved.target, 'r');
    try {
      const stat = await handle.stat();
      if (stat.size > MAX_READ_FILE_BYTES) {
        return { success: false, code: 'FILE_TOO_LARGE', error: `File is too large to read (maximum ${MAX_READ_FILE_BYTES} bytes).` };
      }
      const sample = Buffer.alloc(Math.min(stat.size, 8192));
      if (sample.length > 0) await handle.read(sample, 0, sample.length, 0);
      if (isProbablyBinary(sample)) return { success: true, isBinary: true, content: null };
      const buffer = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      return { success: true, isBinary: false, content: buffer.toString('utf-8') };
    } finally {
      await handle.close();
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('fs:writeFile', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload.filePath !== 'string' || typeof payload.content !== 'string'
    || Buffer.byteLength(payload.content, 'utf8') > MAX_READ_FILE_BYTES) {
    return { success: false, error: 'invalid or oversized file write payload' };
  }
  try {
    const projects = loadProjectsConfig();
    const resolved = resolveProjectPath(projects, payload.filePath, { allowRoot: false, requireExisting: false });
    writeTextAtomic(resolved.target, payload.content, 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// --- Clipboard image ---

ipcMain.handle('clipboard:saveImage', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload.projectPath !== 'string') throw new TypeError('clipboard:saveImage payload is invalid');
  const projects = loadProjectsConfig();
  const projectRoot = resolveProjectRoot(projects, payload.projectPath);
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;

  const screenshotsPath = resolveProjectPath(projects, path.join(projectRoot.target, '.project-mixer', 'screenshots'), {
    allowRoot: false,
    requireExisting: false,
  });
  fs.mkdirSync(screenshotsPath.target, { recursive: true });
  const safeScreenshotsPath = resolveProjectPath(projects, screenshotsPath.target, {
    allowRoot: false,
    requireExisting: true,
    type: 'directory',
  });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filepath = path.join(safeScreenshotsPath.target, `screenshot_${timestamp}.png`);
  const finalPath = resolveProjectPath(projects, filepath, { allowRoot: false, requireExisting: false });
  fs.writeFileSync(finalPath.target, image.toPNG());
  return finalPath.target;
});

// --- Clipboard text (terminal copy) ---

ipcMain.handle('clipboard:writeText', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload.text !== 'string' || payload.text.length > 1024 * 1024) {
    throw new TypeError('clipboard:writeText payload is invalid');
  }
  clipboard.writeText(payload.text);
  return true;
});

// --- Layout persistence ---

ipcMain.handle('layout:save', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'layout')) throw new TypeError('layout:save payload is invalid');
  saveLayoutConfig(payload.layout);
  return true;
});

ipcMain.handle('layout:load', async (event) => {
  assertTrustedMainIpcEvent(event);
  return loadLayoutConfig();
});

// --- Folder dialog ---

ipcMain.handle('dialog:openFolder', async (event) => {
  assertTrustedMainIpcEvent(event);
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// --- Save dialog (for temp tab save) ---

ipcMain.handle('dialog:saveFile', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || (payload.defaultPath !== undefined && (typeof payload.defaultPath !== 'string' || payload.defaultPath.length > 4096))
    || (payload.defaultName !== undefined && (typeof payload.defaultName !== 'string' || !payload.defaultName.trim() || payload.defaultName.length > 255 || /[\\/]/.test(payload.defaultName)))) {
    throw new TypeError('dialog:saveFile payload is invalid');
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: payload.defaultPath ? path.join(payload.defaultPath, payload.defaultName || 'untitled.txt') : payload.defaultName,
    filters: [{ name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

// --- Open file in OS default app ---

ipcMain.handle('shell:openPath', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload.filePath !== 'string' || !payload.filePath.trim()) throw new TypeError('shell:openPath payload is invalid');
  if (/^https?:\/\//i.test(payload.filePath)) {
    let url;
    try { url = new URL(payload.filePath); } catch { throw new TypeError('Invalid URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Unsupported URL protocol');
    await shell.openExternal(url.href);
    return { success: true, error: null };
  }
  const projects = loadProjectsConfig();
  const resolved = resolveProjectPath(projects, payload.filePath, { allowRoot: false, requireExisting: true });
  const errorMsg = await shell.openPath(resolved.target);
  return { success: !errorMsg, error: errorMsg || null };
});

// --- Delete file ---

ipcMain.handle('fs:deleteFile', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload.filePath !== 'string') return { success: false, error: 'invalid file path' };
  try {
    const projects = loadProjectsConfig();
    const resolved = resolveProjectPath(projects, payload.filePath, { allowRoot: false, requireExisting: true });
    const stat = await fsp.lstat(resolved.requested);
    if (stat.isDirectory() && !stat.isSymbolicLink()) await fsp.rm(resolved.requested, { recursive: true });
    else await fsp.unlink(resolved.requested);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// --- Create file ---

ipcMain.handle('fs:createFile', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload.filePath !== 'string') return { success: false, error: 'invalid file path' };
  try {
    const projects = loadProjectsConfig();
    const resolved = resolveProjectPath(projects, payload.filePath, { allowRoot: false, requireExisting: false });
    try {
      fs.lstatSync(resolved.requested);
      return { success: false, error: 'File already exists' };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
    writeTextAtomic(resolved.target, '', 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// --- Create directory ---

ipcMain.handle('fs:createDir', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload.dirPath !== 'string') return { success: false, error: 'invalid directory path' };
  try {
    const projects = loadProjectsConfig();
    const resolved = resolveProjectPath(projects, payload.dirPath, { allowRoot: false, requireExisting: false });
    try {
      fs.lstatSync(resolved.requested);
      return { success: false, error: 'Directory already exists' };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
    await fsp.mkdir(resolved.target);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// --- Hook config auto-generation ---

// Hook script uses the PM_HOOK_URL inherited from the PTY that Claude Code
// runs in. A shared port.json cannot identify the owning PM instance.
const HOOK_SCRIPT = `#!/usr/bin/env node
// Project Mixer hook - sends notification to local HTTP server
const http = require('http');

const hookUrl = process.env.PM_HOOK_URL;
const hookToken = process.env.PM_HOOK_TOKEN;
if (!hookUrl) { process.exit(0); }
if (!hookToken) { process.exit(0); }
let target;
try {
  target = new URL(hookUrl);
} catch (e) {
  process.exit(0);
}

const arg = process.argv[2] || '';
const namedEvent = arg && !arg.startsWith('{');
let argPayload = null;
if (arg.startsWith('{')) {
  try { argPayload = JSON.parse(arg); } catch (e) {}
}

function send(input = {}) {
  const notification = {
    ...input,
    cwd: input.cwd || process.cwd(),
    pty_id: Number(process.env.PROJECT_MIXER_PTY_ID) || undefined,
    agent_source: input.agent_source || (namedEvent ? 'claude' : 'codex'),
  };
  if (!notification.hook_event_type && !notification.hook_event_name && !notification.event && !notification.type) {
    notification.hook_event_type = arg || 'Notification';
  }
  const payload = JSON.stringify(notification);
  const req = http.request({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Project-Mixer-Hook': hookToken,
    },
  }, () => { process.stdout.write('{}\\n'); process.exit(0); });
  req.on('error', () => { process.exit(0); });
  req.write(payload);
  req.end();
}

if (argPayload) {
  send(argPayload);
} else {
  let stdin = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => { stdin += chunk; });
  process.stdin.on('end', () => {
    let input = {};
    if (stdin.trim()) {
      try { input = JSON.parse(stdin); } catch (e) {}
    }
    send(input);
  });
  process.stdin.resume();
}
`;

ipcMain.handle('hook:setup', async (event, payload) => {
  assertTrustedMainIpcEvent(event);
  if (!payload || typeof payload.projectPath !== 'string' || !payload.projectPath.trim()) {
    throw new TypeError('hook:setup payload is invalid');
  }
  const projects = loadProjectsConfig();
  const projectRoot = resolveProjectRoot(projects, payload.projectPath).target;
  const results = [];
  const ensureProjectDirectory = (relativePath) => {
    const candidate = resolveProjectPath(projects, path.join(projectRoot, relativePath), {
      allowRoot: false,
      requireExisting: false,
    });
    fs.mkdirSync(candidate.target, { recursive: true });
    return resolveProjectPath(projects, candidate.target, {
      allowRoot: false,
      requireExisting: true,
      type: 'directory',
    }).target;
  };
  const resolveProjectChild = (relativePath, requireExisting) => resolveProjectPath(
    projects,
    path.join(projectRoot, relativePath),
    { allowRoot: false, requireExisting },
  ).target;

  const claudeDir = ensureProjectDirectory('.claude');
  const claudeSettings = resolveProjectChild(path.join('.claude', 'settings.local.json'), false);
  const hookScriptPath = resolveProjectChild(path.join('.claude', 'project-mixer-hook.cjs'), false);

  try {
    writeTextAtomic(hookScriptPath, HOOK_SCRIPT, 'utf-8');
    let settings = {};
    if (fs.existsSync(claudeSettings)) {
      try {
        settings = JSON.parse(fs.readFileSync(claudeSettings, 'utf-8'));
      } catch (e) {
        throw new Error(`Cannot parse ${claudeSettings}: ${e.message}`);
      }
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(`${claudeSettings} must contain a JSON object`);
    }
    if (settings.hooks === undefined) settings.hooks = {};
    if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
      throw new Error(`${claudeSettings}: hooks must be a JSON object`);
    }
    const escapedScriptPath = os.platform() === 'win32'
      ? hookScriptPath.replace(/\\/g, '\\\\')
      : hookScriptPath;
    const hookCmd = `node "${escapedScriptPath}"`;
    const hookMatchPath = os.platform() === 'win32' ? escapedScriptPath : hookScriptPath;
    for (const key of ['Notification', 'Stop']) {
      const pmHookEntry = { type: 'command', command: `${hookCmd} ${key}` };
      settings.hooks[key] = upsertProjectMixerHook(settings.hooks[key], pmHookEntry, hookMatchPath);
    }
    writeTextAtomic(claudeSettings, JSON.stringify(settings, null, 2), 'utf-8');
    results.push({ tool: 'claude', success: true, path: claudeSettings });
  } catch (e) {
    results.push({ tool: 'claude', success: false, error: e.message });
  }

  // Codex: install the notify bridge ONLY when `notify` is unset. Codex
  // accepts a single program there, so overwriting an existing one (the
  // Codex Desktop computer-use integration uses it) would break that
  // feature. Report the conflict instead of touching the file.
  try {
    const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml');
    const existingToml = fs.existsSync(codexConfigPath)
      ? fs.readFileSync(codexConfigPath, 'utf-8')
      : null;
    const codexDir = path.dirname(codexConfigPath);
    fs.mkdirSync(codexDir, { recursive: true });
    const wrapperPath = path.join(codexDir, 'project-mixer-notify.cjs');
    const plan = planCodexNotifyInstall({ existingToml, wrapperPath });
    if (plan.action === 'skip') {
      results.push({ tool: 'codex', success: true, skipped: true, note: plan.note, existing: plan.existing });
    } else {
      writeTextAtomic(wrapperPath, CODEX_WRAPPER_SOURCE, 'utf-8');
      writeTextAtomic(codexConfigPath, plan.toml, 'utf-8');
      results.push({ tool: 'codex', success: true, path: codexConfigPath });
    }
  } catch (e) {
    results.push({ tool: 'codex', success: false, error: e.message });
  }

  try {
    const opencodePluginDir = ensureProjectDirectory(path.join('.opencode', 'plugins'));
    const opencodePluginPath = resolveProjectChild(path.join('.opencode', 'plugins', 'project-mixer.js'), false);
    writeTextAtomic(opencodePluginPath, OPENCODE_PLUGIN_SOURCE, 'utf-8');
    results.push({ tool: 'opencode', success: true, path: opencodePluginPath });
  } catch (e) {
    results.push({ tool: 'opencode', success: false, error: e.message });
  }

  return results;
});
