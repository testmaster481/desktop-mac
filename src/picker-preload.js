'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pickerAPI', {
  onSources: (cb) => ipcRenderer.on('picker:sources', (_e, sources) => cb(sources)),
  select: (id) => ipcRenderer.send('picker:select', id),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
