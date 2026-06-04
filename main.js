const path = require('path');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const isDev = require('electron-is-dev');

const secrets = require('./main/services/secrets');
const config = require('./main/services/config');
const tokenBroker = require('./main/services/tokenBroker');

function createWindow() {
  const win = new BrowserWindow({
    title: 'Operator',
    width: 980,
    height: 720,
    minWidth: 480,
    minHeight: 560,
    webPreferences: {
      // Secure-by-default. Renderer cannot use require / Node APIs.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // preload still needs require for contextBridge
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:3000');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadURL(`file://${path.join(__dirname, 'build', 'index.html')}`);
  }

  // Block in-app navigation and new windows — open external links in the OS
  // browser instead. Renderer should never be the source of truth for URLs.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev
      ? url.startsWith('http://localhost:3000')
      : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  return win;
}

// --- IPC handlers ---

function registerIpc() {
  // Generic config (non-secret)
  ipcMain.handle('config:get', (_e, key) => config.get(key));
  ipcMain.handle('config:set', (_e, key, value) => config.set(key, value));
  ipcMain.handle('config:clear', (_e, key) => config.clear(key));

  // Secrets (encrypted via safeStorage when available)
  ipcMain.handle('secrets:set', (_e, { key, value }) =>
    secrets.setSecret(key, value)
  );
  ipcMain.handle('secrets:get', (_e, key) => secrets.getSecret(key));
  ipcMain.handle('secrets:clear', (_e, key) => secrets.clearSecret(key));
  ipcMain.handle('secrets:available', () => secrets.isAvailable());

  // Capability tokens
  ipcMain.handle('token:fetch', async (_e, identity) => {
    try {
      return { ok: true, ...(await tokenBroker.fetchToken(identity)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // App shell
  ipcMain.handle('app:platform', () => process.platform);
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:openExternal', async (_e, url) => {
    // Only allow https/http — refuse javascript:, file://, etc.
    if (typeof url !== 'string') return { ok: false, error: 'invalid url' };
    try {
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol)) {
        return { ok: false, error: 'protocol not allowed' };
      }
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Optional: surface unhandled errors to the renderer for logging
  process.on('uncaughtException', (err) => {
    BrowserWindow.getAllWindows().forEach((w) => {
      w.webContents.send('error:log', {
        kind: 'uncaughtException',
        message: err.message,
        stack: err.stack,
      });
    });
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
