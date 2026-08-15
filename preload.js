const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // PTY
  ptyCreate: (opts) => ipcRenderer.invoke('pty:create', opts),
  ptyWrite: (id, data) => ipcRenderer.invoke('pty:write', { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.invoke('pty:kill', { id }),
  onPtyData: (callback) => ipcRenderer.on('pty:data', (_e, payload) => callback(payload)),
  onPtyExit: (callback) => ipcRenderer.on('pty:exit', (_e, payload) => callback(payload)),

  // Memory
  memGet: () => ipcRenderer.invoke('mem:get'),

  // Application menu
  menuPopup: (x, y) => ipcRenderer.invoke('menu:popup', { x, y }),

  // Projects
  projectList: () => ipcRenderer.invoke('project:list'),
  projectAdd: (name, projPath) => ipcRenderer.invoke('project:add', { name, path: projPath }),
  projectRemove: (id) => ipcRenderer.invoke('project:remove', { id }),
  projectReorder: (orderedIds) => ipcRenderer.invoke('project:reorder', { orderedIds }),

  // File tree
  readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', { dirPath }),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', { filePath }),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', { filePath, content }),

  // Clipboard image
  clipboardSaveImage: (projectPath) => ipcRenderer.invoke('clipboard:saveImage', { projectPath }),

  // Clipboard text (terminal copy)
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard:writeText', { text }),

  // Layout
  layoutSave: (layout) => ipcRenderer.invoke('layout:save', { layout }),
  layoutLoad: () => ipcRenderer.invoke('layout:load'),

  // Folder dialog
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),

  // Save dialog
  saveFileDialog: (defaultPath, defaultName) => ipcRenderer.invoke('dialog:saveFile', { defaultPath, defaultName }),

  // Open file in OS default app
  openInOs: (filePath) => ipcRenderer.invoke('shell:openPath', { filePath }),

  // File operations
  deleteFile: (filePath) => ipcRenderer.invoke('fs:deleteFile', { filePath }),
  createFile: (filePath) => ipcRenderer.invoke('fs:createFile', { filePath }),
  createDir: (dirPath) => ipcRenderer.invoke('fs:createDir', { dirPath }),

  // Hook-based waiting indicator
  onHookNotify: (callback) => ipcRenderer.on('hook:notify', (event, data) => callback(data)),
  hookSetup: (projectPath) => ipcRenderer.invoke('hook:setup', { projectPath }),
  devinBind: (ptyId, sessionId) => ipcRenderer.invoke('devin:bind', { ptyId, sessionId }),
  devinUnbind: (ptyId) => ipcRenderer.invoke('devin:unbind', { ptyId }),
  onDevinMonitorError: (callback) => ipcRenderer.on('devin:monitor-error', (_event, data) => callback(data)),

  // Command availability check
  commandCheck: (commands) => ipcRenderer.invoke('command:check', { commands }),

  // A3: Drag & drop file path resolution (Electron 31+ replacement for File.path)
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Window focus (for OS notification click)
  focusWindow: () => ipcRenderer.invoke('window:focus'),
});
