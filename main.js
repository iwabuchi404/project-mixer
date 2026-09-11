const { app, BrowserWindow, ipcMain, clipboard, dialog, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const pty = require('node-pty');
const { execSync, spawn } = require('child_process');
const { upsertProjectMixerHook } = require('./hook-settings.cjs');
const { PLUGIN_SOURCE: OPENCODE_PLUGIN_SOURCE } = require('./src/main/opencode-plugin-source.cjs');
const { startMcpServer } = require('./src/mcp/server.cjs');
const { buildAgentMcpArgs, buildPowerShellInvocation } = require('./src/mcp/launch.cjs');
const { buildResumeArgs } = require('./src/main/resume-args.cjs');
const { buildPortRecord, writeJsonAtomic } = require('./src/ports/state.cjs');
const { isProbablyBinary } = require('./src/files/content.cjs');
const { readConfig, writeConfig, validateProjects, validateLayout, ConfigParseError } = require('./src/main/config-service.cjs');
const { normalizeAgentNotification, resolveNotificationTarget } = require('./src/main/agent-notification-service.cjs');
const { DevinSessionMonitor } = require('./src/main/devin-session-monitor.cjs');

// --- Profile separation (Phase 0.1) ---
// --dev flag or PM_PROFILE env var selects a separate userData directory
const IS_DEV = process.argv.includes('--dev') || process.env.PM_PROFILE === 'dev';
const PROFILE = IS_DEV ? 'dev' : 'default';

if (IS_DEV) {
  const defaultUserData = app.getPath('userData');
  app.setPath('userData', path.join(path.dirname(defaultUserData), 'Project Mixer Dev'));
}

let mainWindow;
let applicationMenu;
const ptys = new Map(); // id -> { process, cwd, command }
let ptyCounter = 0;

// --- Port separation (Phase 0.2) ---
// Base port differs by profile; actual port is auto-selected and written to a file
const BASE_PORT = IS_DEV ? 47842 : 47832;
const MCP_BASE_PORT = IS_DEV ? 47852 : 47822;
let HOOK_PORT = null; // set only after the hook server is listening
let MCP_PORT = null; // set only after the MCP server is listening
let mcpControl = null;
let devinMonitor = null;
let resolveMcpReady;
const mcpReady = new Promise((resolve) => { resolveMcpReady = resolve; });

const configDir = path.join(app.getPath('userData'), 'project-mixer');
const projectsFile = path.join(configDir, 'projects.json');
const layoutFile = path.join(configDir, 'layout.json');
const portFile = path.join(configDir, 'port.json');
const settingsFile = path.join(configDir, 'settings.json');
// Session-resume mode: 'ask' shows the confirm modal per new agent tab;
// 'auto' resumes silently when a previous session is known.
let appSettings = { resumeMode: 'ask' };
function loadAppSettings() {
  try {
    const data = readConfig(settingsFile, { resumeMode: 'ask' });
    if (data && typeof data === 'object' && (data.resumeMode === 'ask' || data.resumeMode === 'auto')) {
      appSettings = data;
    }
  } catch (e) {
    console.warn(`[Project Mixer] ${e.message}; using default settings`);
  }
}
function saveAppSettings() {
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
      console.error(`[config] layout.json invalid: ${validation.message}`);
      return null;
    }
    return validation.value;
  } catch (e) {
    // A corrupt layout is non-fatal — log and use null rather than blocking
    // startup. The user can still work; layout resets to defaults.
    if (e instanceof ConfigParseError) {
      console.error(`[config] ${e.message} — continuing with default layout`);
      return null;
    }
    throw e;
  }
}

function saveProjectsConfig(projects) {
  ensureConfigDir();
  writeConfig(projectsFile, projects);
}

function saveLayoutConfig(layout) {
  ensureConfigDir();
  writeConfig(layoutFile, layout);
}

