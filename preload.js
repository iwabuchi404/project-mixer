const { contextBridge, ipcRenderer } = require('electron');

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

  // Projects
  projectList: () => ipcRenderer.invoke('project:list'),
  projectAdd: (name, projPath) => ipcRenderer.invoke('project:add', { name, path: projPath }),
  projectRemove: (id) => ipcRenderer.invoke('project:remove', { id }),

  // File tree
  readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', { dirPath }),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', { filePath }),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', { filePath, content }),

  // Clipboard image
  clipboardSaveImage: (projectPath) => ipcRenderer.invoke('clipboard:saveImage', { projectPath }),

  // Layout
  layoutSave: (layout) => ipcRenderer.invoke('layout:save', { layout }),
  layoutLoad: () => ipcRenderer.invoke('layout:load'),

  // Folder dialog
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),

  // Hook-based waiting indicator
  onHookNotify: (callback) => ipcRenderer.on('hook:notify', (event, data) => callback(data)),
  hookSetup: (projectPath) => ipcRenderer.invoke('hook:setup', { projectPath }),
});
