// Reading and updating server/.env, the single credential store.
//
// The in-app Twilio setup writes the settings it manages (and nothing else)
// back to this file. Existing lines, comments and unrelated settings stay as
// they are. The file is replaced atomically and always ends up owner-only
// (0600), because it holds the Auth Token and API secret.

const fs = require('fs');
const path = require('path');

// The same format dotenv reads: KEY=value, # comments, optional quotes.
function parseEnvText(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(['"`])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]] = value;
  }
  return out;
}

// { values, exists, mode }. A missing file is an empty one.
function readEnvFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { values: parseEnvText(text), exists: true, text, mode: fs.statSync(file).mode & 0o777 };
  } catch (err) {
    if (err.code === 'ENOENT') return { values: {}, exists: false, text: '', mode: null };
    throw err;
  }
}

function assertSafeValue(key, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid setting name ${key}`);
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
    throw new Error(`${key} must be one line of text`);
  }
}

// Sets `updates` ({ KEY: value }, a null value removes the key) and returns
// the new text; every other line is kept exactly. The last assignment of a
// repeated key wins when the file is read, so that one is replaced and
// earlier duplicates are dropped.
function applyUpdates(text, updates) {
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const pending = new Map(Object.entries(updates));
  for (const [k, v] of pending) if (v !== null) assertSafeValue(k, v);
  const keyOf = (line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return m ? m[1] : null;
  };
  const lastIndex = new Map();
  lines.forEach((line, i) => {
    const k = keyOf(line);
    if (k && pending.has(k)) lastIndex.set(k, i);
  });
  const out = [];
  lines.forEach((line, i) => {
    const k = keyOf(line);
    if (!k || !pending.has(k)) return out.push(line);
    if (lastIndex.get(k) !== i) return; // an earlier duplicate
    const v = pending.get(k);
    if (v !== null) out.push(`${k}=${v}`);
  });
  for (const [k, v] of pending) {
    if (v !== null && !lastIndex.has(k)) out.push(`${k}=${v}`);
  }
  return out.join('\n') + '\n';
}

// Writes the updated file beside the old one and renames it into place.
// Returns { created, tightened }: whether the file is new and whether an
// existing file was readable by others and has been made owner-only.
function updateEnvFile(file, updates) {
  const current = readEnvFile(file);
  const text = applyUpdates(current.text, updates);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return {
    created: !current.exists,
    tightened: current.exists && (current.mode & 0o077) !== 0,
  };
}

module.exports = { parseEnvText, readEnvFile, applyUpdates, updateEnvFile };