// --- Port discovery (Phase 0.2) ---
// The actual hook server retries binding; port.json is written only after
// successful listen, eliminating the race between test-bind and real-bind.
function startHookServerWithRetry(server, port, maxRetries, onReady) {
  server.listen(port, '127.0.0.1');
  server.on('error', function onError(e) {
    if (e.code === 'EADDRINUSE' && port - BASE_PORT < maxRetries) {
      port++;
      server.listen(port, '127.0.0.1');
    } else if (e.code === 'EADDRINUSE') {
      console.error(`[Project Mixer] Hook server: no available port after ${maxRetries} retries from ${BASE_PORT}.`);
    } else {
      console.error('Hook server error:', e);
    }
  });
  server.on('listening', () => {
    HOOK_PORT = server.address().port;
    console.log(`[Project Mixer] Profile: ${PROFILE}, Hook port: ${HOOK_PORT}`);
    savePortJson();
    if (onReady) onReady();
  });
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

  mainWindow.loadFile('index.html');
  setupApplicationMenu();

  // Kill all active search processes when the window is closed.
  mainWindow.on('closed', () => {
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

ipcMain.handle('menu:popup', (event, { x, y } = {}) => {
  const ownerWindow = BrowserWindow.fromWebContents(event.sender);
  if (!applicationMenu || !ownerWindow || ownerWindow.isDestroyed()) return false;
  return new Promise((resolve) => {
    const options = {
      window: ownerWindow,
      callback: () => resolve(true),
    };
    if (Number.isFinite(x)) options.x = Math.round(x);
    if (Number.isFinite(y)) options.y = Math.round(y);
    applicationMenu.popup(options);
  });
});

app.whenReady().then(() => {
  // Windows toast notifications require an AppUserModelID so the notification
  // shows the correct app name and icon. Without this, Windows falls back to
  // a generic "Electron" label. Must be set before any Notification is shown.
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.projectmixer.app');
    }

    loadAppSettings();


  // R4: startup guard — if projects.json is corrupt, stop startup and show
  // an error dialog instead of overwriting the corrupt file with defaults.
  // Per R1 decision #2, the app does not start in a read-only mode.
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
  devinMonitor = new DevinSessionMonitor({
    token: process.env.DEVIN_API_TOKEN,
    orgId: process.env.DEVIN_ORG_ID,
    baseUrl: process.env.DEVIN_API_BASE_URL,
    onLifecycleEvent: forwardAgentLifecycleEvent,
    onError: forwardDevinMonitorError,
  });
  startHookServer();
  // Start MCP server (Phase 1.3) — port written to port.json for discovery
  mcpControl = startMcpServer(MCP_BASE_PORT, async (commandName, args = {}, sessionContext = null) => {
    // Dispatch commands to the renderer via executeJavaScript
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { error: 'no window' };
    }
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
    // MCP is optional for local editing. A bind failure must not prevent the
    // terminal itself from opening.
    resolveMcpReady(null);
  });
});

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

app.on('window-all-closed', () => {
  ptys.forEach((p) => {
    p.process.kill();
    if (p.mcpToken) void mcpControl?.revokeSession(p.mcpToken);
  });
  ptys.clear();
  devinMonitor?.dispose();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('pty:create', async (event, { command, args, cwd, projectId, cols, rows, resumeSessionId }) => {
  const id = ++ptyCounter;
  const shellCwd = cwd || os.homedir();
  const mcpPort = MCP_PORT || await mcpReady;
  const mcpToken = mcpPort ? mcpControl.registerSession({
      ptyId: id,
      projectId: projectId || null,
      cwd: shellCwd,
    }) : null;
  const mcpUrl = mcpToken ? `http://127.0.0.1:${mcpPort}/s/${mcpToken}` : null;
  const requestedArgs = args || [];
  // Resume-previous-session: prepend the agent's resume flags before
  // user-supplied args (they compose with the MCP injection args).
  const resumeArgs = buildResumeArgs(command, resumeSessionId);
  const effectiveArgs = resumeArgs ? [...resumeArgs, ...requestedArgs] : requestedArgs;
  const agentMcpArgs = buildAgentMcpArgs(command, mcpUrl);

  const isWin = os.platform() === 'win32';
  const winShells = ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'wsl.exe'];
  const unixShells = ['bash', 'zsh', 'sh'];

  let shell, shellArgs;
  if (!command) {
    shell = isWin ? 'pwsh.exe' : 'bash';
    shellArgs = effectiveArgs;
  } else if (isWin && winShells.includes(command)) {
    shell = command;
    shellArgs = effectiveArgs;
  } else if (!isWin && unixShells.includes(command)) {
    shell = command;
    shellArgs = effectiveArgs;
  } else {
    // claude, codex, etc. — wrap in pwsh -NoExit -Command on Windows
    if (isWin) {
      shell = 'pwsh.exe';
      shellArgs = [
        '-NoExit',
        '-Command',
        buildPowerShellInvocation(command, [...effectiveArgs, ...agentMcpArgs]),
      ];
    } else {
      shell = command;
      shellArgs = [...effectiveArgs, ...agentMcpArgs];
    }
  }

  let ptyProcess;
  try {
    // OpenCode uses OPENCODE_CONFIG_CONTENT env var for runtime config overrides
    // (not CLI args). Inject MCP server config so OpenCode discovers the session.
    const opencodeEnv = (mcpUrl && command === 'opencode')
      ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { 'project-mixer': { type: 'remote', url: mcpUrl, enabled: true } } }) }
      : {};
    ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 30,
      cwd: shellCwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        PROJECT_MIXER_PORT_FILE: portFile,
        PROJECT_MIXER_PTY_ID: String(id),
        // 3.5: inject a per-PTY MCP URL so agents discover only their session.
        ...(mcpUrl ? { PM_MCP_URL: mcpUrl } : {}),
        // OpenCode plugin bridge: POST /hook target for lifecycle events
        // (session.status idle -> stop, permission.asked, question.asked).
        ...(HOOK_PORT ? { PM_HOOK_URL: `http://127.0.0.1:${HOOK_PORT}/hook` } : {}),
        ...opencodeEnv,
      },
    });
  } catch (error) {
    if (mcpToken) await mcpControl.revokeSession(mcpToken);
    throw error;
  }

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:data', { id, data });
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pty:exit', { id, exitCode, signal });
    }
    ptys.delete(id);
    devinMonitor?.unbind(id);
    void mcpControl?.revokeSession(mcpToken);
  });

  ptys.set(id, { process: ptyProcess, cwd: shellCwd, command: command || shell, mcpToken });
  return id;
});

