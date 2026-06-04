// Non-secret app config (last selected phone number, identity, UI prefs).
// Stored as plaintext JSON — never put Twilio credentials here.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

function read() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function write(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), {
    mode: 0o600,
  });
}

function get(key) {
  const cfg = read();
  return key ? cfg[key] : cfg;
}

function set(key, value) {
  const cfg = read();
  cfg[key] = value;
  write(cfg);
  return cfg[key];
}

function clear(key) {
  const cfg = read();
  if (key) {
    delete cfg[key];
  } else {
    // No key → wipe entire file.
    Object.keys(cfg).forEach((k) => delete cfg[k]);
  }
  write(cfg);
}

module.exports = { get, set, clear, CONFIG_FILE };
