'use strict';

// Preload for the telemedicine site (and trusted pop-ups).
const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('s10Desktop', {
  isDesktop: true,
  platform: process.platform,
  copyText: (text) => ipcRenderer.invoke('clipboard:write-text', String(text)),
  readText: () => ipcRenderer.invoke('clipboard:read-text'),
  retry: () => ipcRenderer.send('nav-home'), // used by the offline page
});

// Backwards-compatible name used by the previous build.
contextBridge.exposeInMainWorld('navAPI', {
  copyText: (text) => ipcRenderer.invoke('clipboard:write-text', String(text)),
  home: () => ipcRenderer.send('nav-home'),
});

// If the browser Clipboard API rejects (focus / permission edge cases inside
// Electron), transparently fall back to the native clipboard through the main
// process so "Copy" buttons in the web app always work.
window.addEventListener('DOMContentLoaded', () => {
  webFrame.executeJavaScript(`
    (() => {
      if (window.__s10ClipboardPatched || !navigator.clipboard || !window.s10Desktop) return;
      window.__s10ClipboardPatched = true;
      const cb = navigator.clipboard;
      const nativeWrite = cb.writeText && cb.writeText.bind(cb);
      const nativeRead = cb.readText && cb.readText.bind(cb);
      cb.writeText = async (text) => {
        try { if (nativeWrite) return await nativeWrite(text); } catch (e) {}
        await window.s10Desktop.copyText(String(text));
      };
      cb.readText = async () => {
        try { if (nativeRead) return await nativeRead(); } catch (e) {}
        return window.s10Desktop.readText();
      };
    })();
  `).catch(() => {});
});
