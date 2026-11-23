'use strict';

const {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  Menu,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  session,
  shell,
  systemPreferences,
} = require('electron');
const path = require('path');

// ============================================================================
// CONFIG
// ============================================================================

const APP_NAME = 'S10 Telemedicine';
const HOME_URL = process.env.S10_HOME_URL || 'https://telemedicine.s10technologies.in/';
const TOOLBAR_HEIGHT = 48;
const OFFLINE_RETRY_MS = 10_000;
const MAX_CRASH_RELOADS = 3;

// Trusted = the portal itself plus any *.s10technologies.in sub-domain
// (e.g. a media/API sub-domain). Extra origins: S10_EXTRA_ORIGINS="https://a.com,https://b.com"
const TRUSTED_HOST_SUFFIX = 's10technologies.in';
const EXTRA_ORIGINS = (process.env.S10_EXTRA_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const HOME_ORIGIN = new URL(HOME_URL).origin;

// Every web permission the portal may use. Granted ONLY to trusted origins.
const ALLOWED_PERMISSIONS = new Set([
  'media', 'audioCapture', 'videoCapture', 'display-capture',
  'geolocation', 'notifications',
  'clipboard-read', 'clipboard-sanitized-write',
  'fullscreen', 'pointerLock', 'keyboardLock',
  'midi', 'midiSysex', 'mediaKeySystem',
  'idle-detection', 'window-management', 'speaker-selection',
  'persistent-storage', 'background-sync', 'fileSystem',
]);

const ASSETS = path.join(__dirname, '..', 'assets');
const UI = path.join(__dirname, 'ui');

let mainWindow = null;
let toolbarView = null;
let contentView = null;
let splashWindow = null;
let pickerWindow = null;
let offlineTimer = null;
let crashReloads = 0;
let toolbarVisible = true;
let htmlFullscreen = false;

// ============================================================================
// TRUST HELPERS
// ============================================================================

function isTrustedUrl(url) {
  try {
    const u = new URL(url);
    if (EXTRA_ORIGINS.includes(u.origin)) return true;
    if (u.origin === HOME_ORIGIN) return true;
    return (
      u.protocol === 'https:' &&
      (u.hostname === TRUSTED_HOST_SUFFIX || u.hostname.endsWith('.' + TRUSTED_HOST_SUFFIX))
    );
  } catch {
    return false;
  }
}

function isSafeExternalUrl(url) {
  try {
    return ['https:', 'http:', 'mailto:', 'tel:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isOfflinePageUrl(url) {
  return typeof url === 'string' && url.startsWith('file://') && url.includes('offline.html');
}

function fromContent(event) {
  return contentView && !contentView.webContents.isDestroyed() &&
    event.sender === contentView.webContents;
}

function fromToolbar(event) {
  return toolbarView && !toolbarView.webContents.isDestroyed() &&
    event.sender === toolbarView.webContents;
}

// ============================================================================
// SINGLE INSTANCE + FLAGS
// ============================================================================

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

app.setAppUserModelId('in.s10.telemedicine');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (process.platform === 'linux') {
  // Screen capture on Wayland goes through PipeWire / the desktop portal.
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
}

// ============================================================================
// IPC
// ============================================================================

ipcMain.handle('clipboard:write-text', (event, text) => {
  if (!isTrustedUrl(event.senderFrame?.url || '')) throw new Error('Untrusted origin');
  if (typeof text !== 'string' || text.length > 1_000_000) throw new Error('Invalid text');
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('clipboard:read-text', (event) => {
  if (!isTrustedUrl(event.senderFrame?.url || '')) throw new Error('Untrusted origin');
  return clipboard.readText();
});

ipcMain.on('nav-back', (e) => {
  if (fromToolbar(e) && contentView.webContents.navigationHistory.canGoBack()) {
    contentView.webContents.navigationHistory.goBack();
  }
});
ipcMain.on('nav-forward', (e) => {
  if (fromToolbar(e) && contentView.webContents.navigationHistory.canGoForward()) {
    contentView.webContents.navigationHistory.goForward();
  }
});
ipcMain.on('nav-refresh', (e) => {
  if (!fromToolbar(e)) return;
  isOfflinePageUrl(contentView.webContents.getURL())
    ? contentView.webContents.loadURL(HOME_URL)
    : contentView.webContents.reload();
});
ipcMain.on('nav-home', (e) => {
  // Toolbar, or the offline page's "Try again" button.
  if (fromToolbar(e) || (fromContent(e) && isOfflinePageUrl(e.senderFrame?.url))) {
    loadHome();
  }
});

// ============================================================================
// PERMISSIONS  (set once on the default session)
// ============================================================================

function setupPermissions() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = details?.requestingUrl || webContents.getURL();
    const ok = isTrustedUrl(url) && ALLOWED_PERMISSIONS.has(permission);
    console.log(`[Permission ${ok ? 'GRANTED' : 'DENIED'}] ${permission} -> ${url}`);
    callback(ok);
  });

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const url = details?.requestingUrl || requestingOrigin;
    return isTrustedUrl(url) && ALLOWED_PERMISSIONS.has(permission);
  });

  // WebHID / WebSerial / WebUSB (e.g. medical peripherals) for trusted origins.
  ses.setDevicePermissionHandler((details) => isTrustedUrl(details.origin));
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    callback(details.deviceList[0]?.deviceId);
  });
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    callback(portList[0]?.portId || '');
  });
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    callback(details.deviceList[0]?.deviceId);
  });
}

