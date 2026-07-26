const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const pty = require('node-pty');

let mainWindow;
const ptys = new Map();
let ptyCounter = 0;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Project Mixer - Spike S1/S2',
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