ipcMain.handle('pty:write', (event, { id, data }) => {
  const p = ptys.get(id);
  if (p) p.process.write(data);
});

ipcMain.handle('pty:resize', (event, { id, cols, rows }) => {
  const p = ptys.get(id);
  if (p) p.process.resize(cols, rows);
});

ipcMain.handle('pty:kill', (event, { id }) => {
  const p = ptys.get(id);
  if (p) {
    p.process.kill();
    ptys.delete(id);
    devinMonitor?.unbind(id);
    if (p.mcpToken) void mcpControl?.revokeSession(p.mcpToken);
  }
});

ipcMain.handle('devin:bind', async (event, { ptyId, sessionId }) => {
  const terminal = ptys.get(ptyId);
  if (!terminal) return { ok: false, error: 'The terminal is no longer running.' };
  const executable = path.basename(String(terminal.command || '')).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (executable !== 'devin') {
    return { ok: false, error: 'A Devin Cloud session can only be bound to a Devin terminal.' };
  }
  if (!devinMonitor) return { ok: false, error: 'The Devin monitor is unavailable.' };
  return devinMonitor.bind({ ptyId, sessionId });
});

ipcMain.handle('devin:unbind', (event, { ptyId }) => ({
  ok: Boolean(devinMonitor?.unbind(ptyId)),
}));

