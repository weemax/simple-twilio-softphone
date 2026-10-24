const path = require('path');
const {
  app,
  BrowserWindow,
  Notification,
  ipcMain,
  shell,
} = require('electron');
const isDev = require('electron-is-dev');

const config = require('./main/services/config');
const tokenBroker = require('./main/services/tokenBroker');
const smsBroker = require('./main/services/smsBroker');
const sessionStatus = require('./main/services/session');
const setupBroker = require('./main/services/setupBroker');

// Where the development renderer lives. `npm run phone` passes its React
// address; only a dev server on this machine is accepted, since the page
// gets the preload bridge.
function rendererUrl() {
  const fallback = 'http://localhost:3000';
  try {
    const url = new URL(process.env.OPERATOR_RENDERER_URL || fallback);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    return url.protocol === 'http:' && local ? url.origin : fallback;
  } catch (_) {
    return fallback;
  }
}
const RENDERER_URL = rendererUrl();

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

  // `npm run phone` waits for these lines before it reports the app open.
  win.webContents.once('did-finish-load', () => {
    console.log('[operator] window ready');
  });
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    // -3 is an aborted load (a newer navigation replaced it), not a failure.
    if (isMainFrame && code !== -3) {
      console.log(`[operator] window failed to load ${url}: ${description}`);
    }
  });

  if (isDev) {
    win.loadURL(RENDERER_URL);
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
      ? url.startsWith(RENDERER_URL + '/') || url === RENDERER_URL
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

  // No secrets channel: the renderer cannot read, write or clear a stored
  // credential. Twilio credentials live in server/.env and are set only by
  // the setup channels below, which never return them. (An old desktop copy
  // of the Auth Token in main/services/secrets.js is left as it was: it is
  // not read, migrated or deleted.)

  // Capability tokens
  ipcMain.handle('token:fetch', async (_e, identity) => {
    try {
      return { ok: true, ...(await tokenBroker.fetchToken(identity)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Notifications — renderer requests a native notification without gaining
  // access to Electron or any main-process secrets.
  ipcMain.handle('notification:show', (_e, payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, error: 'payload required' };
    }
    const number =
      typeof payload.number === 'string' ? payload.number.slice(0, 32) : '';
    const body =
      typeof payload.body === 'string' ? payload.body.slice(0, 240) : '';
    if (!body) return { ok: false, error: 'body required' };
    if (!Notification.isSupported()) {
      return { ok: false, error: 'notifications unavailable' };
    }
    const notification = new Notification({
      title: number ? `New SMS from ${number}` : 'New SMS',
      body,
      // The renderer plays the bundled sound so native notification audio
      // cannot produce a second alert.
      silent: true,
    });
    notification.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
      win.webContents.send('sms:open', { number });
    });
    notification.show();
    return { ok: true };
  });

  // SMS — list and send. Inbound webhook is server-side only (no IPC).
  ipcMain.handle('sms:list', async (_e, opts) => {
    try {
      const number = opts && typeof opts.number === 'string' ? opts.number : null;
      const data = await smsBroker.listConversations(number);
      return { ok: true, ...(data || {}) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('sms:send', async (_e, payload) => {
    try {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'payload required' };
      }
      const data = await smsBroker.sendMessage({
        to: payload.to,
        body: payload.body,
      });
      return { ok: true, ...(data || {}) };
    } catch (err) {
      return { ok: false, error: err.message, status: err.outcome || 'unknown' };
    }
  });
  ipcMain.handle('sms:me', async () => {
    try {
      const data = await smsBroker.getMe();
      return { ok: true, ...(data || {}) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('sms:clear', async (_e, payload) => {
    try {
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'payload required' };
      }
      if (typeof payload.number !== 'string' || !payload.number) {
        return { ok: false, error: 'number required' };
      }
      const data = await smsBroker.clearConversation(payload.number);
      return { ok: true, ...(data || {}) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // In-app Twilio setup (see main/services/setupBroker.js). Each answer is
  // { ok, ... } and never contains the Auth Token or an API secret.
  for (const [channel, call] of [
    ['setup:status', () => setupBroker.status()],
    ['setup:check', (input) => setupBroker.check(input)],
    ['setup:review', (input) => setupBroker.review(input)],
    ['setup:connect', (input) => setupBroker.connect(input)],
    ['setup:repair', () => setupBroker.repair()],
  ]) {
    ipcMain.handle(channel, async (_e, input) => {
      try {
        return await call(input);
      } catch (err) {
        return { ok: false, kind: 'service', error: err.message };
      }
    });
  }

  // Local service and tunnel status (see main/services/session.js).
  ipcMain.handle('session:status', async () => {
    try {
      return { ok: true, ...(await sessionStatus.readStatus()) };
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

function focusWindow() {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// One running copy per profile: a second launch brings the open window to
// the front instead of becoming a second writer of the same saved data.
if (!app.requestSingleInstanceLock()) {
  console.log('[operator] already open: focusing the existing window');
  app.quit();
} else {
  app.on('second-instance', focusWindow);

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
}
