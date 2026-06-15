const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('navAPI', {
  back: () => ipcRenderer.send('nav-back'),
  forward: () => ipcRenderer.send('nav-forward'),
  refresh: () => ipcRenderer.send('nav-refresh'),
  home: () => ipcRenderer.send('nav-home')
});