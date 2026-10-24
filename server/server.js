// Local capability token broker for Operator.
//
// Listens on http://127.0.0.1:5050 by default. NEVER bind to 0.0.0.0 — this
// server signs tokens with your Twilio API Secret.
//
// Only the routes in PUBLIC_ROUTES (Twilio's webhooks and /health) may be
// reached through a tunnel. Every other route is private: see
// checkPrivateAccess for what a request must show to reach one. Twilio's
// webhooks must also carry a valid Twilio signature: see
// checkTwilioSignature.
//
// The in-app setup (Settings → Twilio account, server/setup.js) writes these
// settings to `server/.env`; they can also be set by hand there or in the
// parent shell. The service starts without them so the app can open its setup;
// until they exist /token and /sms/send answer 409.
//
// Settings:
//   TWILIO_ACCOUNT_SID     — starts with AC…
//   TWILIO_API_KEY         — starts with SK…
//   TWILIO_API_SECRET      — the secret shown when the API Key was created
//   TWILIO_TWIML_APP_SID   — a Voice TwiML App SID (starts with AP…)
//
// Required for Twilio's webhooks (/twiml, /sms/inbound, /sms/status), which
// are refused without them:
//   TWILIO_AUTH_TOKEN      — the account's primary Auth Token; Twilio signs
//                            every webhook request with it
//   PUBLIC_BASE_URL        — the public address Twilio calls, e.g.
//                            https://YOUR-DOMAIN.ngrok-free.app

// The environment this process started with, before server/.env is read: it
// wins over server/.env, so `npm run phone` can supply the tunnel's address.
const launchEnv = { ...process.env };

if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '.env') });
}

// Optional:
//   PORT                   — default 5050
//   OPERATOR_LAUNCH_ID     — set by `npm run phone` (launcher/supervisor.js);
//                            /health echoes it so the launcher can tell this
//                            service, reached directly or through the tunnel,
//                            from any other program on the port
//
// The renderer asks main for a token via `window.operator.token.fetch(identity)`,
// main posts to this server's /token, this server signs the JWT and returns
// it. The auth token is never sent over the wire.

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const twilio = require('twilio');
const { SmsStore, normalizeNumber, MAX_BODY_LENGTH } = require('./smsStore');
const { createConfig } = require('./config');
const { createSetup, SetupError } = require('./setup');
const {
  generateKey,
  writeKeyFile,
  keyFilePath,
  keysMatch,
} = require('./localApiKey');

const PORT = parseInt(process.env.PORT || '5050', 10);
const HOST = process.env.HOST || '127.0.0.1';
// A random, per-launch id, not a secret: it only identifies this run.
const LAUNCH_ID = /^[A-Za-z0-9_-]{1,64}$/.test(process.env.OPERATOR_LAUNCH_ID || '')
  ? process.env.OPERATOR_LAUNCH_ID
  : null;

// Where this service's settings live: server/.env when it was started
// directly, or the file OPERATOR_ENV_FILE names (tests, the desktop test
// launcher). Without one, setup has nowhere to save and refuses to run.
const ENV_FILE =
  process.env.OPERATOR_ENV_FILE ||
  (require.main === module ? path.join(__dirname, '.env') : null);
const serverConfig = createConfig({ launchEnv, envFile: ENV_FILE });
// The current settings. Read again after the in-app setup writes server/.env,
// so nothing here needs a restart. Settings: accountSid, apiKey, apiSecret,
// twimlAppSid, callerId, smsFrom (optional dedicated sender), statusCallbackUrl
// (optional override), identity (the Twilio Client identity inbound calls
// ring; the app registers as the same one), authToken (only used to check
// Twilio's webhook signatures; tokens and SMS sends use the API key) and
// publicBaseUrl (the address Twilio calls: signatures cover the exact URL, and
// behind a tunnel this server only sees the local one).
const cfg = () => serverConfig.get();
const setup = createSetup({
  config: serverConfig,
  statePath: ENV_FILE
    ? process.env.OPERATOR_SETUP_STATE_FILE || path.join(path.dirname(ENV_FILE), '.operator-setup.json')
    : null,
  env: process.env,
  log: (m) => console.log(`[setup] ${m}`),
});

