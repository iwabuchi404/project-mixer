const { app, BrowserWindow, ipcMain, clipboard, dialog, shell, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const pty = require('node-pty');
const { execSync } = require('child_process');
const { upsertProjectMixerHook } = require('./hook-settings.cjs');
const { startMcpServer } = require('./src/mcp/server.cjs');
const { buildAgentMcpArgs, buildPowerShellInvocation } = require('./src/mcp/launch.cjs');
const { buildPortRecord, writeJsonAtomic } = require('./src/ports/state.cjs');
const { isProbablyBinary } = require('./src/files/content.cjs');

// --- Profile separation (Phase 0.1) ---
// --dev flag or PM_PROFILE env var selects a separate userData directory
const IS_DEV = process.argv.includes('--dev') || process.env.PM_PROFILE === 'dev';
const PROFILE = IS_DEV ? 'dev' : 'default';

if (IS_DEV) {
  const defaultUserData = app.getPath('userData');
  app.setPath('userData', path.join(path.dirname(defaultUserData), 'Project Mixer Dev'));
}

let mainWindow;
const ptys = new Map(); // id -> { process, cwd, command }
let ptyCounter = 0;

// --- Port separation (Phase 0.2) ---
// Base port differs by profile; actual port is auto-selected and written to a file
const BASE_PORT = IS_DEV ? 47842 : 47832;
const MCP_BASE_PORT = IS_DEV ? 47852 : 47822;
let HOOK_PORT = null; // set only after the hook server is listening
let MCP_PORT = null; // set only after the MCP server is listening
let mcpControl = null;
let resolveMcpReady;
const mcpReady = new Promise((resolve) => { resolveMcpReady = resolve; });

const configDir = path.join(app.getPath('userData'), 'project-mixer');
const projectsFile = path.join(configDir, 'projects.json');
const layoutFile = path.join(configDir, 'layout.json');
const portFile = path.join(configDir, 'port.json');

function ensureConfigDir() {
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) { console.error('loadJson error:', e); }
  return fallback;
}

function saveJson(file, data) {
  ensureConfigDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  mainWindow.loadFile('index.html');
  setupApplicationMenu();
}