// macOS: ask the OS for camera / microphone up front so the system prompt
// appears on first launch instead of silently failing inside a call.
async function requestMacMediaAccess() {
  if (process.platform !== 'darwin') return;
  for (const kind of ['microphone', 'camera']) {
    try {
      if (systemPreferences.getMediaAccessStatus(kind) === 'not-determined') {
        await systemPreferences.askForMediaAccess(kind);
      }
    } catch (err) {
      console.error(`askForMediaAccess(${kind}) failed:`, err);
    }
  }
}

// ============================================================================
// SCREEN SHARING
// ============================================================================

function createScreenPicker(sources) {
  return new Promise((resolve) => {
    if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('picker:select', onSelect);
      ipcMain.removeListener('picker:cancel', onCancel);
      if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
      pickerWindow = null;
      resolve(value);
    };

    const win = new BrowserWindow({
      width: 880,
      height: 640,
      minWidth: 640,
      minHeight: 460,
      parent: mainWindow || undefined,
      modal: !!mainWindow && process.platform !== 'linux',
      title: 'Choose what to share',
      backgroundColor: '#ffffff',
      autoHideMenuBar: true,
      icon: path.join(ASSETS, 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'picker-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    pickerWindow = win;
    win.setMenuBarVisibility(false);

    const onSelect = (e, id) => { if (e.sender === win.webContents) finish(id); };
    const onCancel = (e) => { if (e.sender === win.webContents) finish(null); };
    ipcMain.on('picker:select', onSelect);
    ipcMain.on('picker:cancel', onCancel);
    win.on('closed', () => finish(null));

    const payload = sources.map((s) => ({
      id: s.id,
      name: s.name,
      isScreen: s.id.startsWith('screen:'),
      thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));

    win.webContents.once('did-finish-load', () => win.webContents.send('picker:sources', payload));
    win.loadFile(path.join(UI, 'picker.html'));
  });
}

async function ensureMacScreenAccess() {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'granted') return true;

  const { response } = await dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    buttons: ['Open System Settings', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Screen recording permission required',
    detail:
      'Allow "S10 Telemedicine" under System Settings → Privacy & Security → Screen & System Audio Recording, ' +
      'then restart the app and try sharing again.',
  });
  if (response === 0) {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
  return false;
}

function setupScreenSharing() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const url = request.frame?.url || '';
        if (!isTrustedUrl(url)) {
          console.log('[Screen Share] Denied - untrusted origin:', url);
          return callback({});
        }
        if (!(await ensureMacScreenAccess())) return callback({});

        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 400, height: 250 },
          fetchWindowIcons: true,
        });

        // Don't offer our own picker window.
        const visible = sources.filter((s) => !s.name.includes('Choose what to share'));
        if (!visible.length) {
          console.log('[Screen Share] No sources available');
          return callback({});
        }

        const id = await createScreenPicker(visible);
        const source = visible.find((s) => s.id === id);
        if (!source) return callback({});

        const stream = { video: source };
        // System-audio loopback is only supported on Windows.
        if (request.audioRequested && process.platform === 'win32') stream.audio = 'loopback';
        callback(stream);
      } catch (err) {
        console.error('[Screen Share] Error:', err);
        callback({});
      }
    },
    // macOS 15+: use the native system picker; falls back to our picker otherwise.
    { useSystemPicker: process.platform === 'darwin' }
  );
}

// ============================================================================
// WINDOWS
// ============================================================================

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 450,
    height: 300,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: '#ffffff',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  splashWindow.loadFile(path.join(UI, 'splash.html'));
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}

function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { width, height } = mainWindow.getContentBounds();
  const barH = toolbarVisible && !htmlFullscreen ? TOOLBAR_HEIGHT : 0;
  toolbarView.setVisible(barH > 0);
  toolbarView.setBounds({ x: 0, y: 0, width, height: barH });
  contentView.setBounds({ x: 0, y: barH, width, height: Math.max(0, height - barH) });
}

function loadHome() {
  clearTimeout(offlineTimer);
  contentView.webContents.loadURL(HOME_URL).catch((err) => {
    if (err && err.code !== 'ERR_ABORTED') console.error('loadURL failed:', err.message);
  });
}

