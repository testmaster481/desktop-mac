const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

let mainWindow;
let splashWindow; // Global reference for the loader screen
const HOME_URL = 'https://telemedicine.s10technologies.in/';
const APP_NAME = "Telemedicine";

// ============================================================================
// SINGLE INSTANCE ENFORCEMENT
// ============================================================================
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ============================================================================
// LOADER / SPLASH SCREEN UI
// ============================================================================
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 450,
    height: 300,
    frame: false,         // Frameless window for native utility feel
    resizable: false,
    alwaysOnTop: true,    // Keeps loading feedback prominent during boot
    transparent: false,
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Modern, clean CSS loader design matching medical aesthetics
  const splashHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { 
          margin: 0; 
          background: #ffffff; 
          display: flex; 
          flex-direction: column; 
          align-items: center; 
          justify-content: center; 
          height: 100vh; 
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          user-select: none;
        }
        .spinner {
          border: 4px solid rgba(0, 123, 255, 0.1);
          width: 46px;
          height: 46px;
          border-radius: 50%;
          border-left-color: #007bff; /* Medical Blue tint */
          animation: spin 1s linear infinite;
        }
        .brand {
          margin-top: 20px;
          font-size: 18px;
          font-weight: 600;
          color: #212529;
          letter-spacing: 0.5px;
        }
        .status {
          margin-top: 8px;
          font-size: 13px;
          color: #6c757d;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      </style>
    </head>
    <body>
      <div class="spinner"></div>
      <div class="brand">${APP_NAME}</div>
      <div class="status">Securing connection to live portal...</div>
    </body>
    </html>
  `;

  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHTML)}`);
}

// ============================================================================
// MAIN WINDOW INITIALIZATION
// ============================================================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: APP_NAME,
    show: false, // Keep hidden until network contents download completely
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  // Load target platform URL
  mainWindow.loadURL(HOME_URL).catch((err) => {
    console.error("Initial routing error:", err);
    displayOfflinePage();
  });

  // SWAP WINDOWS: Hide loading screen and display main site canvas once downloaded
  mainWindow.webContents.once('did-finish-load', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  // Secure window target limits
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('https://telemedicine.s10technologies.in')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // NETWORK FAILURES
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    if (validatedURL === HOME_URL || errorCode === -106) {
      if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
      }
      displayOfflinePage();
    }
  });

  // PROCESS CRASHES
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error(`Render process crashed: ${details.reason}`);
    if (mainWindow) mainWindow.reload();
  });
}

function displayOfflinePage() {
  if (!mainWindow) return;
  const offlineHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #f8f9fa; color: #333; margin: 0; }
        h1 { margin-bottom: 8px; color: #dc3545; }
        button { padding: 10px 20px; background: #007bff; border: none; color: white; border-radius: 4px; cursor: pointer; font-size: 16px; margin-top: 15px; }
        button:hover { background: #0056b3; }
      </style>
    </head>
    <body>
      <h1>Connection Lost</h1>
      <p>Unable to connect to the Telemedicine portal. Please verify your network availability.</p>
      <button onclick="window.location.reload()">🔄 Try Reconnecting</button>
    </body>
    </html>
  `;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(offlineHTML)}`);
  mainWindow.show();
}

// ============================================================================
// HARDWARE CHANNELS & LIFECYCLE
// ============================================================================
app.on('web-contents-created', (event, contents) => {
  contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const currentUrl = webContents.getURL();
    if (currentUrl.startsWith('https://telemedicine.s10technologies.in')) {
      const trusted = ['media', 'audioCapture', 'videoCapture', 'notifications', 'geolocation'];
      if (trusted.includes(permission)) return callback(true);
    }
    callback(false);
  });
});

function createApplicationMenu() {
  const template = [
    { label: 'File', submenu: [{ role: 'minimize' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'Navigation',
      submenu: [
        { label: '← Back', accelerator: 'Alt+Left', click: () => { if (mainWindow?.webContents.canGoBack()) mainWindow.webContents.goBack(); } },
        { label: '→ Forward', accelerator: 'Alt+Right', click: () => { if (mainWindow?.webContents.canGoForward()) mainWindow.webContents.goForward(); } },
        { label: '↻ Refresh', accelerator: 'CmdOrCtrl+R', click: () => { mainWindow?.webContents.reload(); } },
        { type: 'separator' },
        { label: '🏠 Home', accelerator: 'CmdOrCtrl+H', click: () => { mainWindow?.webContents.loadURL(HOME_URL); } }
      ]
    }
  ];
  if (process.platform === 'darwin') {
    template.unshift({ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  createApplicationMenu();
  createSplashWindow(); // 1. Run loader immediately
  createWindow();       // 2. Buffer main site in the background

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});