ipcMain.handle('window:focus', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

ipcMain.handle('mem:get', async () => {
  const metrics = app.getAppMetrics();
  let totalKB = 0;
  for (const m of metrics) {
    totalKB += m.memory.workingSetSize;
  }
  return {
    workingSetMB: Math.round(totalKB / 1024),
    ptyCount: ptys.size,
  };
});

// --- Command availability check ---

ipcMain.handle('settings:get', () => ({ ...appSettings }));

ipcMain.handle('command:check', async (event, { commands }) => {  const result = {};
  // The --version fallback is restricted to known agent commands that may
  // be installed as shell functions or aliases not discoverable by where/which.
  // Allowing arbitrary commands here would let hook data execute any binary.
  const VERSION_FALLBACK_ALLOWED = new Set(['claude', 'codex', 'opencode']);
  for (const cmd of commands) {
    try {
      if (os.platform() === 'win32') {
        execSync(`where ${cmd}`, { stdio: 'ignore', timeout: 5000 });
      } else {
        execSync(`which ${cmd}`, { stdio: 'ignore', timeout: 5000 });
      }
      result[cmd] = true;
    } catch (e) {
      // Fallback: try running the command with --version, but only for
      // known agent commands (claude, codex) that may be shell functions.
      if (VERSION_FALLBACK_ALLOWED.has(cmd)) {
        try {
          if (os.platform() === 'win32') {
            execSync(`pwsh.exe -NoProfile -Command "${cmd} --version"`, { stdio: 'ignore', timeout: 10000 });
          } else {
            execSync(`${cmd} --version`, { stdio: 'ignore', timeout: 10000 });
          }
          result[cmd] = true;
          continue;
        } catch (e2) {
          // fall through to false
        }
      }
      result[cmd] = false;
    }
  }
  return result;
});

// --- Local HTTP server for hook notifications ---

function startHookServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        handleHookNotification(data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
  });
  startHookServerWithRetry(server, BASE_PORT, 20);
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

ipcMain.handle('project:list', async () => {
  try {
    return loadProjectsConfig();
  } catch (e) {
    // R4: corrupt projects.json — return empty rather than crashing the
    // renderer. The startup guard below prevents reaching here on launch.
    return [];
  }
});

ipcMain.handle('project:add', async (event, { name, path: projPath }) => {
  const projects = loadProjectsConfig();
  const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  projects.push({ id, name, path: projPath });
  saveProjectsConfig(projects);
  return projects;
});

ipcMain.handle('project:remove', async (event, { id }) => {
  let projects = loadProjectsConfig();
  projects = projects.filter(p => p.id !== id);
  saveProjectsConfig(projects);
  return projects;
});

ipcMain.handle('project:reorder', async (event, { orderedIds }) => {
  let projects = loadProjectsConfig();
  const map = new Map(projects.map(p => [p.id, p]));
  const reordered = orderedIds
    .map(id => map.get(id))
    .filter(Boolean);
  // Append any projects not in orderedIds (defensive)
  for (const p of projects) {
    if (!orderedIds.includes(p.id)) reordered.push(p);
  }
  saveProjectsConfig(reordered);
  return reordered;
});

// --- File tree ---

const { isTreeIgnored } = require('./src/files/ignore-patterns.cjs');
const { buildSearchCommand, parseSearchLine, resolveSearchPath } = require('./src/files/search-command.cjs');

ipcMain.handle('fs:readDir', async (event, { dirPath }) => {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (isTreeIgnored(entry.name)) continue;
      result.push({
        name: entry.name,
        path: path.join(dirPath, entry.name),
        isDirectory: entry.isDirectory(),
      });
    }
    result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return result;
  } catch (e) {
    return [];
  }
});

