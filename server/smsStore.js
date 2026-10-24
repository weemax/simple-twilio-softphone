// SMS conversation store.
//
// Simple JSON-backed key/value store keyed by E.164 phone number.
// One "conversation" per number — flat message list, no threading.
//
// File layout at <userData or server dir>/sms-store.json:
//   {
//     "+15555550100": {
//       "number": "+15555550100",
//       "lastMessageAt": 1718046000000,
//       "lastBody": "ok sounds good",
//       "messages": [
//         { "sid": "SM...", "direction": "inbound",  "body": "...",
//           "at": 1718045900000, "status": "received" },
//         { "sid": "SM...", "direction": "outbound", "body": "...",
//           "at": 1718046000000, "status": "sent" }
//       ]
//     }
//   }
//
// Concurrency: a single in-process mutex serializes writes. This is fine
// for a single-user desktop app where the only writers are the inbound
// webhook and outbound send handler, both on the same Node process.
// Atomicity: writes go to <file>.tmp then rename — POSIX rename is atomic
// within a filesystem, so a crash mid-write leaves the previous file intact.

const fs = require('fs');
const path = require('path');

const MAX_MESSAGES_PER_THREAD = 500; // hard cap to keep the file small
const MAX_BODY_LENGTH = 1600; // Twilio Programmable SMS hard limit

// What a stored photo entry may carry. `state`: ready (a stored JPEG/PNG),
// pending (an incoming photo still downloading) or unavailable (it will not
// show, with a `reason` the renderer words for the person).
const MEDIA_STATES = new Set(['ready', 'pending', 'unavailable']);
function cleanMedia(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && typeof m.id === 'string' && /^[a-f0-9]{32}$/.test(m.id))
    .slice(0, 11)
    .map((m) => {
      const out = { id: m.id, state: MEDIA_STATES.has(m.state) ? m.state : 'ready' };
      if (out.state === 'ready') {
        out.type = m.type === 'image/png' ? 'image/png' : 'image/jpeg';
        for (const k of ['bytes', 'width', 'height']) out[k] = Number(m[k]) || 0;
        if (typeof m.name === 'string') out.name = m.name.slice(0, 80);
      } else if (out.state === 'unavailable') {
        out.reason = typeof m.reason === 'string' ? m.reason.slice(0, 40) : 'unavailable';
      }
      if (typeof m.contentType === 'string') out.contentType = m.contentType.slice(0, 80);
      return out;
    });
}
const mediaIds = (messages) =>
  messages.flatMap((m) => (Array.isArray(m.media) ? m.media.map((x) => x.id) : []));

