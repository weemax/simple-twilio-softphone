// Twilio setup broker — HTTP client to the local service's /setup/* routes.
//
// The renderer never talks to the service directly. It calls the main
// process over IPC (see preload.js), which checks the shape of what it was
// given, adds the local API key (localApiAuth.js) and forwards it. The Auth
// Token a person types travels renderer → main → this loopback request and is
// saved by the service in server/.env; no answer ever carries it back.

const http = require('http');
const { URL } = require('url');
const { localAuthHeaders } = require('./localApiAuth');

const SERVICE_BASE = process.env.SMS_BACKEND_URL || 'http://127.0.0.1:5050';
// Setup calls Twilio several times in one request.
const TIMEOUT_MS = 60000;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVICE_BASE + path);
    const payload = body == null ? '' : JSON.stringify(body);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + (url.search || ''),
        headers: {
          Accept: 'application/json',
          ...localAuthHeaders(url),
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (_) {
            json = null;
          }
          if (json && typeof json === 'object') return resolve(json);
          reject(new Error(`The local service answered HTTP ${res.statusCode} without a usable reply.`));
        });
      }
    );
    req.on('error', (err) =>
      reject(new Error(`The local service is not answering (${err.code || err.message}).`))
    );
    req.on('timeout', () => req.destroy(new Error('The local service did not answer in time.')));
    if (payload) req.write(payload);
    req.end();
  });
}

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);

// Only the fields setup reads, as bounded strings; anything else a renderer
// sends is dropped before it reaches the service.
function cleanInput(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  const fields = {
    accountSid: 64,
    authToken: 128,
    publicBaseUrl: 300,
    identity: 64,
    numberSid: 40,
  };
  for (const [key, max] of Object.entries(fields)) {
    const v = text(src[key], max);
    if (v !== undefined) out[key] = v;
  }
  if (src.replace && typeof src.replace === 'object') {
    out.replace = {};
    for (const id of ['voice', 'sms']) {
      const v = text(src.replace[id], 40);
      if (v) out.replace[id] = v;
    }
  }
  return out;
}

const status = () => request('GET', '/setup/status');
const check = (input) => request('POST', '/setup/check', cleanInput(input));
const review = (input) => request('POST', '/setup/review', cleanInput(input));
const connect = (input) => request('POST', '/setup/connect', cleanInput(input));
const repair = () => request('POST', '/setup/repair', {});

module.exports = { status, check, review, connect, repair, cleanInput };