// SMS persistence lives next to the token server so the renderer and the
// webhook can both read it. Override with SMS_STORE_PATH for tests.
const SMS_STORE_PATH =
  process.env.SMS_STORE_PATH ||
  path.join(__dirname, 'sms-store.json');
const smsStore = new SmsStore(SMS_STORE_PATH);

// Build the absolute status-callback URL we tell Twilio to POST to. Twilio
// requires a publicly reachable URL — in dev that's the ngrok tunnel plus
// the public /sms/status path. In prod it could be a stable hostname.
function getStatusCallbackUrl() {
  if (cfg().statusCallbackUrl) return cfg().statusCallbackUrl;
  // Default to the same host as the inbound webhook: rely on the env to
  // provide a public base, or fail closed (don't register a callback).
  if (cfg().publicBaseUrl) return cfg().publicBaseUrl + '/sms/status';
  return null; // not configured — handleSmsSend will skip statusCallback
}

// Settings the token and SMS routes need, still missing. The service starts
// anyway: the in-app setup (Settings → Twilio account) fills them in.
function missingSettings() {
  const c = cfg();
  const missing = [];
  if (!c.accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!c.apiKey) missing.push('TWILIO_API_KEY');
  if (!c.apiSecret) missing.push('TWILIO_API_SECRET');
  if (!c.twimlAppSid) missing.push('TWILIO_TWIML_APP_SID');
  return missing;
}

function startupNotes() {
  const c = cfg();
  const notes = [];
  const missing = missingSettings();
  if (missing.length) {
    notes.push(
      `Twilio is not connected yet (missing ${missing.join(', ')}): calls and texts are unavailable ` +
        'until you finish Settings → Twilio account in the app. See server/README.md.'
    );
  } else if (!c.callerId) {
    notes.push(
      'TWILIO_CALLER_ID not set — outbound calls will fail with 31005. Choose a number in ' +
        'Settings → Twilio account, or add a verified Twilio number to server/.env.'
    );
  }
  if (c.publicBaseUrl && c.statusCallbackUrl && !c.statusCallbackUrl.startsWith(c.publicBaseUrl + '/sms/status')) {
    notes.push(
      `SMS_STATUS_CALLBACK_URL is not ${c.publicBaseUrl}/sms/status — ` +
        'delivery updates sent there will fail the signature check. Remove it to use PUBLIC_BASE_URL.'
    );
  }
  return notes;
}

// Why Twilio's webhooks cannot be checked, or null when they can.
function webhookConfigProblem() {
  const c = cfg();
  const missing = [];
  if (!c.authToken) missing.push('TWILIO_AUTH_TOKEN is not set');
  if (!c.publicBaseUrl) {
    missing.push(
      c.rawPublicBaseUrl
        ? `the public base URL "${c.rawPublicBaseUrl}" is not an http(s) URL`
        : 'PUBLIC_BASE_URL is not set'
    );
  }
  return missing.length ? missing.join(' and ') : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, extraHeaders = {}) {
  const text =
    typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':
      typeof body === 'string' ? 'text/plain' : 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
}

// Twilio's webhooks. Each request must carry a valid Twilio signature
// (checkTwilioSignature) before it is handled.
const TWILIO_WEBHOOK_ROUTES = new Set([
  '/twiml',
  '/',
  '/sms/inbound',
  '/sms/status',
]);

// The only routes a tunnel may reach: Twilio's webhooks plus /health for
// checking the tunnel itself. Their responses carry no secrets or history.
// Any route not listed here is private, so a new route stays off the
// tunnel unless it is added on purpose.
const PUBLIC_ROUTES = new Set(['/health', ...TWILIO_WEBHOOK_ROUTES]);

// Set by startServer(). Until then every private request is refused.
let localApiKey = null;

// Headers a reverse proxy or tunnel adds when it forwards a request (ngrok
// adds the three X-Forwarded-* ones; Cloudflare Tunnel adds
// CF-Connecting-IP). The Operator app's main process talks to this server
// directly and never sends any of them. Tunnels can be configured to strip
// them, which is why the local API key, not this list, is the real lock.
const FORWARDING_HEADERS = [
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
];

function isLocalRequest(req) {
  const remote = req.socket.remoteAddress || '';
  return (
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1'
  );
}

