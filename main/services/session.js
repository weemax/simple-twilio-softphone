// Connection status for the renderer's Connection view and status strip.
//
// Two separate facts, kept apart:
//   - the local service: checked live with GET /health on every request;
//   - the public tunnel: what `npm run phone` found (launcher/supervisor.js
//     writes it to the file named by OPERATOR_SESSION_FILE). An app started
//     some other way (npm start) has no such file, and says so instead of
//     guessing.
// Voice registration, the SMS sender and the Twilio account are reported by
// their own parts of the renderer.

const fs = require('fs');
const http = require('http');
const { URL } = require('url');

const SERVICE_BASE = process.env.SMS_BACKEND_URL || 'http://127.0.0.1:5050';
const TUNNEL_STATES = new Set(['starting', 'started', 'ready', 'unreachable', 'unavailable', 'lost']);

function readSessionFile(file) {
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && typeof data.launchId === 'string' ? data : null;
  } catch (_) {
    return null;
  }
}

function getHealth(base, timeoutMs) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL('/health', base);
    } catch (_) {
      return resolve({ reachable: false, error: `invalid service address ${base}` });
    }
    const req = http.get(url, { timeout: timeoutMs, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_) {
          // not the service's JSON
        }
        const ok = res.statusCode === 200 && body && body.ok === true;
        resolve(
          ok
            ? { reachable: true, launch: typeof body.launch === 'string' ? body.launch : null }
            : { reachable: false, error: `unexpected answer (HTTP ${res.statusCode})` }
        );
      });
    });
    req.on('timeout', () => req.destroy(new Error('no answer')));
    req.on('error', (err) => resolve({ reachable: false, error: err.message }));
  });
}

function tunnelFrom(session) {
  const t = session && session.tunnel && typeof session.tunnel === 'object' ? session.tunnel : {};
  const state = TUNNEL_STATES.has(t.state) ? t.state : 'starting';
  return {
    state,
    url: typeof t.url === 'string' ? t.url : null,
    reason: typeof t.reason === 'string' ? t.reason : null,
  };
}

// { managed, service: { state, url, detail }, tunnel: { state, url, reason } }
//   service.state: 'ready' | 'unavailable' | 'other' (a service answers, but
//                  not the one npm run phone started)
//   tunnel.state:  'unmanaged' when this app was not started by npm run phone,
//                  otherwise the launcher's state (see TUNNEL_STATES)
async function readStatus({
  sessionFile = process.env.OPERATOR_SESSION_FILE,
  serviceBase = SERVICE_BASE,
  timeoutMs = 1500,
} = {}) {
  const session = readSessionFile(sessionFile);
  const health = await getHealth(serviceBase, timeoutMs);
  let service;
  if (!health.reachable) {
    service = { state: 'unavailable', url: serviceBase, detail: health.error || 'no answer' };
  } else if (session && health.launch !== session.launchId) {
    service = { state: 'other', url: serviceBase, detail: null };
  } else {
    service = { state: 'ready', url: serviceBase, detail: null };
  }
  let tunnel;
  if (session) tunnel = tunnelFrom(session);
  else if (sessionFile) {
    // Started by npm run phone, which has since gone without closing us.
    tunnel = {
      state: 'lost',
      url: null,
      reason: 'The npm run phone that opened this window is no longer running, so its tunnel status is unknown.',
    };
  } else tunnel = { state: 'unmanaged', url: null, reason: null };
  return { managed: Boolean(sessionFile), service, tunnel };
}

module.exports = { readStatus };
