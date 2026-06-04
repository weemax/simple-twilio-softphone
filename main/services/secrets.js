// Encrypted credential storage using Electron's safeStorage API.
// Falls back to a plaintext file with a clear warning if safeStorage is
// unavailable (Linux without a keyring, for example).

const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const STORE_DIR = path.join(app.getPath('userData'), 'secrets');
const STORE_FILE = path.join(STORE_DIR, 'store.json');

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  }
}

function readStore() {
  ensureDir();
  if (!fs.existsSync(STORE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(store) {
  ensureDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), {
    mode: 0o600,
  });
}

function isAvailable() {
  // safeStorage.isEncryptionAvailable() returns true when there's a keyring
  // (macOS Keychain, Windows DPAPI, libsecret on Linux).
  return safeStorage.isEncryptionAvailable();
}

function setSecret(key, value) {
  if (!key || typeof key !== 'string') {
    throw new Error('setSecret: key must be a non-empty string');
  }
  if (value === undefined || value === null) {
    return clearSecret(key);
  }
  const store = readStore();
  if (isAvailable()) {
    store[key] = {
      kind: 'encrypted',
      data: safeStorage.encryptString(String(value)).toString('base64'),
    };
  } else {
    // Plaintext fallback — surface this loudly in the renderer via status.
    store[key] = { kind: 'plaintext', data: String(value) };
    console.warn(
      '[secrets] safeStorage unavailable — secret stored in plaintext at',
      STORE_FILE
    );
  }
  writeStore(store);
  return { encrypted: isAvailable() };
}

function getSecret(key) {
  const store = readStore();
  const entry = store[key];
  if (!entry) return null;
  if (entry.kind === 'encrypted') {
    if (!isAvailable()) {
      throw new Error('Secret was encrypted but safeStorage is unavailable');
    }
    return safeStorage.decryptString(Buffer.from(entry.data, 'base64'));
  }
  return entry.data;
}

function clearSecret(key) {
  const store = readStore();
  delete store[key];
  writeStore(store);
}

function clearAll() {
  writeStore({});
}

module.exports = {
  setSecret,
  getSecret,
  clearSecret,
  clearAll,
  isAvailable,
  STORE_FILE,
};