// The Host a direct request to this machine carries. A tunnel keeps the
// public hostname, and a DNS-rebinding page in the browser carries its own.
function isLoopbackHost(hostHeader) {
  const host = (hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

// A tunnel connects from loopback, so the socket address alone does not
// prove a request came from the Operator app. A private route needs all of:
//   1. a loopback connection,
//   2. no sign of a proxy or tunnel (forwarding headers, a public Host),
//   3. this server's local API key as a bearer token (see localApiKey.js).
// Returns null when allowed, or the { status, error } to answer with.
function checkPrivateAccess(req) {
  if (!isLocalRequest(req)) {
    return { status: 403, error: 'local only' };
  }
  const proxied = FORWARDING_HEADERS.some((h) => h in req.headers);
  if (proxied || !isLoopbackHost(req.headers.host)) {
    return {
      status: 403,
      error: 'private route: not reachable through a tunnel or proxy',
    };
  }
  const auth = req.headers.authorization || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!keysMatch(localApiKey, presented)) {
    return {
      status: 401,
      error:
        'missing or invalid local API key (restart the token server and the app; see server/README.md)',
    };
  }
  return null;
}

// Whether `presented` is Twilio's signature for this request: the public
// URL it was sent to (PUBLIC_BASE_URL + `reqUrl`, the path and query string
// this server received) and every POST parameter in `form`.
function signatureValidFor(presented, reqUrl, form) {
  try {
    // The SDK also tries the URL with and without the default port, which
    // Twilio keeps for SMS and drops for HTTPS voice.
    if (twilio.validateRequest(cfg().authToken, presented, cfg().publicBaseUrl + reqUrl, form)) {
      return true;
    }
    // The SDK parses the URL, which adds a "/" to a bare host. A Voice URL
    // set to the tunnel address with no path is signed without it.
    if (reqUrl !== '/' && !reqUrl.startsWith('/?')) return false;
    const bareUrl = cfg().publicBaseUrl + reqUrl.slice(1);
    const expected = Buffer.from(
      twilio.getExpectedTwilioSignature(cfg().authToken, bareUrl, form)
    );
    const given = Buffer.from(presented);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  } catch (_) {
    return false; // an unparseable URL is never a valid signature
  }
}

// Twilio signs every webhook request: X-Twilio-Signature is the base64
// HMAC-SHA1, keyed with the account's Auth Token, of the exact URL Twilio
// requested (scheme, host, path and query string) followed by every POST
// parameter, sorted by name. Checking it against PUBLIC_BASE_URL and the
// whole body refuses a forged request, one signed for another URL (such as
// the local one this server sees), and one with any parameter added,
// dropped or changed. Unknown parameters stay in: Twilio adds new ones
// without notice. Returns null when the signature is valid, or the
// { status, error, log } to answer with; until TWILIO_AUTH_TOKEN and
// PUBLIC_BASE_URL are both set, every webhook is refused.
function checkTwilioSignature(req, form) {
  const problem = webhookConfigProblem();
  if (problem) {
    return { status: 503, error: 'webhook signature check not configured', log: problem };
  }
  // Logged without the query string, which carries call details on GET.
  const publicUrl = cfg().publicBaseUrl + req.url.split('?')[0];
  const presented = req.headers['x-twilio-signature'];
  if (!presented) {
    return { status: 403, error: 'missing Twilio signature', log: `no X-Twilio-Signature (${publicUrl})` };
  }
  if (signatureValidFor(presented, req.url, form)) return null;
  return {
    status: 403,
    error: 'invalid Twilio signature',
    log:
      `X-Twilio-Signature does not match ${publicUrl} — check that ` +
      'TWILIO_AUTH_TOKEN is the primary Auth Token and that the Twilio ' +
      'console uses this exact URL',
  };
}

// CORS headers for a renderer page on localhost (the CRA dev server on
// :3000), added to /sms/clear responses so a renderer that reaches the
// route directly can read the answer. checkPrivateAccess runs before any
// private route, and a browser page never holds this run's local API key,
// so a direct renderer request (its OPTIONS preflight included) is refused
// with 401 before reaching here: the renderer clears a thread through the
// app's main process (IPC sms:clear), which sends the key. Never used for
// /token.
function localRendererCors(req) {
  const origin = String(req.headers.origin || '');
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return {};
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

const server = http.createServer(async (req, res) => {
  // Public routes: Twilio must reach these from the internet. Twilio's
  // webhooks need a valid Twilio signature; /health answers anyone. We
  // never put secrets in their responses.
  // Private routes (/token, /sms/send, /sms/conversations): only the
  // Operator app on this machine. /token returns auth-signed JWTs.
  const url = (req.url || '').split('?')[0];

  if (!PUBLIC_ROUTES.has(url)) {
    const denied = checkPrivateAccess(req);
    if (denied) return send(res, denied.status, { error: denied.error });
  }

  if (TWILIO_WEBHOOK_ROUTES.has(url)) {
    return handleTwilioWebhook(req, res, url);
  }

  if (req.method === 'GET' && url === '/health') {
    return send(res, 200, { ok: true, ts: Date.now(), ...(LAUNCH_ID ? { launch: LAUNCH_ID } : {}) });
  }

  if (url === '/me') {
    // Private by default: checkPrivateAccess above protects sender metadata.
    if (req.method !== 'GET') {
      return send(res, 405, { error: 'method not allowed' });
    }
    return send(res, 200, { ok: true, ...operatorNumbers() });
  }

  if (url.startsWith('/setup/')) {
    return handleSetup(req, res, url);
  }

  if (url === '/token') {
    if (req.method !== 'POST') {
      return send(res, 405, { error: 'method not allowed' });
    }
    return handleToken(req, res);
  }

  if (url === '/sms/send') {
    if (req.method !== 'POST') {
      return send(res, 405, { error: 'method not allowed' });
    }
    return handleSmsSend(req, res);
  }

  if (url === '/sms/conversations') {
    if (req.method !== 'GET') {
      return send(res, 405, { error: 'method not allowed' });
    }
    return handleSmsList(req, res);
  }

  if (url === '/sms/clear') {
    // Private by default: checkPrivateAccess above already required a direct
    // loopback request carrying this run's local API key. Clears the local
    // history of one thread; nothing is deleted at Twilio.
    if (req.method === 'OPTIONS') {
      return send(res, 204, '', localRendererCors(req));
    }
    if (req.method !== 'POST') {
      return send(res, 405, { error: 'method not allowed' }, localRendererCors(req));
    }
    return handleSmsClear(req, res);
  }

  return send(res, 404, { error: 'not found' });
});

// Read the webhook's form body, check Twilio's signature over it, then hand
// the request's parameters (query string and body) to the route's handler.
async function handleTwilioWebhook(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return send(res, 405, { error: 'method not allowed' });
  }

  let form = {};
  if (req.method === 'POST') {
    try {
      form = await readFormBody(req);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  const denied = checkTwilioSignature(req, form);
  if (denied) {
    console.warn(`[webhook] refused ${req.method} ${url}: ${denied.log}`);
    return send(res, denied.status, { error: denied.error });
  }

  // Twilio never repeats a parameter on these webhooks; if one is repeated,
  // the last value wins, as before signatures were checked.
  const params = {};
  new URL(req.url, 'http://localhost').searchParams.forEach((v, k) => {
    params[k] = v;
  });
  for (const [k, v] of Object.entries(form)) {
    params[k] = Array.isArray(v) ? v[v.length - 1] : v;
  }

  if (url === '/twiml' || url === '/') {
    // Both /twiml and the bare root return TwiML, so a TwiML App pointed
    // at the tunnel root still works. /health stays the only probe path.
    return renderTwiml(params, res);
  }
  if (url === '/sms/inbound') return handleSmsInbound(params, res);
  return handleSmsStatus(params, res);
}

// In-app Twilio setup (server/setup.js). Private like every route not in
// PUBLIC_ROUTES: checkPrivateAccess has already required the local API key,
// so neither the Auth Token a request carries nor any answer reaches the
// tunnel. No answer contains the Auth Token or an API secret.
const SETUP_ACTIONS = {
  '/setup/check': (body) => setup.check(body),
  '/setup/review': (body) => setup.review(body),
  '/setup/connect': (body) => setup.connect(body),
  '/setup/repair': () => setup.repair(),
};

async function handleSetup(req, res, url) {
  if (url === '/setup/status') {
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    return send(res, 200, { ok: true, ...setup.status() });
  }
  const action = SETUP_ACTIONS[url];
  if (!action) return send(res, 404, { error: 'not found' });
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return send(res, 400, { ok: false, error: err.message });
  }
  try {
    const result = await action(body && typeof body === 'object' ? body : {});
    return send(res, 200, result);
  } catch (err) {
    if (err instanceof SetupError) {
      return send(res, err.status, { ok: false, kind: err.kind, error: err.message });
    }
    // Never echo a message that could quote a request: say only that it failed.
    console.error(`[setup] ${url} failed:`, err.name || 'Error');
    return send(res, 500, { ok: false, kind: 'error', error: 'Setup failed unexpectedly. Nothing further was changed.' });
  }
}

async function handleToken(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return send(res, 400, { error: err.message });
  }

  const identity = (body.identity || '').toString().trim();
  if (!identity) {
    return send(res, 400, { error: 'identity is required' });
  }
  if (!/^[A-Za-z0-9_\-]{1,64}$/.test(identity)) {
    return send(res, 400, {
      error: 'identity must match /^[A-Za-z0-9_-]{1,64}$/',
    });
  }

  try {
    const c = cfg();
    if (missingSettings().length) {
      return send(res, 409, {
        error: 'Twilio is not connected yet. Open Settings → Twilio account in the app.',
        notConfigured: true,
      });
    }
    const AccessToken = twilio.jwt.AccessToken;
    const { VoiceGrant } = AccessToken;

    const token = new AccessToken(
      c.accountSid,
      c.apiKey,
      c.apiSecret,
      { identity, ttl: 3600 }
    );
    token.addGrant(
      new VoiceGrant({
        outgoingApplicationSid: c.twimlAppSid,
        // Permit inbound calls to reach this Client identity. Without
        // this flag Twilio drops inbound connections to the Device even
        // if TwiML explicitly <Dial>s to the identity.
        incomingAllow: true,
      })
    );

    return send(res, 200, {
      identity,
      token: token.toJwt(),
      ttl: 3600,
    });
  } catch (err) {
    console.error('[token-server] sign failed:', err);
    return send(res, 500, { error: 'token sign failed' });
  }
}

// TwiML response for both outbound calls placed by the Operator client and
// inbound calls to the Twilio number. Twilio POSTs to this URL with
// form-encoded params (or GETs with query string), which
// handleTwilioWebhook has already signature-checked and merged into
// `params`; direction is told apart by `From` (see the isFromClient check
// below).
//
// Routing rules (outbound only; inbound always dials OPERATOR_IDENTITY):
//   - If `To` looks like a Client identity (matches the safe identifier
//     regex), emit <Dial answerOnBridge><Client>…</Client></Dial> (Operator→Operator).
//   - If `To` looks like a phone number (E.164-ish: +, digits, spaces,
//     parens, dashes), emit <Dial answerOnBridge>…</Dial> (PSTN).
//   - Otherwise 400 with an error TwiML so Twilio reads the message.
//
// The VoiceResponse helper escapes user input safely.
function renderTwiml(params, res) {
  const to = (params.To || '').toString().trim();
  const from = (params.From || '').toString().trim();

  const { VoiceResponse } = twilio.twiml;
  const response = new VoiceResponse();

  // A single TwiML endpoint serves both directions, so we must tell them
  // apart:
  //   - Outbound: our softphone Client placed a call. Twilio presents the
  //     leg to the TwiML App with From="client:<identity>" and To set to
  //     the custom destination the client dialed. Route by `To`.
  //   - Inbound: a PSTN caller (or another client) dialed our Twilio
  //     number. Twilio sets To=<our Twilio number> and From=<caller>.
  //     Deliver the call to the operator softphone via <Client>.
  //
  // The reliable signal is `From`: only calls our own Client originates
  // carry the "client:" scheme. An empty-`To` test does NOT work here —
  // inbound calls arrive with `To` set to the dialed Twilio number, which
  // otherwise looks exactly like an outbound PSTN destination.
  const isFromClient = /^client:/i.test(from);

  if (!isFromClient) {
    // Inbound call to our Twilio number. Route it to the Operator softphone
    // via the Client identity so the @twilio/voice-sdk Device receives it.
    // Use the caller's number as callerId so the softphone shows who's
    // calling; fall back to the configured caller ID if absent.
    if (cfg().identity) {
      const dial = response.dial({ callerId: from || cfg().callerId });
      dial.client(cfg().identity);
      return sendTwiml(res, response);
    }
    response.say(
      'Operator is not configured to receive inbound calls yet. Set OPERATOR_IDENTITY in the token server .env.'
    );
    return sendTwiml(res, response);
  }

  // Outbound call placed by the operator softphone. Route by destination.
  if (!to) {
    response.say('No destination specified.');
    return sendTwiml(res, response);
  }

  if (/^[A-Za-z0-9_\-]{1,64}$/.test(to)) {
    // Operator-to-Operator (Client) call. callerId is required for Client
    // originations, even when both legs are clients.
    const dial = response.dial({
      callerId: cfg().callerId,
      answerOnBridge: true,
    });
    dial.client(to);
  } else if (/^\+?[0-9\s\-\(\)]{1,32}$/.test(to)) {
    // PSTN call. Pass the configured caller ID; Twilio rejects the call
    // with 31005 if this is missing on a Client-originated call.
    const dial = response.dial({
      callerId: cfg().callerId,
      answerOnBridge: true,
    });
    dial.number(to);
  } else {
    response.say('Invalid destination format.');
  }

  return sendTwiml(res, response);
}

function sendTwiml(res, response) {
  const xml = response.toString();
  res.writeHead(200, {
    'Content-Type': 'text/xml; charset=utf-8',
    'Content-Length': Buffer.byteLength(xml),
    'Cache-Control': 'no-store',
  });
  res.end(xml);
}

// --- SMS ---

// Used by /sms/send (JSON body) and /sms/conversations (no body).
function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (_) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Twilio's webhooks POST application/x-www-form-urlencoded. Every
// parameter is kept, a repeated one as an array of its values, because
// Twilio's signature covers all of them. The body is read before the
// signature can be checked, so its size is capped.
function readFormBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const out = Object.create(null);
      new URLSearchParams(text).forEach((v, k) => {
        if (!(k in out)) out[k] = v;
        else out[k] = [].concat(out[k], v);
      });
      resolve(out);
    });
    req.on('error', reject);
  });
}

