// The run lock: one `npm run phone` per project at a time.
//
// The lock is a file created with its whole content in one step (written
// beside it, then hard-linked into place, which fails if the file already
// exists), so a second launch either creates it or reads a complete record
// of the run that holds it. The holder rewrites it (write, then rename) as
// it starts each process, so the record always names what it owns.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { stillRunning, ownedGroupRunning } = require('./processes');

const LOCK_NAME = 'run.json';

function lockPath(runDir) {
  return path.join(runDir, LOCK_NAME);
}

function ensureRunDir(runDir) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
}

function tmpName(file) {
  return `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

function writeAtomic(file, data) {
  const tmp = tmpName(file);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function createExclusive(file, data) {
  const tmp = tmpName(file);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// The record in the lock, or null when there is none. A lock that cannot be
// parsed was not written by a launcher (they never leave a partial file).
function readLock(runDir) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(runDir), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { unreadable: true };
  }
}

// What holds the lock: 'none', 'running' (a live launcher), 'leftovers'
// (its launcher is gone but processes it started are still running) or
// 'stale' (nothing it started is left).
function inspect(runDir) {
  const existing = readLock(runDir);
  if (!existing) return { state: 'none' };
  if (existing.unreadable) return { state: 'stale', existing };
  if (stillRunning(existing.launcher)) return { state: 'running', existing };
  const leftovers = (existing.children || []).filter(ownedGroupRunning);
  if (leftovers.length) return { state: 'leftovers', existing, leftovers };
  return { state: 'stale', existing };
}

// Removes the lock only if it is still the one that was inspected.
function removeIfUnchanged(runDir, existing) {
  const now = readLock(runDir);
  if (!now) return;
  const same = existing.unreadable
    ? now.unreadable
    : now.launchId && now.launchId === existing.launchId;
  if (same) fs.rmSync(lockPath(runDir), { force: true });
}

// Takes the lock for `record`. Clears a stale lock (and says so); refuses
// while a launcher, or what an earlier one started, is still running.
function acquire(runDir, record) {
  ensureRunDir(runDir);
  let cleared = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (createExclusive(lockPath(runDir), record)) {
      return { ok: true, cleared };
    }
    const found = inspect(runDir);
    if (found.state === 'running' || found.state === 'leftovers') {
      return { ok: false, ...found };
    }
    if (found.state === 'stale') {
      removeIfUnchanged(runDir, found.existing);
      cleared = found.existing;
    }
  }
  return { ok: false, state: 'contended' };
}

function update(runDir, record) {
  writeAtomic(lockPath(runDir), record);
}

// Releases the lock if this launch still holds it.
function release(runDir, launchId) {
  const now = readLock(runDir);
  if (now && !now.unreadable && now.launchId === launchId) {
    fs.rmSync(lockPath(runDir), { force: true });
  }
}

module.exports = {
  acquire,
  inspect,
  update,
  release,
  readLock,
  removeIfUnchanged,
  writeAtomic,
  lockPath,
  ensureRunDir,
};
