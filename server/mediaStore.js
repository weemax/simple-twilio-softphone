// Photo storage for text messages: the files and the 24-hour public links.
//
// Layout in <dir> (the folder is owner-only, files are 0600):
//   <id>.bin        the photo's bytes, exactly as attached or received
//   media-index.json
//     { items: { <id>: { id, kind, type, bytes, width, height, name, createdAt } },
//       links: { <sha256 of token>: { id, expiresAt } } }
//
// Kinds:
//   draft    attached in the composer. Local only: no link exists and nothing
//            has been sent anywhere.
//   message  belongs to a stored message: sent by Operator, or received.
//
// A public link is created only by mintLink(), which the send route calls for
// the photos of a message the person explicitly sent. A link is a random
// 256-bit token that answers for that one photo until it expires (24 hours);
// only the token's hash is stored. A link cannot be derived from a photo id or
// from another link, and nothing here lists photos or links.
//
// Ids are 32 lowercase hex characters and are the only thing that ever becomes
// part of a file name, so no caller-supplied text can reach another path.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { inspectImage, EXTENSIONS } = require('./imageCheck');

const LINK_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DRAFTS = 100;
const ID_PATTERN = /^[a-f0-9]{32}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

class MediaError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'MediaError';
    this.status = status;
  }
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// A display name only: no path, no control characters, bounded.
function cleanName(value) {
  const base = String(value || '')
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return base.slice(0, 80);
}

class MediaStore {
  constructor({ dir, now = Date.now, linkTtlMs = LINK_TTL_MS, log = () => {} }) {
    this.dir = dir;
    this.now = now;
    this.linkTtlMs = linkTtlMs;
    this.log = log;
    this.indexPath = path.join(dir, 'media-index.json');
    this._cleanIndex = true;
    this._index = this._load();
  }