function showOfflinePage() {
  if (!contentView || contentView.webContents.isDestroyed()) return;
  closeSplash();
  contentView.webContents.loadFile(path.join(UI, 'offline.html'));
  if (mainWindow && !mainWindow.isVisible()) mainWindow.show();

  clearTimeout(offlineTimer);
  offlineTimer = setTimeout(() => {
    if (isOfflinePageUrl(contentView.webContents.getURL())) loadHome();
  }, OFFLINE_RETRY_MS);
}

function createWindow() {
  mainWindow = new BaseWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    show: false,
    backgroundColor: '#ffffff',
    icon: path.join(ASSETS, 'icon.png'),
  });

  toolbarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'toolbar-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  contentView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  mainWindow.contentView.addChildView(contentView);
  mainWindow.contentView.addChildView(toolbarView);
  layoutViews();
  mainWindow.on('resize', layoutViews);
  mainWindow.on('maximize', layoutViews);
  mainWindow.on('unmaximize', layoutViews);
  mainWindow.on('enter-full-screen', layoutViews);
  mainWindow.on('leave-full-screen', layoutViews);

  toolbarView.webContents.loadFile(path.join(UI, 'toolbar.html'));

  const wc = contentView.webContents;

  // Hide the toolbar while a page is in HTML fullscreen (e.g. video).
  wc.on('enter-html-full-screen', () => { htmlFullscreen = true; layoutViews(); });
  wc.on('leave-html-full-screen', () => { htmlFullscreen = false; layoutViews(); });

  // ---- load lifecycle -----------------------------------------------------
  wc.once('did-finish-load', () => {
    console.log('Telemedicine application loaded');
  });
  wc.on('did-finish-load', () => {
    if (isOfflinePageUrl(wc.getURL())) return;
    crashReloads = 0;
    closeSplash();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });

  wc.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 /* ERR_ABORTED */) return;
    console.error('Page failed to load:', errorCode, errorDescription, validatedURL);
    showOfflinePage();
  });

  wc.on('render-process-gone', (event, details) => {
    console.error('Renderer gone:', details.reason);
    if (details.reason === 'clean-exit' || crashReloads >= MAX_CRASH_RELOADS) return;
    crashReloads += 1;
    setTimeout(() => { if (!wc.isDestroyed()) wc.reload(); }, 1000);
  });

  // ---- links / popups -----------------------------------------------------
  wc.setWindowOpenHandler(({ url }) => {
    if (isTrustedUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          icon: path.join(ASSETS, 'icon.png'),
          autoHideMenuBar: true,
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        },
      };
    }
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url) || isOfflinePageUrl(url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  });

  // ---- right-click: copy / paste / inspect-free context menu --------------
  wc.on('context-menu', (event, params) => {
    const items = [];
    if (params.isEditable) {
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    } else if (params.selectionText) {
      items.push({ role: 'copy' });
    }
    if (params.linkURL) {
      items.push({ label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) });
    }
    if (items.length) Menu.buildFromTemplate(items).popup();
  });

  mainWindow.on('closed', () => {
    clearTimeout(offlineTimer);
    mainWindow = null;
    toolbarView = null;
    contentView = null;
  });

  loadHome();
}

// ============================================================================
// MENU
// ============================================================================

function createApplicationMenu() {
  const wc = () => (contentView && !contentView.webContents.isDestroyed() ? contentView.webContents : null);

  const template = [
    { label: 'File', submenu: [{ role: 'minimize' }, { type: 'separator' }, { role: 'quit' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Copy Page URL',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => { const w = wc(); if (w) clipboard.writeText(w.getURL()); },
        },
      ],
    },
    {
      label: 'Navigation',
      submenu: [
        {
          label: 'Back', accelerator: 'Alt+Left',
          click: () => { const w = wc(); if (w?.navigationHistory.canGoBack()) w.navigationHistory.goBack(); },
        },
        {
          label: 'Forward', accelerator: 'Alt+Right',
          click: () => { const w = wc(); if (w?.navigationHistory.canGoForward()) w.navigationHistory.goForward(); },
        },
        { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => wc()?.reload() },
        { type: 'separator' },
        { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => loadHome() },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Toolbar',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => { toolbarVisible = !toolbarVisible; layoutViews(); },
        },
        { label: 'Toggle Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => wc()?.toggleDevTools() },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => { const w = wc(); if (w) w.setZoomLevel(w.getZoomLevel() + 0.5); } },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => { const w = wc(); if (w) w.setZoomLevel(w.getZoomLevel() - 0.5); } },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => wc()?.setZoomLevel(0) },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ============================================================================
// LIFECYCLE
// ============================================================================

app.whenReady().then(async () => {
  console.log(`Starting ${APP_NAME} | Electron ${process.versions.electron} | Chrome ${process.versions.chrome}`);
  console.log('Home URL:', HOME_URL);

  setupPermissions();
  setupScreenSharing();
  createApplicationMenu();
  createSplashWindow();
  createWindow();
  requestMacMediaAccess();

  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Never allow embedded <webview> tags.
app.on('web-contents-created', (event, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});
