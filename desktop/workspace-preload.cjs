const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('botorghqDesktop', {
    setLocale: locale => ipcRenderer.invoke('workbench:set-locale', locale)
  });
}