// A8: Application menu — calls renderer dispatch for existing commands
function dispatchToRenderer(name, args = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(`window.__pmDispatch && window.__pmDispatch(${JSON.stringify(name)}, ${JSON.stringify(args)})`)
    .catch(() => {});
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
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => dispatchToRenderer('add_project'),
        },
        {
          label: 'New File',
          click: () => dispatchToRenderer('new_file'),
        },
        {
          label: 'New Folder',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => dispatchToRenderer('new_folder'),
        },
        { type: 'separator' },
        {
          label: 'Save Active File',
          ...displayOnly('CmdOrCtrl+S'),
          click: () => dispatchToRenderer('save_active_file'),
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Close Window' } : { role: 'quit', label: 'Exit' },
      ],
    },
    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    // View menu
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          ...displayOnly('CmdOrCtrl+B'),
          click: () => dispatchToRenderer('toggle_sidebar'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
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
          accelerator: 'CmdOrCtrl+Shift+T',
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

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  createWindow();
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
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('pty:create', async (event, { command, args, cwd, projectId, cols, rows }) => {
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
  const agentMcpArgs = buildAgentMcpArgs(command, mcpUrl);

  const isWin = os.platform() === 'win32';
  const winShells = ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'wsl.exe'];
  const unixShells = ['bash', 'zsh', 'sh'];

  let shell, shellArgs;
  if (!command) {
    shell = isWin ? 'pwsh.exe' : 'bash';
    shellArgs = requestedArgs;
  } else if (isWin && winShells.includes(command)) {
    shell = command;
    shellArgs = requestedArgs;
  } else if (!isWin && unixShells.includes(command)) {
    shell = command;
    shellArgs = requestedArgs;
  } else {
    // claude, codex, etc. — wrap in pwsh -NoExit -Command on Windows
    if (isWin) {
      shell = 'pwsh.exe';
      shellArgs = [
        '-NoExit',
        '-Command',
        buildPowerShellInvocation(command, [...requestedArgs, ...agentMcpArgs]),
      ];
    } else {
      shell = command;
      shellArgs = [...requestedArgs, ...agentMcpArgs];
    }
  }

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 30,
      cwd: shellCwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        PROJECT_MIXER_PORT_FILE: portFile,
        // 3.5: inject a per-PTY MCP URL so agents discover only their session.
        ...(mcpUrl ? { PM_MCP_URL: mcpUrl } : {}),
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
    if (p.mcpToken) void mcpControl?.revokeSession(p.mcpToken);
  }
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

ipcMain.handle('command:check', async (event, { commands }) => {
  const result = {};
  for (const cmd of commands) {
    try {
      if (os.platform() === 'win32') {
        execSync(`where ${cmd}`, { stdio: 'ignore', timeout: 5000 });
      } else {
        execSync(`which ${cmd}`, { stdio: 'ignore', timeout: 5000 });
      }
      result[cmd] = true;
    } catch (e) {
      // Fallback: try running the command with --version
      // (handles shell functions/aliases not found by where/which)
      try {
        if (os.platform() === 'win32') {
          execSync(`pwsh.exe -NoProfile -Command "${cmd} --version"`, { stdio: 'ignore', timeout: 10000 });
        } else {
          execSync(`${cmd} --version`, { stdio: 'ignore', timeout: 10000 });
        }
        result[cmd] = true;
      } catch (e2) {
        result[cmd] = false;
      }
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
  // Claude Code: hook_event_type = 'Notification' | 'Stop'
  // Codex: event = 'agent-turn-complete' | 'approval-requested'
  const eventType = data.hook_event_type || data.event || data.type || '';
  const cwd = data.cwd || data.working_directory || '';
  const waiting = /notification|approval|waiting|input/i.test(eventType);

  // Find matching PTY by cwd
  let matchedPtyId = null;
  if (cwd) {
    const normalizedCwd = path.resolve(cwd).toLowerCase();
    for (const [id, p] of ptys) {
      if (path.resolve(p.cwd).toLowerCase() === normalizedCwd) {
        matchedPtyId = id;
        break;
      }
    }
  }

  mainWindow.webContents.send('hook:notify', {
    type: eventType,
    cwd,
    ptyId: matchedPtyId,
    waiting,
  });
}

// --- Project management ---

ipcMain.handle('project:list', async () => {
  return loadJson(projectsFile, []);
});

ipcMain.handle('project:add', async (event, { name, path: projPath }) => {
  const projects = loadJson(projectsFile, []);
  const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  projects.push({ id, name, path: projPath });
  saveJson(projectsFile, projects);
  return projects;
});

ipcMain.handle('project:remove', async (event, { id }) => {
  let projects = loadJson(projectsFile, []);
  projects = projects.filter(p => p.id !== id);
  saveJson(projectsFile, projects);
  return projects;
});

ipcMain.handle('project:reorder', async (event, { orderedIds }) => {
  let projects = loadJson(projectsFile, []);
  const map = new Map(projects.map(p => [p.id, p]));
  const reordered = orderedIds
    .map(id => map.get(id))
    .filter(Boolean);
  // Append any projects not in orderedIds (defensive)
  for (const p of projects) {
    if (!orderedIds.includes(p.id)) reordered.push(p);
  }
  saveJson(projectsFile, reordered);
  return reordered;
});

// --- File tree ---

ipcMain.handle('fs:readDir', async (event, { dirPath }) => {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
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
  saveJson(layoutFile, layout);
  return true;
});

ipcMain.handle('layout:load', async () => {
  return loadJson(layoutFile, null);
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

// --- Hook-based waiting indicator ---
// Receives notifications from Claude Code/Codex hook scripts via HTTP or CLI.
// The hook script calls: electron --hook-notify <json>
// Or sends an HTTP POST to a local endpoint.

ipcMain.handle('hook:notify', async (event, { type, projectId, tabId, waiting }) => {
  mainWindow.webContents.send('hook:notify', { type, projectId, tabId, waiting });
  return true;
});

// --- Hook config auto-generation ---

// Hook script reads the port from PROJECT_MIXER_PORT_FILE env var (inherited
// from the PTY that Claude Code runs in), falling back to scanning port.json
// files in known userData directories. This ensures each PM instance receives
// hooks only from PTYs it spawned, even when multiple profiles share a project.
const HOOK_SCRIPT = `#!/usr/bin/env node
// Project Mixer hook - sends notification to local HTTP server
// Port is discovered via PROJECT_MIXER_PORT_FILE env var (set by PM's PTY).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

let port = null;

// 1. Try env var (most reliable — set by the PM instance that spawned this PTY)
const portFile = process.env.PROJECT_MIXER_PORT_FILE;
if (portFile) {
  try {
    const data = JSON.parse(fs.readFileSync(portFile, 'utf-8'));
    port = data.port;
  } catch (e) {}
}

// 2. Fallback: scan userData directories for port.json
if (!port) {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dirs = [
    path.join(appData, 'Project Mixer', 'project-mixer'),
    path.join(appData, 'Project Mixer Dev', 'project-mixer'),
  ];
  for (const dir of dirs) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'port.json'), 'utf-8'));
      if (data.port) { port = data.port; break; }
    } catch (e) {}
  }
}

if (!port) { process.exit(0); }

const payload = JSON.stringify({
  hook_event_type: process.argv[2] || 'Notification',
  cwd: process.cwd(),
});

const req = http.request({
  hostname: '127.0.0.1',
  port: port,
  path: '/hook',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
}, () => { process.exit(0); });
req.on('error', () => { process.exit(0); });
req.write(payload);
req.end();
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

  // Codex: ~/.codex/config.toml (append notify hook)
  // Codex doesn't support per-project hooks well, so we skip for now
  // The PTY pattern matching handles Codex as fallback
  results.push({ tool: 'codex', success: true, note: 'Uses PTY pattern matching (no config needed)' });

  return results;
});
