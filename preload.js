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
  // Local service and tunnel status
  'session:status',
  // App lifecycle / shell
  'app:platform',
  'app:version',
  'app:openExternal',
  // Twilio account setup (renderer -> main -> local service; no secret comes back)
  'setup:status',
  'setup:check',
  'setup:review',
  'setup:connect',
  'setup:repair',
  // Notifications (renderer -> main native notification)
  'notification:show',
  // SMS (renderer -> main -> local server)
  'sms:list',
  'sms:send',
  'sms:clear',
  'sms:me',
  'sms:attach',
  'sms:media',
  'sms:media-discard',
  'sms:media-prune',
  'sms:media-policy',
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

  setup: {
    // Presence of each credential, never a value: { ok, credentials,
    // accountSid, hasAuthToken, number, identity, publicBaseUrl,
    // connected, connection: { account, voice, sms, voiceUrl, callback, mms } }.
    status: () => ipcRenderer.invoke('setup:status'),
    // input: { accountSid?, authToken?, publicBaseUrl? }. Blank fields use
    // what server/.env already holds. One read-only request to Twilio;
    // { ok, numbers } or { ok: false, kind, error }.
    check: (input) => ipcRenderer.invoke('setup:check', input || {}),
    // input adds { numberSid, identity }. Read-only: { ok, rows } listing every change.
    review: (input) => ipcRenderer.invoke('setup:review', input || {}),
    // input adds { replace: { voice?, sms? } } naming each foreign route the
    // person agreed to replace. { ok, steps } or { ok: false, failedStep }.
    connect: (input) => ipcRenderer.invoke('setup:connect', input || {}),
    // Checks and repairs only what Operator owns in the account.
    repair: () => ipcRenderer.invoke('setup:repair'),
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
    // payload: { to: '+1…', body: '…', media?: [photo ids] }. A photo-only
    // message has an empty body. Returns { ok: true, sid, to, status, mms }
    // or { ok: false, error, status }.
    send: (payload) => ipcRenderer.invoke('sms:send', payload),
    // Photos. Attaching keeps the photo on this computer only; nothing is
    // uploaded or linked until sms.send includes its id.
    //   attach({ name, bytes: Uint8Array }) -> { ok, media: { id, type, bytes, width, height, name } }
    //   media({ id })                       -> { ok, type, bytes }
    //   discardMedia({ id })                -> { ok, removed }  (drafts only)
    //   pruneMedia({ keep: [ids] })         -> { ok, removed }  (unlisted old drafts)
    //   photoPolicy({ to })                 -> { ok, supported, reason, country, sender, limits }
    attach: (payload) => ipcRenderer.invoke('sms:attach', payload),
    media: (payload) => ipcRenderer.invoke('sms:media', payload),
    discardMedia: (payload) => ipcRenderer.invoke('sms:media-discard', payload),
    pruneMedia: (payload) => ipcRenderer.invoke('sms:media-prune', payload),
    photoPolicy: (payload) => ipcRenderer.invoke('sms:media-policy', payload),
    // payload: { number: '+1…' }. Wipes local history for that thread.
    // Returns { ok: true, cleared, number, messages: [] } or { ok: false, error }.
    clear: (payload) => ipcRenderer.invoke('sms:clear', payload),
    // Operator identity as the token server sees it: callerId + smsFrom.
    me: () => ipcRenderer.invoke('sms:me'),
  },

  session: {
    // { ok, managed, service: { state, url, detail }, tunnel: { state, url, reason } }.
    // See main/services/session.js for the states.
    status: () => ipcRenderer.invoke('session:status'),
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
