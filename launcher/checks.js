// What `npm run phone` checks before it starts anything, and the HTTP reads
// it uses to tell when each part is actually ready.

const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

// The settings the service needs to sign tokens and send texts. Without them
// it still starts, and the app opens on Settings → Twilio account, whose
// reviewed setup writes them to server/.env.
const REQUIRED_SETTINGS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY',
  'TWILIO_API_SECRET',
  'TWILIO_TWIML_APP_SID',
];

// Missing packages, each with the command that installs them.
function missingInstalls(projectDir) {
  const problems = [];
  const has = (p) => fs.existsSync(path.join(projectDir, p));
  if (
    !has('node_modules/react-scripts/package.json') ||
    !has('node_modules/electron/package.json')
  ) {
    problems.push({
      what: "The app's packages are not installed.",
      fix: 'npm install',
    });
  } else if (!electronExecutable(projectDir)) {
    problems.push({
      what: "Electron's download did not finish, so the desktop app cannot open.",
      fix: 'rm -rf node_modules/electron && npm install',
    });
  }
  if (
    !has('server/node_modules/twilio/package.json') ||
    !has('server/node_modules/dotenv/package.json')
  ) {
    problems.push({
      what: "The local service's packages are not installed.",
      fix: 'npm install --prefix server',
    });
  }
  return problems;
}

// The Electron binary the project installed, or null.
function electronExecutable(projectDir) {
  try {
    const dir = path.join(projectDir, 'node_modules/electron');
    const rel = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim();
    const exe = path.join(dir, 'dist', rel);
    return fs.existsSync(exe) ? exe : null;
  } catch (_) {
    return null;
  }
}

function parseEnvFile(text) {
  // The same format dotenv reads: KEY=value, # comments, optional quotes.
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

// The service's settings as server/server.js will see them: server/.env,
// with anything already in the environment taking precedence (dotenv never
// overrides). Returns the problems that stop a launch and the notes worth
// reading before calling anyone. Missing Twilio settings are a note, not a
// problem: the in-app setup is how a first launch gets them.
function readServiceSettings(envFile, env) {
  let fileValues = {};
  let fileExists = false;
  try {
    fileValues = parseEnvFile(fs.readFileSync(envFile, 'utf8'));
    fileExists = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const value = (k) => (env[k] !== undefined && env[k] !== '' ? env[k] : fileValues[k]) || '';
  const missing = REQUIRED_SETTINGS.filter((k) => !value(k));
  const problems = [];
  const notes = [];
  if (missing.length) {
    notes.push(
      `Twilio is not connected yet (${fileExists ? `server/.env is missing ${missing.join(', ')}` : 'server/.env does not exist'}). ` +
        'The app opens on Settings → Twilio account to connect it; calls and texts need that first.'
    );
  } else {
    if (!value('TWILIO_AUTH_TOKEN')) {
      notes.push(
        'TWILIO_AUTH_TOKEN is not set in server/.env, so the service refuses incoming calls, incoming texts and delivery updates.'
      );
    }
    if (!value('TWILIO_CALLER_ID')) {
      notes.push('TWILIO_CALLER_ID is not set in server/.env, so outgoing calls fail.');
    }
    if (!value('OPERATOR_IDENTITY')) {
      notes.push('OPERATOR_IDENTITY is not set in server/.env, so incoming calls cannot ring this app.');
    }
  }
  const port = parseInt(fileValues.PORT || '', 10);
  return {
    problems,
    notes,
    port: Number.isInteger(port) && port > 0 ? port : null,
    publicBaseUrl: value('PUBLIC_BASE_URL') || value('SMS_PUBLIC_BASE_URL') || null,
  };
}

function canListen(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve(err.code !== 'EADDRINUSE' && err.code !== 'EACCES'));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

function answersOn(port, host = '127.0.0.1', timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Who is listening on `port`, as far as lsof can tell; null when unknown.
function portOccupant(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = /^p(\d+)$/m.exec(out);
    const command = /^c(.+)$/m.exec(out);
    return pid ? { pid: Number(pid[1]), command: command ? command[1] : 'a program' } : null;
  } catch (_) {
    return null;
  }
}

// Null when `port` is free, otherwise who holds it (when known).
async function portInUse(port, host) {
  const free = (await canListen(port, host)) && !(await answersOn(port));
  if (free) return null;
  return { port, occupant: portOccupant(port) };
}

// GET `url`; resolves { status, body, json } or rejects on a network error.
function get(url, { timeoutMs = 3000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(parsed, { headers, timeout: timeoutMs, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size <= 256 * 1024) chunks.push(c);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(body);
        } catch (_) {
          // not JSON
        }
        resolve({ status: res.statusCode, body, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs / 1000} seconds`)));
    req.on('error', reject);
  });
}

// Calls `probe` until it returns a truthy value, `stopped()` returns a
// reason, or the deadline passes. Each attempt is a real check; the short
// pause between them only spaces the checks out.
async function waitUntil(probe, { timeoutMs, stopped = () => null, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    const reason = stopped();
    if (reason) return { ok: false, reason };
    try {
      const value = await probe();
      if (value) return { ok: true, value };
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      return { ok: false, timedOut: true, lastError };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = {
  REQUIRED_SETTINGS,
  missingInstalls,
  electronExecutable,
  parseEnvFile,
  readServiceSettings,
  portInUse,
  portOccupant,
  get,
  waitUntil,
};
