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

const POLL_MS = 3000;

export class SmsService {
  constructor() {
    this.conversations = []; // newest-first, from /sms/conversations
    this.state = 'idle'; // 'idle' | 'ready' | 'error'
    this.lastError = null;
    this._listeners = new Set();
    this._pollTimer = null;
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
      lastError: this.lastError,
    };
  }

  // --- lifecycle ---

  async start() {
    if (this._pollTimer) return; // already running
    this.lastError = null;
    this.state = 'ready';
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
    this.conversations = Array.isArray(res.conversations)
      ? res.conversations
      : [];
    this.state = 'ready';
    this.lastError = null;
    this._emit();
  }

  // --- data fetch ---

  async getThread(number) {
    if (!window.operator || !window.operator.sms) {
      throw new Error('sms bridge not available');
    }
    const res = await window.operator.sms.list({ number });
    if (!res || !res.ok) {
      throw new Error((res && res.error) || 'thread fetch failed');
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
      throw new Error(msg);
    }
    // Refresh right away so the local thread shows the new outbound
    // without waiting for the next poll.
    this._refresh().catch(() => {
      // Refresh failure is non-fatal; next poll will catch up.
    });
    return res;
  }
}
