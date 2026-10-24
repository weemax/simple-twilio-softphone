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

  async send({ to, body }) {
    if (!window.operator || !window.operator.sms) {
      throw new Error('sms bridge not available');
    }
    const res = await window.operator.sms.send({ to, body });
    if (!res || !res.ok) {
      const msg = (res && res.error) || 'send failed';
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
}
