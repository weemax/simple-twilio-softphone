// SMS broker — HTTP client to the local token server's /sms/* endpoints.
//
// The renderer never talks to the SMS server directly. It calls into the
// main process via IPC (see preload.js), and the main process forwards to
// the local server. This keeps the same trust model as tokenBroker.js:
//   - Auth Token / API Secret stay in the main process or the server
//   - The renderer can only invoke whitelisted channels
//   - The local server only answers private routes for requests carrying
//     its local API key (see localApiAuth.js)

const http = require('http');
const { URL } = require('url');
const { localAuthHeaders } = require('./localApiAuth');

const SMS_BACKEND_BASE =
  process.env.SMS_BACKEND_URL || 'http://127.0.0.1:5050';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SMS_BACKEND_BASE + path);
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
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // Try to surface the server's structured error if it gave one.
            let detail = text;
            try {
              const parsed = JSON.parse(text);
              detail = parsed.error || parsed.detail || text;
            } catch (_) {
              // not JSON, keep raw text
            }
            return reject(
              new Error(`SMS backend ${res.statusCode}: ${detail}`)
            );
          }
          if (!text) return resolve(null);
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error(`SMS backend returned invalid JSON: ${text}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('SMS backend timed out'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function listConversations(number) {
  const path = number ? `/sms/conversations?number=${encodeURIComponent(number)}` : '/sms/conversations';
  return request('GET', path);
}

async function sendMessage({ to, body }) {
  if (!to || typeof to !== 'string') {
    throw new Error('`to` is required');
  }
  if (!body || typeof body !== 'string') {
    throw new Error('`body` is required');
  }
  return request('POST', '/sms/send', { to, body });
}

module.exports = { listConversations, sendMessage };
