const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updates', {
  state: () => ipcRenderer.invoke('updates:state'),
  check: () => ipcRenderer.invoke('updates:check'),
  download: () => ipcRenderer.invoke('updates:download'),
  install: () => ipcRenderer.invoke('updates:install'),
  saveToken: token => ipcRenderer.invoke('updates:token', token),
  showBackups: () => ipcRenderer.invoke('updates:backups')
});
