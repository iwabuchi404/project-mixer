const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  ptyCreate: (opts) => ipcRenderer.invoke('pty:create', opts),
  ptyWrite: (id, data) => ipcRenderer.invoke('pty:write', { id, data }),
  ptyResize: (id, cols, rows) => ipcRenderer.invoke('pty:resize', { id, cols, rows }),
  ptyKill: (id) => ipcRenderer.invoke('pty:kill', { id }),
  memGet: () => ipcRenderer.invoke('mem:get'),
  onPtyData: (callback) => ipcRenderer.on('pty:data', (_e, payload) => callback(payload)),
  onPtyExit: (callback) => ipcRenderer.on('pty:exit', (_e, payload) => callback(payload)),
});
