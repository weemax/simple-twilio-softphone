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

// `opts.rawBody` sends bytes as they are (a photo); `opts.binary` answers the
// response bytes with their Content-Type instead of parsing JSON.
function request(method, path, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(SMS_BACKEND_BASE + path);
    const payload = opts.rawBody ? opts.rawBody : body == null ? '' : JSON.stringify(body);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + (url.search || ''),
        headers: {
          Accept: 'application/json',
          ...localAuthHeaders(url),
          ...(payload && payload.length
            ? {
                'Content-Type': opts.rawBody ? 'application/octet-stream' : 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
        timeout: opts.rawBody || opts.binary ? 30000 : 10000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (opts.binary && res.statusCode >= 200 && res.statusCode < 300) {
            return resolve({ type: res.headers['content-type'] || '', bytes: Buffer.concat(chunks) });
          }
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // Try to surface the server's structured error if it gave one.
            let detail = text;
            let outcome = null;
            try {
              const parsed = JSON.parse(text);
              detail = parsed.error || parsed.detail || text;
              outcome = parsed.status;
            } catch (_) {
              // not JSON, keep raw text
            }
            const error = new Error(`SMS backend ${res.statusCode}: ${detail}`);
            error.outcome = outcome || (res.statusCode >= 400 && res.statusCode < 500 ? 'failed' : 'unknown');
            return reject(error);
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
    if (payload && payload.length) req.write(payload);
    req.end();
  });
}

async function listConversations(number) {
  const path = number ? `/sms/conversations?number=${encodeURIComponent(number)}` : '/sms/conversations';
  return request('GET', path);
}

// `media` is a list of photo ids from attachPhoto(); a photo-only message has no text.
async function sendMessage({ to, body, media }) {
  if (!to || typeof to !== 'string') {
    throw new Error('`to` is required');
  }
  const photos = media === undefined || media === null ? [] : media;
  if (!Array.isArray(photos) || photos.some((id) => typeof id !== 'string')) {
    throw new Error('`media` must be a list of photo ids');
  }
  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new Error('`body` must be text');
  }
  if (!body && !photos.length) {
    throw new Error('`body` is required');
  }
  return request('POST', '/sms/send', { to, body: body || '', ...(photos.length ? { media: photos } : {}) });
}

// Photos stay on this machine until a message that includes them is sent.
async function attachPhoto({ name, bytes }) {
  const data = Buffer.isBuffer(bytes) ? bytes : bytes instanceof Uint8Array ? Buffer.from(bytes) : null;
  if (!data || !data.length) throw new Error('The photo is empty.');
  const label = typeof name === 'string' ? name.slice(0, 120) : '';
  return request('POST', `/sms/media?name=${encodeURIComponent(label)}`, null, { rawBody: data });
}

function checkId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('A valid photo id is required.');
}

async function readPhoto(id) {
  checkId(id);
  return request('GET', `/sms/media/${id}`, null, { binary: true });
}

async function discardPhoto(id) {
  checkId(id);
  return request('DELETE', `/sms/media/${id}`);
}

async function prunePhotos(keep) {
  if (!Array.isArray(keep)) throw new Error('`keep` must be a list');
  keep.forEach(checkId);
  return request('POST', '/sms/media-prune', { keep });
}

async function photoPolicy(to) {
  if (typeof to !== 'string') throw new Error('`to` is required');
  return request('GET', `/sms/media-policy?to=${encodeURIComponent(to)}`);
}

async function clearConversation(number) {
  if (!number || typeof number !== 'string') {
    throw new Error('`number` is required');
  }
  return request('POST', '/sms/clear', { number });
}

async function getMe() {
  return request('GET', '/me');
}

module.exports = {
  listConversations,
  sendMessage,
  clearConversation,
  getMe,
  attachPhoto,
  readPhoto,
  discardPhoto,
  prunePhotos,
  photoPolicy,
};
