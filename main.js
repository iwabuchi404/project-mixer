const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const pty = require('node-pty');

let mainWindow;
const ptys = new Map();
let ptyCounter = 0;

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
    },
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  ptys.forEach((p) => p.kill());
  ptys.clear();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('pty:create', (event, { command, args, cwd, cols, rows }) => {
  const id = ++ptyCounter;
  const shellCwd = cwd || os.homedir();

  let shell, shellArgs;
  if (!command || command === 'pwsh.exe' || command === 'powershell.exe' || command === 'cmd.exe') {
    shell = command || (os.platform() === 'win32' ? 'pwsh.exe' : 'bash');
    shellArgs = args || [];
  } else {
    // claude, codex, etc. — wrap in pwsh -NoExit -Command on Windows
    if (os.platform() === 'win32') {
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

  ptys.set(id, ptyProcess);
  return id;
});

ipcMain.handle('pty:write', (event, { id, data }) => {
  const p = ptys.get(id);
  if (p) p.write(data);
});

ipcMain.handle('pty:resize', (event, { id, cols, rows }) => {
  const p = ptys.get(id);
  if (p) p.resize(cols, rows);
});

ipcMain.handle('pty:kill', (event, { id }) => {
  const p = ptys.get(id);
  if (p) {
    p.kill();
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
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
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

// --- Layout persistence ---

ipcMain.handle('layout:save', async (event, { layout }) => {
  saveJson(layoutFile, layout);
  return true;
});

ipcMain.handle('layout:load', async () => {
  return loadJson(layoutFile, null);
});