// Phase 5 S1: Recursive tree index for filtering.
// Walks the directory tree recursively (skipping TREE_IGNORE entries)
// and returns a flat list of all files and directories with depth/parent
// information. Used by the tree filter to match files in unexpanded folders.
ipcMain.handle('fs:indexTree', async (event, { dirPath }) => {
  const start = Date.now();
  const files = [];
  const MAX_FILES = 50000;

  async function walk(currentPath, depth, parentPath) {
    if (files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fsp.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort: directories first, then alphabetical.
    const sorted = entries.slice().sort((a, b) => {
      const aDir = a.isDirectory();
      const bDir = b.isDirectory();
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of sorted) {
      if (isTreeIgnored(entry.name)) continue;
      if (files.length >= MAX_FILES) break;
      const entryPath = path.join(currentPath, entry.name);
      const isDir = entry.isDirectory();
      files.push({
        path: entryPath,
        name: entry.name,
        isDirectory: isDir,
        depth,
        parentPath,
      });
      if (isDir) {
        await walk(entryPath, depth + 1, entryPath);
      }
    }
  }

  try {
    await walk(dirPath, 0, null);
    const durationMs = Date.now() - start;
    console.log(`[fs:indexTree] ${files.length} entries indexed in ${durationMs}ms for ${dirPath}`);
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
    if (process.platform === 'win32') {
      execSync(`where ${cmd}`, { stdio: 'ignore', timeout: 5000 });
    } else {
      execSync(`which ${cmd}`, { stdio: 'ignore', timeout: 5000 });
    }
    return true;
  } catch {
    return false;
  }
}

// Active search processes, keyed by searchId. Used to cancel stale searches.
const activeSearches = new Map();
let searchIdCounter = 0;

// Cancel an in-flight search by searchId. Kills the process and sends
// search:done with cancelled: true.
ipcMain.handle('search:cancel', async (event, { searchId }) => {
  const proc = activeSearches.get(searchId);
  if (!proc) return { cancelled: false };
  try { proc.process.kill(); } catch {}
  activeSearches.delete(searchId);
  if (!proc.sender.isDestroyed()) {
    proc.sender.send('search:done', { searchId, cancelled: true });
  }
  return { cancelled: true };
});

ipcMain.handle('search:text', async (event, { cwd, query, caseSensitive = false }) => {
  if (!query || !cwd) {
    return { searchId: null, error: 'missing query or cwd' };
  }

  // Determine which search tool to use.
  const hasRg = checkCommandAvailable('rg');
  const hasGit = checkCommandAvailable('git');
  if (!hasRg && !hasGit) {
    return { searchId: null, error: 'neither rg nor git is available' };
  }

  const cmd = hasRg ? 'rg' : 'git';
  const built = buildSearchCommand(cmd, query, caseSensitive);
  if (!built) {
    return { searchId: null, error: 'failed to build search command' };
  }

  const searchId = ++searchIdCounter;
  const sender = event.sender;

  // Cancel any previous active search from this sender.
  for (const [id, proc] of activeSearches.entries()) {
    if (proc.sender === sender) {
      try { proc.process.kill(); } catch {}
      activeSearches.delete(id);
      if (!proc.sender.isDestroyed()) {
        proc.sender.send('search:done', { searchId: id, cancelled: true });
      }
    }
  }

  const proc = spawn(built.cmd, built.args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  activeSearches.set(searchId, { process: proc, sender });

  let resultCount = 0;
  let truncated = false;
  const MAX_RESULTS = 500;
  let buffer = '';
  let killed = false;

  proc.stdout.on('data', (chunk) => {
    if (sender.isDestroyed()) return;
    if (killed) return; // discard output after kill
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line) continue;
      if (resultCount >= MAX_RESULTS) {
        truncated = true;
        // Kill the process to stop CPU/I/O on large repos.
        killed = true;
        try { proc.kill(); } catch {}
        return;
      }
      const result = parseSearchLine(line, cwd);
      if (result) {
        resultCount++;
        sender.send('search:result', { searchId, result });
      }
    }
  });

  let stderrBuffer = '';
  proc.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
  });

  proc.on('close', (code) => {
    activeSearches.delete(searchId);
    if (sender.isDestroyed()) return;
    // Process any remaining buffer.
    if (buffer && resultCount < MAX_RESULTS && !killed) {
      const result = parseSearchLine(buffer, cwd);
      if (result) {
        resultCount++;
        sender.send('search:result', { searchId, result });
      }
    }
    // Non-zero exit code with no results indicates an error (e.g. git grep
    // in a non-Git directory returns 128, rg not found returns 127).
    // Exit code 1 for rg/git grep means "no matches" which is not an error.
    // Exit code 2 for rg means "invalid arguments" (shouldn't happen with -F).
    if (code && code !== 1 && resultCount === 0 && !killed) {
      const errMsg = stderrBuffer.trim() || `Search process exited with code ${code}`;
      sender.send('search:done', { searchId, error: errMsg, totalCount: 0, exitCode: code });
      return;
    }
    sender.send('search:done', { searchId, truncated, totalCount: resultCount, exitCode: code });
  });

  proc.on('error', (err) => {
    activeSearches.delete(searchId);
    if (sender.isDestroyed()) return;
    sender.send('search:done', { searchId, error: err.message, totalCount: resultCount });
  });

  return { searchId, command: built.cmd };
});