async function handleSmsSend(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return send(res, 400, { error: err.message });
  }

  const to = normalizeNumber(body.to);
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!to) {
    return send(res, 400, { error: '`to` must be a valid E.164 number' });
  }
  if (!text) {
    return send(res, 400, { error: '`body` is required' });
  }
  if (text.length > MAX_BODY_LENGTH) {
    return send(res, 400, {
      error: `body exceeds ${MAX_BODY_LENGTH} chars`,
    });
  }

  if (missingSettings().length) {
    return send(res, 409, {
      error: 'Twilio is not connected yet. Open Settings → Twilio account in the app.',
      status: 'failed',
    });
  }

  // Persist the outbound message locally *first* so the UI sees it even
  // if Twilio's API call fails. On Twilio success we update the local
  // record with the real SID + status; on failure we mark it failed.
  const placeholder = await smsStore.appendMessage({
    number: to,
    sid: null,
    direction: 'outbound',
    body: text,
    at: Date.now(),
    status: 'sending',
  });
  const placeholderMsg = placeholder.messages[placeholder.messages.length - 1];

  const from = cfg().smsFrom || cfg().callerId;
  if (!from) {
    const failed = await smsStore._withLock(() => {
      placeholderMsg.status = 'failed';
      smsStore._persist();
    });
    return send(res, 500, {
      error: 'no outbound SMS number configured (set TWILIO_SMS_FROM or TWILIO_CALLER_ID)',
      status: 'failed',
    });
  }

  // Build the messages.create() params. If a status callback URL is
  // configured, ask Twilio to POST to it whenever this message's
  // delivery status changes (queued -> sent -> delivered, or -> failed).
  const statusCallbackUrl = getStatusCallbackUrl();
  const createParams = { to, from, body: text };
  if (statusCallbackUrl) {
    createParams.statusCallback = statusCallbackUrl;
  }

  try {
    const client = twilio(cfg().apiKey, cfg().apiSecret, {
      accountSid: cfg().accountSid,
    });
    const result = await client.messages.create(createParams);
    // Update the local record with the real SID and Twilio status.
    await smsStore._withLock(() => {
      const conv = smsStore._data[to];
      if (conv) {
        const m = conv.messages.find((x) => x === placeholderMsg);
        if (m) {
          m.sid = result.sid;
          m.status = (result.status || 'sent').toLowerCase();
        }
        smsStore._persist();
      }
    });
    return send(res, 200, {
      ok: true,
      sid: result.sid,
      to,
      status: result.status,
    });
  } catch (err) {
    // A transport timeout or 5xx may have happened after Twilio accepted the message.
    // Only an explicit rejection proves failure; never offer a resend for an unknown result.
    const outcome = Number(err.status) >= 400 && Number(err.status) < 500 && Number(err.status) !== 408 ? 'failed' : 'unknown';
    await smsStore._withLock(() => {
      const conv = smsStore._data[to];
      if (conv) {
        const m = conv.messages.find((x) => x === placeholderMsg);
        if (m) m.status = outcome;
        smsStore._persist();
      }
    });
    return send(res, 502, { error: outcome === 'failed' ? 'Twilio rejected the message.' : 'The message outcome is unknown. Check the Twilio message log before resending.', status: outcome });
  }
}

