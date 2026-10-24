// SMS service — renderer-side singleton.
//
// Mirrors TwilioService's pattern: pub/sub snapshot, action methods,
// and a single instance bound to a hook (useSmsClient). The service
// owns conversation data; selection of which thread is "open" is a
// React concern and lives in the component.
//
// Inbound messages are not pushed from the main process (no IPC channel
// for that yet). Instead, the service polls the broker on a timer so
// new inbound messages appear within ~POLL_MS. Outbound sends trigger
// an immediate refresh so the local UI shows the new message without
// waiting for the next tick.

import { notifyInboundSms } from './smsNotifications';

const POLL_MS = 3000;
// Photo bytes the renderer keeps so reopening a thread does not fetch them again.
const PHOTO_CACHE_BYTES = 48 * 1024 * 1024;
const MAX_PHOTO_FILE_BYTES = 5 * 1024 * 1024;

// The local service's message, without the "SMS backend 415:" the broker adds.
const plainMessage = (message) => String(message || '').replace(/^SMS backend \d+:\s*/, '');
// Upper bound on tracked SIDs so a long-running renderer session doesn't
// grow this set forever. Comfortably larger than any single conversation's
// server-side history cap (500 messages).
const MAX_SEEN_INBOUND_IDS = 5000;

export class SmsService {
  constructor() {
    this.conversations = []; // newest-first, from /sms/conversations
    this.state = 'idle'; // 'idle' | 'ready' | 'error'
    this.lastError = null;
    this.callerId = null; // TWILIO_CALLER_ID from the token server
    this.smsFrom = null; // TWILIO_SMS_FROM, else callerId
    this._listeners = new Set();
    this._pollTimer = null;
    // Message SIDs are stable across conversation reordering. Keep this set
    // for the renderer session so each inbound message alerts at most once.
    this._seenInboundMessageIds = new Set();
    this._hasHydrated = false;
    this._photoCache = new Map(); // id -> Promise<Blob>, oldest first
    this._photoCacheBytes = 0;
    this._emit();
  }