  _load() {
    const empty = { items: {}, links: {} };
    if (!fs.existsSync(this.indexPath)) return empty;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      return {
        items: parsed && typeof parsed.items === 'object' && parsed.items ? parsed.items : {},
        links: parsed && typeof parsed.links === 'object' && parsed.links ? parsed.links : {},
      };
    } catch (err) {
      // Do not lose photos silently, and do not delete files we can no longer account for.
      this._cleanIndex = false;
      try {
        fs.renameSync(this.indexPath, `${this.indexPath}.corrupt-${this.now()}`);
      } catch (_) {
        // could not move it aside
      }
      console.error(`[sms-media] corrupt media index, started a new one: ${err.message}`);
      return empty;
    }
  }

  // The folder is made when the first photo is stored, not when the service starts.
  _ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.dir, 0o700);
    } catch (_) {
      // not ours to change
    }
  }

  _persist() {
    this._ensureDir();
    const tmp = `${this.indexPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._index), { mode: 0o600 });
    fs.renameSync(tmp, this.indexPath);
  }

  _file(id) {
    if (!ID_PATTERN.test(id)) throw new MediaError(400, 'invalid photo id');
    return path.join(this.dir, `${id}.bin`);
  }

  static newId() {
    return crypto.randomBytes(16).toString('hex');
  }

  static isId(value) {
    return typeof value === 'string' && ID_PATTERN.test(value);
  }

  static isToken(value) {
    return typeof value === 'string' && TOKEN_PATTERN.test(value);
  }

  // Ids of every stored photo of a kind.
  ids(kind) {
    return Object.values(this._index.items)
      .filter((i) => i.kind === kind)
      .map((i) => i.id);
  }

  _publicMeta(item) {
    const { id, type, bytes, width, height, name } = item;
    return { id, type, bytes, width, height, name };
  }

  // The photo's description, or null when it is not stored.
  get(id) {
    if (!ID_PATTERN.test(id || '')) return null;
    const item = this._index.items[id];
    return item ? { ...item } : null;
  }

  read(id) {
    const item = this.get(id);
    if (!item) return null;
    try {
      return { meta: item, bytes: fs.readFileSync(this._file(id)) };
    } catch (_) {
      return null;
    }
  }

  // Check `bytes` really is a JPEG or PNG within the size limit, then store it.
  // Returns the public description. `kind` is 'draft' (attached in the
  // composer) or 'message' (received); `id` lets a received photo keep the id
  // its pending placeholder already has.
  add({ bytes, name, kind = 'draft', id = MediaStore.newId() }) {
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new MediaError(400, 'The photo is empty.');
    if (bytes.length >= MAX_FILE_BYTES) {
      throw new MediaError(413, 'This photo is 5 MB or larger. A message can carry under 5 MB in all.');
    }
    const found = inspectImage(bytes);
    if (!found.ok) throw new MediaError(415, found.reason);
    if (kind === 'draft') {
      const drafts = Object.values(this._index.items).filter((i) => i.kind === 'draft').length;
      if (drafts >= MAX_DRAFTS) {
        throw new MediaError(409, 'Too many photos are waiting to be sent. Remove some first.');
      }
    }
    const file = this._file(id);
    this._ensureDir();
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const item = {
      id,
      kind,
      type: found.type,
      bytes: bytes.length,
      width: found.width,
      height: found.height,
      name: cleanName(name) || `photo.${EXTENSIONS[found.type]}`,
      createdAt: this.now(),
    };
    this._index.items[id] = item;
    this._persist();
    return this._publicMeta(item);
  }

  // The send route takes ownership of draft photos once a message exists for them.
  claim(ids) {
    let changed = false;
    for (const id of ids) {
      const item = this._index.items[id];
      if (item && item.kind === 'draft') {
        item.kind = 'message';
        changed = true;
      }
    }
    if (changed) this._persist();
  }

  // Removing a photo from a draft deletes it. A photo that belongs to a
  // message is not touched here (the message owns it).
  discardDraft(id) {
    const item = ID_PATTERN.test(id || '') ? this._index.items[id] : null;
    if (!item || item.kind !== 'draft') return false;
    this._remove(id);
    this._persist();
    return true;
  }

  // Delete drafts the app no longer lists. `keep` is every draft id the app
  // still has; a draft younger than graceMs is kept regardless (it may be
  // attached a moment from now).
  pruneDrafts(keep, graceMs = 10 * 60 * 1000) {
    const keepSet = new Set(keep);
    let removed = 0;
    for (const item of Object.values(this._index.items)) {
      if (item.kind === 'draft' && !keepSet.has(item.id) && this.now() - item.createdAt >= graceMs) {
        this._remove(item.id);
        removed++;
      }
    }
    if (removed) this._persist();
    return removed;
  }

  // The messages that held these photos are gone. Files and links go with them.
  deleteMessagePhotos(ids) {
    let removed = 0;
    for (const id of ids) {
      const item = ID_PATTERN.test(id || '') ? this._index.items[id] : null;
      if (item && item.kind === 'message') {
        this._remove(id);
        removed++;
      }
    }
    if (removed) this._persist();
    return removed;
  }

  _remove(id) {
    delete this._index.items[id];
    for (const [hash, link] of Object.entries(this._index.links)) {
      if (link.id === id) delete this._index.links[hash];
    }
    try {
      fs.unlinkSync(this._file(id));
    } catch (_) {
      // already gone
    }
  }

  // --- public links ---

  // A new link for a stored photo; returns the token (the only time it exists
  // in the clear) and when it stops working.
  mintLink(id) {
    if (!this._index.items[id]) throw new MediaError(404, 'photo not found');
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.linkTtlMs;
    this._index.links[hashToken(token)] = { id, expiresAt };
    this._persist();
    return { token, expiresAt };
  }

  revokeLinks(ids) {
    const set = new Set(ids);
    let removed = 0;
    for (const [hash, link] of Object.entries(this._index.links)) {
      if (set.has(link.id)) {
        delete this._index.links[hash];
        removed++;
      }
    }
    if (removed) this._persist();
    return removed;
  }

  // { ok: true, meta, bytes } | { ok: false, status: 404 | 410 }. Anything that
  // is not a well-formed token is a plain 404 and touches nothing.
  resolveLink(token) {
    if (!MediaStore.isToken(token)) return { ok: false, status: 404 };
    const hash = hashToken(token);
    const link = this._index.links[hash];
    if (!link) return { ok: false, status: 404 };
    if (link.expiresAt <= this.now()) {
      delete this._index.links[hash];
      this._persist();
      return { ok: false, status: 410 };
    }
    const found = this.read(link.id);
    if (!found) return { ok: false, status: 404 };
    return { ok: true, ...found };
  }

  pruneExpiredLinks() {
    let removed = 0;
    for (const [hash, link] of Object.entries(this._index.links)) {
      if (link.expiresAt <= this.now()) {
        delete this._index.links[hash];
        removed++;
      }
    }
    if (removed) this._persist();
    return removed;
  }

  // At start: drop files nothing refers to (a draft removed in a crash, a
  // download that never finished), and links to photos that are gone. Only
  // when the index loaded cleanly, so a damaged index never deletes photos.
  reconcile() {
    let changed = false;
    for (const [hash, link] of Object.entries(this._index.links)) {
      if (!this._index.items[link.id]) {
        delete this._index.links[hash];
        changed = true;
      }
    }
    for (const item of Object.values(this._index.items)) {
      let exists = true;
      try {
        fs.accessSync(this._file(item.id));
      } catch (_) {
        exists = false;
      }
      if (!exists) {
        delete this._index.items[item.id];
        changed = true;
      }
    }
    if (this._cleanIndex) {
      let names = [];
      try {
        names = fs.readdirSync(this.dir);
      } catch (_) {
        names = [];
      }
      for (const name of names) {
        const m = /^([a-f0-9]{32})\.bin$/.exec(name);
        if (m && !this._index.items[m[1]]) {
          try {
            fs.unlinkSync(path.join(this.dir, name));
          } catch (_) {
            // leave it
          }
        }
      }
    }
    if (changed) this._persist();
  }
}

module.exports = { MediaStore, MediaError, LINK_TTL_MS, MAX_FILE_BYTES, MAX_DRAFTS };