class SmsStore {
  // `onRelease(ids)` is called after photos stop belonging to any stored
  // message (history cleared, oldest messages dropped), so their files can go.
  constructor(filePath, { onRelease = () => {} } = {}) {
    this.onRelease = onRelease;
    this.filePath = filePath;
    this.tmpPath = filePath + '.tmp';
    this._mu = Promise.resolve(); // mutex chain
    this._data = this._load();
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      // Corrupt file — don't lose messages silently. Rename aside and
      // start fresh; the user can recover from the .bak if needed.
      const bak = this.filePath + '.corrupt-' + Date.now();
      try {
        fs.renameSync(this.filePath, bak);
        console.error(
          `[sms-store] corrupt store, moved to ${bak}: ${err.message}`
        );
      } catch (_) {
        console.error(`[sms-store] corrupt store, could not move aside: ${err.message}`);
      }
      return {};
    }
  }

  _persist() {
    const text = JSON.stringify(this._data, null, 2);
    fs.writeFileSync(this.tmpPath, text, { mode: 0o600 });
    fs.renameSync(this.tmpPath, this.filePath);
  }

  // Run `fn` while holding the write lock. Returns fn's result.
  _withLock(fn) {
    const next = this._mu.then(() => fn());
    // Swallow errors in the chain itself so one failure doesn't poison
    // the next caller. fn's own errors propagate via the returned promise.
    this._mu = next.catch(() => {});
    return next;
  }

  // --- query ---

  listConversations() {
    // Newest activity first. Read-only — no lock needed because we return
    // a shallow clone of the underlying objects.
    return Object.values(this._data)
      .map((c) => ({
        number: c.number,
        lastMessageAt: c.lastMessageAt || 0,
        lastBody: c.lastBody || '',
        lastDirection: c.lastDirection || null,
        lastMediaCount: lastMediaCount(c),
        messageCount: c.messages.length,
        messages: c.messages.slice(), // copy so caller can't mutate
      }))
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  getConversation(number) {
    const key = normalizeNumber(number);
    if (!key) return null;
    const c = this._data[key];
    if (!c) return null;
    return {
      number: c.number,
      lastMessageAt: c.lastMessageAt || 0,
      lastBody: c.lastBody || '',
      lastDirection: c.lastDirection || null,
      lastMediaCount: lastMediaCount(c),
      messageCount: c.messages.length,
      messages: c.messages.slice(),
    };
  }

  // The photo ids held by messages to `number` that are confirmed failed: the
  // only sent photos a reviewed resend may use again.
  failedMediaIds(number) {
    const key = normalizeNumber(number);
    const conv = key && this._data[key];
    if (!conv) return new Set();
    return new Set(
      mediaIds(
        conv.messages.filter((m) => m.direction === 'outbound' && ['failed', 'undelivered'].includes(m.status))
      )
    );
  }

  // Every photo id some stored message holds.
  referencedMediaIds() {
    return new Set(Object.values(this._data).flatMap((c) => mediaIds(c.messages)));
  }

  // Tell onRelease about photos no stored message holds any more.
  _release(candidateIds) {
    if (!candidateIds.length) return;
    const held = this.referencedMediaIds();
    const gone = candidateIds.filter((id) => !held.has(id));
    if (gone.length) {
      try {
        this.onRelease(gone);
      } catch (err) {
        console.error(`[sms-store] could not release photos: ${err.message}`);
      }
    }
  }

  // --- mutation ---

  appendMessage({ number, sid, direction, body, at, status, media }) {
    const key = normalizeNumber(number);
    if (!key) {
      return Promise.reject(new Error('invalid phone number'));
    }
    const safeBody = String(body || '').slice(0, MAX_BODY_LENGTH);
    const ts = typeof at === 'number' && Number.isFinite(at) ? at : Date.now();
    const safeStatus = String(status || (direction === 'outbound' ? 'sent' : 'received'));
    const safeSid = sid ? String(sid) : `local-${ts}-${Math.random().toString(36).slice(2, 8)}`;
    const safeMedia = cleanMedia(media);

    return this._withLock(() => {
      let evicted = [];
      let conv = this._data[key];
      if (!conv) {
        conv = {
          number: key,
          lastMessageAt: 0,
          lastBody: '',
          lastDirection: null,
          messages: [],
        };
        this._data[key] = conv;
      }
      const msg = {
        sid: safeSid,
        direction: direction === 'outbound' ? 'outbound' : 'inbound',
        body: safeBody,
        at: ts,
        status: safeStatus,
      };
      if (safeMedia.length) {
        msg.media = safeMedia;
        if (msg.direction === 'outbound') msg.mms = true;
      }
      conv.messages.push(msg);
      // Cap the per-thread history. Drop oldest first.
      if (conv.messages.length > MAX_MESSAGES_PER_THREAD) {
        evicted = mediaIds(conv.messages.splice(0, conv.messages.length - MAX_MESSAGES_PER_THREAD));
      }
      conv.lastMessageAt = ts;
      conv.lastBody = safeBody;
      conv.lastDirection = msg.direction;
      this._persist();
      this._release(evicted);
      return { ...conv, messages: conv.messages.slice() };
    });
  }

  // Wipe every message in a thread. Keeps the conversation entry so the
  // number stays in the list and a later send/inbound can reuse it.
  clearConversation(number) {
    const key = normalizeNumber(number);
    if (!key) {
      return Promise.reject(new Error('invalid phone number'));
    }
    return this._withLock(() => {
      const conv = this._data[key];
      if (!conv) {
        return { cleared: false, number: key };
      }
      const dropped = mediaIds(conv.messages);
      conv.messages = [];
      conv.lastMessageAt = 0;
      conv.lastBody = '';
      conv.lastDirection = null;
      this._persist();
      this._release(dropped);
      return {
        cleared: true,
        number: key,
        lastMessageAt: 0,
        lastBody: '',
        lastDirection: null,
        messageCount: 0,
        messages: [],
      };
    });
  }

  // For tests / future "mark read".
  markRead(number) {
    const key = normalizeNumber(number);
    if (!key || !this._data[key]) return Promise.resolve(false);
    return this._withLock(() => {
      // No explicit "unread" field yet; placeholder hook for v2.
      this._persist();
      return true;
    });
  }

  // Update a message's status by its Twilio SID. Used by the status
  // callback handler. Scans all conversations (linear; O(threads*500)
  // worst case — fine for our scale). Returns true if a message was
  // updated, false if no message with that SID exists yet.
  updateMessageBySid({ sid, status }) {
    if (!sid || !status) {
      return Promise.resolve(false);
    }
    const newStatus = String(status).toLowerCase();
    return this._withLock(() => {
      for (const conv of Object.values(this._data)) {
        const m = conv.messages.find((x) => x.sid === sid);
        if (m) {
          m.status = newStatus;
          this._persist();
          return true;
        }
      }
      return false;
    });
  }

  // Change one photo entry of a message (found by the message's SID and the
  // photo's id): a download finished or failed. Returns false when the message
  // is no longer stored (the thread was cleared meanwhile), so the caller can
  // drop what it downloaded.
  updateMedia({ sid, id, patch }) {
    return this._withLock(() => {
      for (const conv of Object.values(this._data)) {
        const m = conv.messages.find((x) => x.sid === sid);
        const entry = m && Array.isArray(m.media) ? m.media.find((x) => x.id === id) : null;
        if (entry) {
          const [next] = cleanMedia([{ ...patch, id }]);
          for (const k of Object.keys(entry)) delete entry[k];
          Object.assign(entry, next);
          this._persist();
          return true;
        }
      }
      return false;
    });
  }

  // Photos still downloading when the service stopped will not finish.
  failPendingMedia() {
    let changed = false;
    for (const conv of Object.values(this._data)) {
      for (const m of conv.messages) {
        for (const entry of m.media || []) {
          if (entry.state === 'pending') {
            entry.state = 'unavailable';
            entry.reason = 'interrupted';
            changed = true;
          }
        }
      }
    }
    if (changed) this._persist();
    return changed;
  }
}

function lastMediaCount(conv) {
  const last = conv.messages[conv.messages.length - 1];
  return last && Array.isArray(last.media) ? last.media.length : 0;
}

// E.164 normalization. We accept whatever the caller passes, strip
// everything that isn't a digit, then re-prepend '+'. This is good enough
// for matching Twilio's `From`/`To` (which are always E.164 with leading
// '+'), and forgiving enough for typed input.
function normalizeNumber(input) {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return '+' + digits;
}

module.exports = { SmsStore, normalizeNumber, MAX_BODY_LENGTH };
