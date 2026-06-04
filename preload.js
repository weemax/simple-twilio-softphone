// Preload script — runs in an isolated context with access to Node APIs.
// Exposes a narrow, typed surface to the renderer via contextBridge.
// The renderer (React) never gets `require` or raw `ipcRenderer`.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Channels the main process is allowed to receive from the renderer.
 * Keep this list tight — any new IPC must be added explicitly.
 */
const INVOKABLE_CHANNELS = new Set([
  // Account / config
  'config:get',
  'config:set',
  'config:clear',
  // Capability tokens (server-side)
  'token:fetch',
  // App lifecycle / shell
  'app:platform',
  'app:version',
  'app:openExternal',
  // Storage helpers (so renderer never touches fs)
  'secrets:set',
  'secrets:get',
  'secrets:clear',
]);

/**
 * Channels the main process can push to the renderer.
 * Renderer subscribes via on(channel, handler).
 */
const SUBSCRIBABLE_CHANNELS = new Set([
  'call:incoming',
  'call:status',
  'device:status',
  'error:log',
]);

const api = {
  // --- generic invoke wrapper, gated by allowlist ---
  invoke: (channel, ...args) => {
    if (!INVOKABLE_CHANNELS.has(channel)) {
      return Promise.reject(
        new Error(`Channel "${channel}" is not allowed.`)
      );
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  // --- typed convenience wrappers (preferred) ---
  config: {
    // get() with no key returns the whole config object; with a key returns
    // that single value. Matches the main-side config.get(key) contract.
    get: (key) => ipcRenderer.invoke('config:get', key),
    set: (key, value) => ipcRenderer.invoke('config:set', key, value),
    clear: (key) => ipcRenderer.invoke('config:clear', key),
  },

  token: {
    fetch: (identity) => ipcRenderer.invoke('token:fetch', identity),
  },

  secrets: {
    set: (key, value) => ipcRenderer.invoke('secrets:set', { key, value }),
    get: (key) => ipcRenderer.invoke('secrets:get', key),
    clear: (key) => ipcRenderer.invoke('secrets:clear', key),
  },

  app: {
    platform: () => ipcRenderer.invoke('app:platform'),
    version: () => ipcRenderer.invoke('app:version'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  },

  // --- push subscriptions ---
  on: (channel, handler) => {
    if (!SUBSCRIBABLE_CHANNELS.has(channel)) {
      throw new Error(`Channel "${channel}" is not subscribable.`);
    }
    const wrapped = (_event, ...args) => handler(...args);
    ipcRenderer.on(channel, wrapped);
    // Return an unsubscribe function so React effects can clean up.
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('operator', api);
