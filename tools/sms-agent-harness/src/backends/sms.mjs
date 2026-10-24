// Backend A: real SMS through the local softphone server.
//
// The operator's number texts the agent's number and we read the thread back.
// Nothing here knows about the platform: the agent under test sees an ordinary
// inbound SMS, which is the whole point of this backend.
//
// Endpoints (server/server.js): POST /sms/send, GET /sms/conversations?number=

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SmsBackend {
  static label = 'real SMS end-to-end';

  constructor({ baseUrl = 'http://127.0.0.1:5050', target, pollMs = 3000 } = {}) {
    if (!target) throw new Error('SmsBackend needs the agent phone number (target)');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.target = target;
    this.pollMs = pollMs;
    this.seen = new Set();
  }

  async health() {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`token server unhealthy: ${res.status}`);
  }

  /** Inbound messages on the thread, oldest first. */
  async #inbound() {
    const url = `${this.baseUrl}/sms/conversations?number=${encodeURIComponent(this.target)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET /sms/conversations failed: ${res.status}`);
    const body = await res.json();
    const messages = body.messages ?? body.conversation?.messages ?? [];
    return messages.filter((m) => (m.direction ?? '').startsWith('in'));
  }

  /**
   * Everything already on the thread is pre-existing. Called after a reset so a
   * stale reply from the previous case cannot be attributed to this one.
   */
  async markBaseline() {
    for (const m of await this.#inbound()) this.seen.add(m.sid ?? m.id ?? JSON.stringify(m));
  }

  async send(body) {
    const res = await fetch(`${this.baseUrl}/sms/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: this.target, body }),
    });
    if (!res.ok) throw new Error(`POST /sms/send failed: ${res.status} ${await res.text()}`);
  }

  /**
   * Wait for the agent's turn to finish.
   *
   * Two windows, and the difference matters. `timeout` is how long to wait for
   * the FIRST message; expiring it means no reply, which is a result, not an
   * error. `settle` is how long to wait for quiet after that; agents send
   * bursts, and judging the first message of a burst is the most common
   * false-fail in SMS agent testing.
   */
  async collect({ timeout, settle }) {
    const started = Date.now();
    const received = [];
    let lastAt = null;

    for (;;) {
      for (const m of await this.#inbound()) {
        const key = m.sid ?? m.id ?? JSON.stringify(m);
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        received.push(m.body ?? '');
        lastAt = Date.now();
      }

      const elapsed = (Date.now() - started) / 1000;
      if (received.length === 0) {
        if (elapsed >= timeout) return { received, waited: Math.round(elapsed) };
      } else if ((Date.now() - lastAt) / 1000 >= settle) {
        return { received, waited: Math.round(elapsed) };
      }
      await sleep(this.pollMs);
    }
  }

  /** Real SMS cannot intercept the platform's function calls. */
  get toolCalls() { return []; }
  supportsStubs() { return false; }
}