// --- File read/write ---

ipcMain.handle('fs:readFile', async (event, { filePath }) => {
  try {
    const buffer = await fsp.readFile(filePath);
    if (isProbablyBinary(buffer)) {
      return { success: true, isBinary: true, content: null };
    }
    return { success: true, isBinary: false, content: buffer.toString('utf-8') };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('fs:writeFile', async (event, { filePath, content }) => {
  try {
    await fsp.writeFile(filePath, content, 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// --- Clipboard image ---

ipcMain.handle('clipboard:saveImage', async (event, { projectPath }) => {
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;

  const screenshotsDir = path.join(projectPath, '.project-mixer', 'screenshots');
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `screenshot_${timestamp}.png`;
  const filepath = path.join(screenshotsDir, filename);

  const pngBuffer = image.toPNG();
  fs.writeFileSync(filepath, pngBuffer);

  return filepath;
});

// --- Clipboard text (terminal copy) ---

ipcMain.handle('clipboard:writeText', async (event, { text }) => {
  clipboard.writeText(text);
  return true;
});

// --- Layout persistence ---

ipcMain.handle('layout:save', async (event, { layout }) => {
  saveLayoutConfig(layout);
  return true;
});

ipcMain.handle('layout:load', async () => {
  return loadLayoutConfig();
});

// --- Folder dialog ---

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// --- Save dialog (for temp tab save) ---

ipcMain.handle('dialog:saveFile', async (event, { defaultPath, defaultName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultPath ? path.join(defaultPath, defaultName || 'untitled.txt') : defaultName,
    filters: [{ name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

// --- Open file in OS default app ---

ipcMain.handle('shell:openPath', async (event, { filePath }) => {
  // URLの場合は openExternal、ファイルパスの場合は openPath
  if (/^https?:\/\//i.test(filePath)) {
    await shell.openExternal(filePath);
    return { success: true, error: null };
  }
  const errorMsg = await shell.openPath(filePath);
  return { success: !errorMsg, error: errorMsg || null };
});

// --- Delete file ---

ipcMain.handle('fs:deleteFile', async (event, { filePath }) => {
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      await fsp.rm(filePath, { recursive: true });
    } else {
      await fsp.unlink(filePath);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// --- Create file ---

ipcMain.handle('fs:createFile', async (event, { filePath }) => {
  try {
    if (fs.existsSync(filePath)) return { success: false, error: 'File already exists' };
    await fsp.writeFile(filePath, '', 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// --- Create directory ---

ipcMain.handle('fs:createDir', async (event, { dirPath }) => {
  try {
    if (fs.existsSync(dirPath)) return { success: false, error: 'Directory already exists' };
    await fsp.mkdir(dirPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// --- Hook config auto-generation ---

// Hook script reads the port from PROJECT_MIXER_PORT_FILE env var (inherited
// from the PTY that Claude Code runs in). The old fallback that scanned
// userData directories for port.json was removed in R1 — it could deliver
// notifications to the wrong PM instance when dev and installed profiles
// share a project. Each PTY must use the env var set by its spawning PM.
const HOOK_SCRIPT = `#!/usr/bin/env node
// Project Mixer hook - sends notification to local HTTP server
// Port is discovered via PROJECT_MIXER_PORT_FILE env var (set by PM's PTY).
const http = require('http');
const fs = require('fs');

const portFile = process.env.PROJECT_MIXER_PORT_FILE;
if (!portFile) { process.exit(0); }

let port = null;
try {
  const data = JSON.parse(fs.readFileSync(portFile, 'utf-8'));
  port = data.port;
} catch (e) {}

if (!port) { process.exit(0); }

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
    hostname: '127.0.0.1',
    port: port,
    path: '/hook',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
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

ipcMain.handle('hook:setup', async (event, { projectPath }) => {
  const results = [];

  // Claude Code: .claude/settings.local.json (gitignore target, won't conflict with shared settings.json)
  const claudeDir = path.join(projectPath, '.claude');
  const claudeSettings = path.join(claudeDir, 'settings.local.json');
  const hookScriptPath = path.join(claudeDir, 'project-mixer-hook.cjs');

  try {
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

    // Write hook script (content is the same regardless of profile — port is
    // resolved at runtime via env var, so both profiles can share this file)
    fs.writeFileSync(hookScriptPath, HOOK_SCRIPT, 'utf-8');

    // Read existing settings.local.json or create new. Never replace a file
    // that cannot be parsed, because it may contain user-managed hooks.
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

    // Escape backslashes for Windows paths; Unix paths need no escaping
    const escapedScriptPath = os.platform() === 'win32'
      ? hookScriptPath.replace(/\\/g, '\\\\')
      : hookScriptPath;
    const hookCmd = `node "${escapedScriptPath}"`;

    // Add one independent PM entry for each event. Remove only previous PM
    // hook commands; preserve any user hooks that share the same matcher.
    for (const key of ['Notification', 'Stop']) {
      const pmHookEntry = { type: 'command', command: `${hookCmd} ${key}` };
      settings.hooks[key] = upsertProjectMixerHook(settings.hooks[key], pmHookEntry);
    }

    fs.writeFileSync(claudeSettings, JSON.stringify(settings, null, 2), 'utf-8');
    results.push({ tool: 'claude', success: true, path: claudeSettings });
  } catch (e) {
    results.push({ tool: 'claude', success: false, error: e.message });
  }

  // Codex supports user-level notify commands and trusted project hooks.
  // Do not rewrite either automatically: changing notify would replace the
  // user's command, while project hooks require an explicit trust review.
  results.push({ tool: 'codex', success: true, note: 'Ready for Codex notify or trusted project hooks' });

  // OpenCode: install the notification bridge plugin into the project.
  // The plugin is inert unless the PTY env provides PM_HOOK_URL (injected at
  // terminal creation), so writing it is side-effect free for other setups.
  const opencodePluginDir = path.join(projectPath, '.opencode', 'plugins');
  const opencodePluginPath = path.join(opencodePluginDir, 'project-mixer.js');
  try {
    if (!fs.existsSync(opencodePluginDir)) fs.mkdirSync(opencodePluginDir, { recursive: true });
    fs.writeFileSync(opencodePluginPath, OPENCODE_PLUGIN_SOURCE, 'utf-8');
    results.push({ tool: 'opencode', success: true, path: opencodePluginPath });
  } catch (e) {
    results.push({ tool: 'opencode', success: false, error: e.message });
  }

  return results;
});