// Twilio's incoming-message webhook. Public, but handleTwilioWebhook has
// already refused anything without a valid Twilio signature, so `params`
// is what Twilio sent.
async function handleSmsInbound(params, res) {
  const from = normalizeNumber(params.From);
  const body = typeof params.Body === 'string' ? params.Body : '';
  const sid = params.MessageSid || params.SmsSid || null;
  const smsStatus = (params.SmsStatus || 'received').toLowerCase();

  if (!from) {
    res.writeHead(400, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Invalid sender.</Say></Response>');
    return;
  }

  try {
    await smsStore.appendMessage({
      number: from,
      sid,
      direction: 'inbound',
      body,
      at: Date.now(),
      status: smsStatus,
    });
  } catch (err) {
    console.error('[sms] inbound persist failed:', err.message);
    // Still 200 to Twilio — we don't want retries for our own bugs.
  }

  // Empty TwiML tells Twilio "got it, do nothing." A non-2xx here would
  // cause Twilio to retry.
  res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
  res.end('<?xml version="1.0" encoding="UTF-8"?><Response/>');
}

// Twilio's per-message status callback. POSTs application/x-www-form-urlencoded
// with at least MessageSid + MessageStatus (and SmsSid + SmsStatus as legacy
// aliases). See:
//   https://www.twilio.com/docs/messaging/api/message-resource#message-status-values
//
// Like the other webhooks, it reaches this handler only with a valid
// Twilio signature (handleTwilioWebhook). We look up the message by SID in
// the store and update its status. The renderer's 3s poll picks up the new
// status on the next cycle. No TwiML response expected — Twilio just
// records the HTTP 2xx.
async function handleSmsStatus(params, res) {
  const sid = params.MessageSid || params.SmsSid || null;
  const status = (
    params.MessageStatus ||
    params.SmsStatus ||
    ''
  ).toLowerCase();

  if (!sid) {
    return send(res, 400, { ok: false, error: 'missing MessageSid' });
  }
  if (!status) {
    return send(res, 400, { ok: false, error: 'missing MessageStatus' });
  }

  // Twilio's documented status values are: queued, sending, sent,
  // failed, delivered, undelivered, read (WhatsApp only). We accept
  // any string and lower-case it; the renderer's StatusBadge handles
  // known values and falls back to the raw string.
  try {
    const updated = await smsStore.updateMessageBySid({ sid, status });
    // 200 either way — Twilio doesn't retry on our internal state.
    return send(res, 200, { ok: true, updated });
  } catch (err) {
    console.error('[sms] status update failed:', err.message);
    return send(res, 500, { ok: false, error: 'update failed' });
  }
}

function operatorNumbers() {
  const callerId = cfg().callerId || null;
  const smsFrom = cfg().smsFrom || cfg().callerId || null;
  return { callerId, smsFrom };
}

async function handleSmsClear(req, res) {
  // Local cache only. Does not delete anything at Twilio.
  const cors = localRendererCors(req);
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return send(res, 400, { error: err.message }, cors);
  }
  const number = normalizeNumber(body.number);
  if (!number) {
    return send(res, 400, { error: '`number` must be a valid E.164 number' }, cors);
  }
  try {
    const result = await smsStore.clearConversation(number);
    return send(res, 200, { ok: true, ...result }, cors);
  } catch (err) {
    return send(res, 500, { ok: false, error: err.message || 'clear failed' }, cors);
  }
}

