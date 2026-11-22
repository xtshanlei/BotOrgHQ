const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updates', {
  state: () => ipcRenderer.invoke('updates:state'),
  check: () => ipcRenderer.invoke('updates:check'),
  download: () => ipcRenderer.invoke('updates:download'),
  install: () => ipcRenderer.invoke('updates:install'),
  saveToken: token => ipcRenderer.invoke('updates:token', token),
  transfer: (operation, password) => ipcRenderer.invoke('updates:transfer', operation, password),
  preferences: values => ipcRenderer.invoke('updates:preferences', values),
  onShowTransfer: callback => ipcRenderer.on('updates:show-transfer', () => callback()),
  showBackups: () => ipcRenderer.invoke('updates:backups')
});