  // --- pub/sub ---
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    const snap = this.snapshot();
    this._listeners.forEach((fn) => fn(snap));
  }

  snapshot() {
    return {
      conversations: this.conversations,
      state: this.state,
      hydrated: this._hasHydrated,
      lastError: this.lastError,
      callerId: this.callerId,
      smsFrom: this.smsFrom,
    };
  }

  // --- lifecycle ---

  async start() {
    if (this._pollTimer) return; // already running
    this.lastError = null;
    this.state = 'ready';
    await this._refreshMe().catch(() => {
      // /me is optional; the list payload also carries the numbers.
    });
    await this._refresh().catch((err) => {
      this.lastError = err.message;
      this.state = 'error';
      this._emit();
    });
    this._pollTimer = setInterval(() => {
      this._refresh().catch((err) => {
        // Don't flip to error on a single failed poll — transient
        // network blip is not worth dropping the user into a
        // permanent error state. Just record it.
        this.lastError = err.message;
        this._emit();
      });
    }, POLL_MS);
    this._emit();
  }

  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this.state = 'idle';
    this.conversations = [];
    this.lastError = null;
    this._emit();
  }

  async destroy() {
    this.stop();
    this._listeners.clear();
  }

  async _refresh() {
    if (!window.operator || !window.operator.sms) {
      throw new Error('sms bridge not available (preload not loaded)');
    }
    const res = await window.operator.sms.list();
    if (!res || !res.ok) {
      throw new Error((res && res.error) || 'list failed');
    }
    const conversations = Array.isArray(res.conversations)
      ? res.conversations
      : [];
    this._detectNewInboundMessages(conversations);
    this.conversations = conversations;
    this._applyOperatorNumbers(res);
    this.state = 'ready';
    this.lastError = null;
    this._emit();
  }

  _applyOperatorNumbers(src) {
    if (!src || typeof src !== 'object') return;
    if ('callerId' in src) {
      this.callerId = typeof src.callerId === 'string' ? src.callerId : null;
    }
    if ('smsFrom' in src) {
      this.smsFrom = typeof src.smsFrom === 'string' ? src.smsFrom : null;
    }
  }

  async _refreshMe() {
    if (!window.operator || !window.operator.sms || typeof window.operator.sms.me !== 'function') {
      return;
    }
    const me = await window.operator.sms.me();
    if (!me || !me.ok) return;
    this._applyOperatorNumbers(me);
    this._emit();
  }

  _inboundMessageKey(number, message) {
    if (message && message.sid) return String(message.sid);
    return `${number}:${message?.at || 0}:${message?.body || ''}`;
  }

  _detectNewInboundMessages(conversations) {
    const newMessages = [];
    const currentKeys = new Set();
    for (const conversation of conversations) {
      if (!conversation || !Array.isArray(conversation.messages)) continue;
      for (const message of conversation.messages) {
        if (!message || message.direction !== 'inbound') continue;
        const key = this._inboundMessageKey(conversation.number, message);
        currentKeys.add(key);
        if (this._hasHydrated && !this._seenInboundMessageIds.has(key)) {
          newMessages.push({ ...message, number: conversation.number });
        }
        // Re-inserting an existing key doesn't reorder it in a Set, so
        // delete first — this keeps insertion order equal to
        // last-seen order, making the eviction below a true LRU.
        this._seenInboundMessageIds.delete(key);
        this._seenInboundMessageIds.add(key);
      }
    }

    // Seed the set during initial hydration without alerting for history
    // already present when the renderer session starts.
    this._hasHydrated = true;
    this._pruneSeenInboundMessageIds(currentKeys);
    newMessages.forEach((message) => notifyInboundSms(message));
  }

  _pruneSeenInboundMessageIds(currentKeys) {
    let excess = this._seenInboundMessageIds.size - MAX_SEEN_INBOUND_IDS;
    if (excess <= 0) return;
    // Never evict a SID that's still present in the conversations we
    // just fetched — only drop ones that have aged out of every
    // thread's history, so a message still in view can't be
    // re-notified as "new".
    for (const id of this._seenInboundMessageIds) {
      if (excess <= 0) break;
      if (currentKeys.has(id)) continue;
      this._seenInboundMessageIds.delete(id);
      excess--;
    }
  }

  // --- data fetch ---

  async getThread(number) {
    if (!window.operator || !window.operator.sms) {
      throw new Error('sms bridge not available');
    }
    let res;
    try {
      res = await window.operator.sms.list({ number });
    } catch (e) {
      // Bridge-level failure (IPC down, etc.) — real error.
      throw e;
    }
    if (!res) {
      throw new Error('thread fetch failed: empty response');
    }
    if (!res.ok) {
      // 404 from the server means "no conversation exists for this
      // number yet" — that's the expected state when the user clicks
      // "+ New" with a number that hasn't been texted before. Synthesize
      // an empty thread so the composer works; the first outbound send
      // will create the real conversation on the server.
      const msg = (res.error || '').toLowerCase();
      if (msg.includes('no such conversation') || msg.includes('404')) {
        return {
          number,
          lastMessageAt: 0,
          lastBody: '',
          lastDirection: null,
          messageCount: 0,
          messages: [],
        };
      }
      throw new Error(res.error || 'thread fetch failed');
    }
    // Single-thread responses come back shaped as
    // { ok: true, number, lastMessageAt, ..., messages: [...] }.
    // Strip the ok flag so the caller gets a clean thread object.
    const { ok, ...thread } = res;
    return thread;
  }

  // --- actions ---

  // `media` is a list of photo ids from attachPhoto(); a photo-only message has an empty body.
  async send({ to, body, media }) {
    if (!window.operator || !window.operator.sms) {
      throw new Error('sms bridge not available');
    }
    const res = await window.operator.sms.send({ to, body, ...(media && media.length ? { media } : {}) });
    if (!res || !res.ok) {
      const msg = plainMessage((res && res.error) || 'send failed');
      this.lastError = msg;
      this._emit();
      const error = new Error(msg);
      error.outcome = res?.status === 'failed' ? 'failed' : 'unknown';
      throw error;
    }
    // Refresh right away so the local thread shows the new outbound
    // without waiting for the next poll.
    this._refresh().catch(() => {
      // Refresh failure is non-fatal; next poll will catch up.
    });
    return res;
  }

  async clearThread(number) {
    if (!number || typeof number !== 'string') {
      throw new Error('number is required');
    }
    if (typeof window.operator?.sms?.clear !== 'function') {
      throw new Error('Restart the app to enable authenticated local history clearing.');
    }
    const res = await window.operator.sms.clear({ number });
    if (!res || !res.ok) throw new Error(res?.error || 'Could not clear local history.');
    // Refresh the conversation list so the sidebar preview matches.
    await this._refresh().catch(() => {
      // Non-fatal; next poll will catch up.
    });
    return {
      number: res.number || number,
      lastMessageAt: 0,
      lastBody: '',
      lastDirection: null,
      messageCount: 0,
      messages: [],
    };
  }

  // --- photos ---

  // Keep a chosen file on this computer as a draft attachment. Nothing is
  // uploaded and no link exists until a message that includes it is sent.
  // Resolves { id, type, bytes, width, height, name }.
  async attachPhoto(file) {
    const api = window.operator && window.operator.sms;
    if (!api || typeof api.attach !== 'function') {
      throw new Error('Restart the app to enable photos.');
    }
    if (file.size >= MAX_PHOTO_FILE_BYTES) {
      throw new Error(`${file.name || 'This photo'} is 5 MB or larger. A message can carry under 5 MB in all.`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const res = await api.attach({ name: file.name, bytes });
    if (!res || !res.ok) throw new Error(plainMessage(res && res.error) || 'Could not attach the photo.');
    return res.media;
  }

  // The photo as a Blob (a draft, sent or received photo), kept in a small cache.
  photoBlob(id) {
    const cached = this._photoCache.get(id);
    if (cached) {
      // Most recently used goes last.
      this._photoCache.delete(id);
      this._photoCache.set(id, cached);
      return cached.promise;
    }
    const api = window.operator && window.operator.sms;
    if (!api || typeof api.media !== 'function') {
      return Promise.reject(new Error('photos unavailable'));
    }
    const entry = { size: 0 };
    entry.promise = api.media({ id }).then((res) => {
      if (!res || !res.ok) throw new Error(plainMessage(res && res.error) || 'photo unavailable');
      const blob = new Blob([res.bytes], { type: res.type || 'image/jpeg' });
      entry.size = blob.size;
      this._photoCacheBytes += blob.size;
      this._trimPhotoCache();
      return blob;
    });
    entry.promise.catch(() => {
      if (this._photoCache.get(id) === entry) this._photoCache.delete(id);
    });
    this._photoCache.set(id, entry);
    return entry.promise;
  }

  _trimPhotoCache() {
    for (const [id, entry] of this._photoCache) {
      if (this._photoCacheBytes <= PHOTO_CACHE_BYTES || this._photoCache.size <= 1) break;
      this._photoCache.delete(id);
      this._photoCacheBytes -= entry.size;
    }
  }

  // Remove a photo from a draft. Best effort: a photo that already belongs to a
  // message stays with the message.
  async discardPhoto(id) {
    this._photoCache.delete(id);
    const api = window.operator && window.operator.sms;
    if (!api || typeof api.discardMedia !== 'function') return;
    try {
      await api.discardMedia({ id });
    } catch (_) {
      // The next start's cleanup removes an unlisted draft.
    }
  }

  async prunePhotos(keep) {
    const api = window.operator && window.operator.sms;
    if (!api || typeof api.pruneMedia !== 'function') return;
    try {
      await api.pruneMedia({ keep });
    } catch (_) {
      // Cleanup only; nothing depends on it.
    }
  }

  // What photos to this number would meet (country, sending number, public
  // address, limits), or null when the service cannot say.
  async photoPolicy(to) {
    const api = window.operator && window.operator.sms;
    if (!api || typeof api.photoPolicy !== 'function') return null;
    try {
      const res = await api.photoPolicy({ to });
      return res && res.ok ? res : null;
    } catch (_) {
      return null;
    }
  }
}