function handleSmsList(req, res) {
  // Optional ?number=+1… to fetch a single thread in full.
  const url = new URL(req.url, 'http://localhost');
  const numParam = url.searchParams.get('number');
  if (numParam) {
    const conv = smsStore.getConversation(numParam);
    if (!conv) return send(res, 404, { error: 'no such conversation' });
    return send(res, 200, conv);
  }
  // Include the operator's numbers so the renderer can show which
  // number outbound SMS/calls present as. Not attached to a single
  // thread fetch - that payload is the conversation itself.
  return send(res, 200, {
    conversations: smsStore.listConversations(),
    ...operatorNumbers(),
  });
}

// Listen, then issue this run's local API key. The key file is written only
// once this process owns the port, so a second copy that fails to bind
// cannot replace the running server's key.
function startServer({ port = PORT, host = HOST } = {}) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      try {
        localApiKey = generateKey();
        writeKeyFile(localApiKey);
      } catch (err) {
        localApiKey = null;
        server.close();
        return reject(new Error(`could not write local API key: ${err.message}`));
      }
      resolve(server);
    });
  });
}

// On every start, check and repair what Operator owns in the Twilio account
// (see setup.repair). Only runs once the person has connected through the
// in-app setup; a failure is recorded for the Connection view, not fatal.
function startRepair() {
  setup
    .repair()
    .then((r) => {
      if (r.result === 'ok') {
        console.log(`[setup] account check: ok${r.changes.length ? ' — ' + r.changes.join(' ') : ''}`);
        for (const w of r.warnings || []) console.warn(`[setup] ${w}`);
      } else if (r.result !== 'not-set-up' && r.result !== 'unavailable') {
        console.warn(`[setup] account check: ${r.result} — ${r.error}`);
      }
    })
    .catch((err) => console.warn('[setup] account check failed:', err.name || 'Error'));
}

