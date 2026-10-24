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
  // Notifications (renderer -> main native notification)
  'notification:show',
  // SMS (renderer -> main -> local server)
  'sms:list',
  'sms:send',
  'sms:clear',
  'sms:me',
]);

/**
 * Channels the main process can push to the renderer.
 * Renderer subscribes via on(channel, handler).
 */
const SUBSCRIBABLE_CHANNELS = new Set([
  'sms:open',
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

  notifications: {
    // payload: { number: '+1…', body: '…' }.
    // Returns { ok: true } or { ok: false, error }.
    show: (payload) => ipcRenderer.invoke('notification:show', payload),
  },

  sms: {
    // Returns { ok: true, conversations: [...] } or { ok: true, number, messages, ... }
    // for single-thread fetch, or { ok: false, error } on failure.
    // Pass { number: '+1…' } to fetch a single thread; omit for all.
    list: (opts) => ipcRenderer.invoke('sms:list', opts || {}),
    // payload: { to: '+1…', body: '…' }.
    // Returns { ok: true, sid, to, status } or { ok: false, error }.
    send: (payload) => ipcRenderer.invoke('sms:send', payload),
    // payload: { number: '+1…' }. Wipes local history for that thread.
    // Returns { ok: true, cleared, number, messages: [] } or { ok: false, error }.
    clear: (payload) => ipcRenderer.invoke('sms:clear', payload),
    // Operator identity as the token server sees it: callerId + smsFrom.
    me: () => ipcRenderer.invoke('sms:me'),
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
