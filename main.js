const { app, BrowserWindow, ipcMain, clipboard, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const pty = require('node-pty');
const { execSync } = require('child_process');

let mainWindow;
const ptys = new Map(); // id -> { process, cwd, command }
let ptyCounter = 0;
const HOOK_PORT = 47832;

const configDir = path.join(app.getPath('userData'), 'project-mixer');
const projectsFile = path.join(configDir, 'projects.json');
const layoutFile = path.join(configDir, 'layout.json');

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
}

app.whenReady().then(() => {
  createWindow();
  startHookServer();
});

app.on('window-all-closed', () => {
  ptys.forEach((p) => p.process.kill());
  ptys.clear();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('pty:create', (event, { command, args, cwd, cols, rows }) => {
  const id = ++ptyCounter;
  const shellCwd = cwd || os.homedir();

  const isWin = os.platform() === 'win32';
  const winShells = ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'wsl.exe'];
  const unixShells = ['bash', 'zsh', 'sh'];

  let shell, shellArgs;
  if (!command) {
    shell = isWin ? 'pwsh.exe' : 'bash';
    shellArgs = args || [];
  } else if (isWin && winShells.includes(command)) {
    shell = command;
    shellArgs = args || [];
  } else if (!isWin && unixShells.includes(command)) {
    shell = command;
    shellArgs = args || [];
  } else {
    // claude, codex, etc. — wrap in pwsh -NoExit -Command on Windows
    if (isWin) {
      shell = 'pwsh.exe';
      shellArgs = ['-NoExit', '-Command', command];
    } else {
      shell = command;
      shellArgs = args || [];
    }
  }

  const ptyProcess = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 30,
    cwd: shellCwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

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
  });

  ptys.set(id, { process: ptyProcess, cwd: shellCwd, command: command || shell });
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
  server.listen(HOOK_PORT, '127.0.0.1');
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`Hook server port ${HOOK_PORT} already in use`);
    } else {
      console.error('Hook server error:', e);
    }
  });
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
    const content = await fsp.readFile(filePath, 'utf-8');
    return { success: true, content };
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

const HOOK_SCRIPT = `#!/usr/bin/env node
// Project Mixer hook - sends notification to local HTTP server
const http = require('http');
const path = require('path');

const payload = JSON.stringify({
  hook_event_type: process.argv[2] || 'Notification',
  cwd: process.cwd(),
});

const req = http.request({
  hostname: '127.0.0.1',
  port: ${HOOK_PORT},
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

  // Claude Code: .claude/settings.json
  const claudeDir = path.join(projectPath, '.claude');
  const claudeSettings = path.join(claudeDir, 'settings.json');
  const hookScriptPath = path.join(claudeDir, 'project-mixer-hook.js');

  try {
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

    // Write hook script
    fs.writeFileSync(hookScriptPath, HOOK_SCRIPT, 'utf-8');

    // Read existing settings or create new
    let settings = {};
    if (fs.existsSync(claudeSettings)) {
      try { settings = JSON.parse(fs.readFileSync(claudeSettings, 'utf-8')); } catch (e) {}
    }

    // Add hooks for Notification and Stop
    if (!settings.hooks) settings.hooks = {};
    // Escape backslashes for Windows paths; Unix paths need no escaping
    const escapedPath = os.platform() === 'win32'
      ? hookScriptPath.replace(/\\/g, '\\\\')
      : hookScriptPath;
    const hookCmd = `node "${escapedPath}"`;
    settings.hooks.Notification = [{ matcher: '', hooks: [{ type: 'command', command: hookCmd }] }];
    settings.hooks.Stop = [{ matcher: '', hooks: [{ type: 'command', command: hookCmd }] }];

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