module.exports = { renderTwiml, startServer, startRepair, PUBLIC_ROUTES, operatorNumbers };

if (require.main === module) {
  startServer().then(() => {
    console.log(`[token-server] listening on http://${HOST}:${PORT}` + (cfg().accountSid ? ` (account ${cfg().accountSid.slice(0, 6)}…)` : ' (Twilio not connected yet)'));
    console.log(
      `[token-server] public (tunnel) routes: ${[...PUBLIC_ROUTES].join(' ')}` +
        ` · private routes need the local API key in ${keyFilePath()}`
    );
    for (const note of startupNotes()) console.warn(`[token-server] ${note}`);
    const sender = cfg().smsFrom || cfg().callerId;
    console.log(
      `[token-server] sms store: ${SMS_STORE_PATH}` +
        (sender ? ` · sender: ${sender}` : ' · sender: NOT CONFIGURED (sms/send will fail)')
    );
    const cb = getStatusCallbackUrl();
    if (cb) {
      console.log(`[token-server] sms status callback: ${cb}`);
    } else {
      console.log(
        '[token-server] sms status callback: NOT CONFIGURED ' +
          '(set PUBLIC_BASE_URL or SMS_STATUS_CALLBACK_URL — ' +
          'outbound status will stay at queued/sent)'
      );
    }
    const webhookProblem = webhookConfigProblem();
    console.log(
      webhookProblem
        ? `[token-server] twilio webhook signatures: NOT CONFIGURED (${webhookProblem}) — ` +
            'inbound calls, inbound SMS and delivery updates are refused; see server/README.md'
        : `[token-server] twilio webhook signatures: required, checked against ${cfg().publicBaseUrl}`
    );
    startRepair();
  }, (err) => {
    console.error(
      `[token-server] could not start on http://${HOST}:${PORT}: ${err.message}`
    );
    process.exit(1);
  });
}
