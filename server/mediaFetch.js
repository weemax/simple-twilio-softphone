// Downloading the photos of an incoming text message, backend-side.
//
// The URLs come from a webhook whose Twilio signature was already checked, but
// the download still goes only where it should:
//   - the first address must be https://api.twilio.com/2010-04-01/Accounts/<this
//     account's SID>/Messages/<message>/Media/<media>. Another host, another
//     account, another path, another scheme or port is refused unfetched;
//   - Twilio answers with a redirect to its media CDN. Redirects are followed by
//     hand (at most 3), and only to https on *.twiliocdn.com (default port);
//   - the Twilio API key is sent to the first address only, never to a redirect;
//   - a connection that resolves to this machine or a private network is refused;
//   - the body is capped (declared length first, then while reading) and the
//     whole download has a deadline; compressed encodings are not requested.
// OPERATOR_TWILIO_API_BASE (a loopback fake Twilio, see twilioApi.js) is the one
// way to approve a different origin, and only a loopback one.

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { resolveBases } = require('./twilioApi');

const MAX_REDIRECTS = 3;

class FetchError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'FetchError';
    // 'refused' (not an approved address) | 'too-large' | 'unavailable'
    this.reason = reason;
  }
}

function isCdnHost(host) {
  return host === 'twiliocdn.com' || host.endsWith('.twiliocdn.com');
}

// The loopback origin a test fake Twilio runs on, or null when the real one is used.
function fakeOrigin(env) {
  const { api } = resolveBases(env);
  return api === 'https://api.twilio.com' ? null : api;
}

// The URL as a parsed object when it is an approved first address for this account, else null.
function approvedMediaUrl(raw, accountSid, env = process.env) {
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    return null;
  }
  const fake = fakeOrigin(env);
  const originOk = fake ? url.origin === fake : url.protocol === 'https:' && url.host === 'api.twilio.com';
  if (!originOk || url.username || url.password || url.search || url.hash) return null;
  const sid = String(accountSid || '').replace(/[^A-Za-z0-9]/g, '');
  if (!/^AC[a-zA-Z0-9]{32}$/.test(sid)) return null;
  const pattern = new RegExp(
    `^/2010-04-01/Accounts/${sid}/Messages/(?:MM|SM)[a-zA-Z0-9]{32}/Media/ME[a-zA-Z0-9]{32}$`
  );
  return pattern.test(url.pathname) ? url : null;
}

function approvedRedirect(raw, base, env) {
  let url;
  try {
    url = new URL(raw, base);
  } catch (_) {
    return null;
  }
  const fake = fakeOrigin(env);
  if (url.username || url.password) return null;
  if (fake) return url.origin === fake ? url : null;
  if (url.protocol !== 'https:' || url.port || !isCdnHost(url.hostname.toLowerCase())) return null;
  return url;
}

function privateAddress(address) {
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    if (a.startsWith('::ffff:')) return privateAddress(a.slice(7));
    return a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80');
  }
  const [a, b] = address.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

// Resolve like the default lookup, then refuse a private or loopback answer.
function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (list.some((a) => privateAddress(a.address))) {
      return callback(new FetchError('refused', 'The address resolves to a private network.'));
    }
    return callback(null, address, family);
  });
}

function getOnce(url, { headers, signal, maxBytes, loopbackOk }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        agent: false,
        signal,
        headers: { Accept: 'image/jpeg, image/png', 'Accept-Encoding': 'identity', ...headers },
        timeout: 10000,
        ...(loopbackOk ? {} : { lookup: publicLookup }),
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: String(res.headers.location) });
        }
        if (status !== 200) {
          res.resume();
          return reject(new FetchError('unavailable', `The photo was not available (HTTP ${status}).`));
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          return reject(new FetchError('too-large', 'The photo is too large.'));
        }
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > maxBytes) {
            res.destroy();
            reject(new FetchError('too-large', 'The photo is too large.'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ bytes: Buffer.concat(chunks) }));
        res.on('error', (err) => reject(err instanceof FetchError ? err : new FetchError('unavailable', 'The download failed.')));
      }
    );
    req.on('timeout', () => req.destroy(new FetchError('unavailable', 'The download took too long.')));
    req.on('error', (err) => reject(err instanceof FetchError ? err : new FetchError('unavailable', 'The download failed.')));
    req.end();
  });
}

// Downloads one approved media URL. Resolves a Buffer of at most `maxBytes`, or
// rejects with a FetchError whose `reason` says what a person should be told.
async function fetchTwilioMedia({
  url: raw,
  accountSid,
  auth,
  maxBytes,
  timeoutMs = 20000,
  env = process.env,
}) {
  let url = approvedMediaUrl(raw, accountSid, env);
  if (!url) throw new FetchError('refused', 'The photo address is not one Operator downloads from.');
  // One deadline for the whole download, redirects included.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const loopbackOk = Boolean(fakeOrigin(env));
  // `auth` is { user, pass }: an API key and secret (or the account's Auth Token).
  let headers = { Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64') };
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const answer = await getOnce(url, { headers, signal: controller.signal, maxBytes, loopbackOk });
      if (answer.bytes) return answer.bytes;
      const next = approvedRedirect(answer.redirect, url, env);
      if (!next) throw new FetchError('refused', 'The photo moved somewhere Operator does not download from.');
      url = next;
      headers = {}; // credentials never follow a redirect
    }
    throw new FetchError('unavailable', 'The photo address redirected too many times.');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchTwilioMedia, approvedMediaUrl, FetchError };
