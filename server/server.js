// Local capability token broker for Operator.
//
// Listens on http://127.0.0.1:5050 by default. NEVER bind to 0.0.0.0 — this
// server has no auth and signs tokens with your Twilio API Secret.
//
// Required env (set in `server/.env` or the parent shell):
//   TWILIO_ACCOUNT_SID     — starts with AC…
//   TWILIO_API_KEY         — starts with SK…
//   TWILIO_API_SECRET      — the secret shown when the API Key was created
//   TWILIO_TWIML_APP_SID   — a Voice TwiML App SID (starts with AP…)

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// Optional:
//   PORT                   — default 5050
//
// The renderer asks main for a token via `window.operator.token.fetch(identity)`,
// main posts to this server's /token, this server signs the JWT and returns
// it. The auth token is never sent over the wire.

const http = require('http');
const path = require('path');
const twilio = require('twilio');
const { SmsStore, normalizeNumber, MAX_BODY_LENGTH } = require('./smsStore');

const PORT = parseInt(process.env.PORT || '5050', 10);
const HOST = process.env.HOST || '127.0.0.1';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_CALLER_ID,
  TWILIO_SMS_FROM, // optional: dedicated sender number; falls back to TWILIO_CALLER_ID
} = process.env;

// SMS persistence lives next to the token server so the renderer and the
// webhook can both read it. Override with SMS_STORE_PATH for tests.
const SMS_STORE_PATH =
  process.env.SMS_STORE_PATH ||
  path.join(__dirname, 'sms-store.json');
const smsStore = new SmsStore(SMS_STORE_PATH);

function requireEnv() {
  const missing = [];
  if (!TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID');
  if (!TWILIO_API_KEY) missing.push('TWILIO_API_KEY');
  if (!TWILIO_API_SECRET) missing.push('TWILIO_API_SECRET');
  if (!TWILIO_TWIML_APP_SID) missing.push('TWILIO_TWIML_APP_SID');
  if (missing.length) {
    console.error(
      '[token-server] Missing required env vars: ' + missing.join(', ')
    );
    console.error(
      '[token-server] See server/README.md for setup instructions.'
    );
    process.exit(1);
  }
  if (!TWILIO_CALLER_ID) {
    console.warn(
      '[token-server] TWILIO_CALLER_ID not set — outbound calls will fail ' +
        'with 31005. Add a verified Twilio number to server/.env.'
    );
  }
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

function send(res, status, body) {
  const text =
    typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type':
      typeof body === 'string' ? 'text/plain' : 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  // /token: localhost only — it returns auth-signed JWTs.
  // /twiml: must be reachable from Twilio's public webhook, so it does NOT
  // enforce the localhost guard. Auth on this endpoint is "knowing the
  // ngrok/tunnel URL" — the URL is unguessable, and we never put secrets in
  // the TwiML response.
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    return send(res, 200, { ok: true, ts: Date.now() });
  }

  if (url === '/token') {
    const remote = req.socket.remoteAddress || '';
    const isLocal =
      remote === '127.0.0.1' ||
      remote === '::1' ||
      remote === '::ffff:127.0.0.1';
    if (!isLocal) {
      return send(res, 403, { error: 'local only' });
    }
    if (req.method !== 'POST') {
      return send(res, 405, { error: 'method not allowed' });
    }
    return handleToken(req, res);
  }

  if (url === '/twiml' || url === '/') {
    // Both /twiml and the bare root return TwiML, so a TwiML App pointed
    // at the tunnel root still works. /health stays the only probe path.
    if (req.method !== 'GET' && req.method !== 'POST') {
      return send(res, 405, { error: 'method not allowed' });
    }
    return handleTwiml(req, res);
  }

  if (url === '/sms/send') {
    if (!isLocalRequest(req)) {
      return send(res, 403, { error: 'local only' });
    }
    if (req.method !== 'POST') {
      return send(res, 405, { error: 'method not allowed' });
    }
    return handleSmsSend(req, res);
  }

  if (url === '/sms/conversations') {
    if (!isLocalRequest(req)) {
      return send(res, 403, { error: 'local only' });
    }
    if (req.method !== 'GET') {
      return send(res, 405, { error: 'method not allowed' });
    }
    return handleSmsList(req, res);
  }

  if (url === '/sms/inbound') {
    // Public — Twilio's webhook must reach this without auth. See
    // handleSmsInbound for the v1 trust model.
    if (req.method !== 'GET' && req.method !== 'POST') {
      return send(res, 405, { error: 'method not allowed' });
    }
    return handleSmsInbound(req, res);
  }

  return send(res, 404, { error: 'not found' });
});

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
    const AccessToken = twilio.jwt.AccessToken;
    const { VoiceGrant } = AccessToken;

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY,
      TWILIO_API_SECRET,
      { identity, ttl: 3600 }
    );
    token.addGrant(
      new VoiceGrant({ outgoingApplicationSid: TWILIO_TWIML_APP_SID })
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

// TwiML response for outbound calls placed by the Operator client.
// Twilio POSTs to this URL with form-encoded params (or GETs with query
// string); we ignore the body and just emit TwiML based on the `To`
// parameter the client passed when it dialed.
//
// Routing rules:
//   - If `To` looks like a Client identity (matches the safe identifier
//     regex), emit <Dial><Client>…</Client></Dial> (Operator→Operator).
//   - If `To` looks like a phone number (E.164-ish: +, digits, spaces,
//     parens, dashes), emit <Dial>…</Dial> (PSTN).
//   - Otherwise 400 with an error TwiML so Twilio reads the message.
//
// The VoiceResponse helper escapes user input safely.
async function handleTwiml(req, res) {
  const params = await parseQueryAndBody(req);
  return renderTwiml(params, res);
}

function renderTwiml(params, res) {
  const to = (params.To || '').toString().trim();

  const { VoiceResponse } = twilio.twiml;
  const response = new VoiceResponse();

  if (!to) {
    response.say('No destination number was provided.');
    return sendTwiml(res, response);
  }

  if (/^[A-Za-z0-9_\-]{1,64}$/.test(to)) {
    // Operator-to-Operator (Client) call. callerId is required for Client
    // originations, even when both legs are clients.
    const dial = response.dial({ callerId: TWILIO_CALLER_ID });
    dial.client(to);
  } else if (/^\+?[0-9\s\-\(\)]{1,32}$/.test(to)) {
    // PSTN call. Pass the configured caller ID; Twilio rejects the call
    // with 31005 if this is missing on a Client-originated call.
    const dial = response.dial({ callerId: TWILIO_CALLER_ID });
    dial.number(to);
  } else {
    response.say('Invalid destination format.');
  }

  return sendTwiml(res, response);
}

function parseQueryAndBody(req) {
  // Combine query string and (form-encoded) body into one object.
  return new Promise((resolve, reject) => {
    const out = {};
    try {
      const u = new URL(req.url, 'http://localhost');
      u.searchParams.forEach((v, k) => (out[k] = v));
    } catch (_) {}
    // Drain body for POSTs. Most Twilio webhooks are GET, but some are POST.
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (text) {
          try {
            const sp = new URLSearchParams(text);
            sp.forEach((v, k) => (out[k] = v));
          } catch (e) {
            return reject(e);
          }
        }
        resolve(out);
      });
      req.on('error', reject);
    } else {
      resolve(out);
    }
  });
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

// Shared between /sms/* handlers. /token-style localhost guard.
// /sms/inbound is the only public endpoint, and it does its own
// content-type handling.
function isLocalRequest(req) {
  const remote = req.socket.remoteAddress || '';
  return (
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1'
  );
}

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

// Twilio's inbound webhook posts application/x-www-form-urlencoded.
// Reuse the same parser logic as handleTwiml but inline so we don't
// have to refactor that path.
function readFormBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const out = {};
      if (text) {
        try {
          const sp = new URLSearchParams(text);
          sp.forEach((v, k) => (out[k] = v));
        } catch (e) {
          return reject(e);
        }
      }
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

  const from = TWILIO_SMS_FROM || TWILIO_CALLER_ID;
  if (!from) {
    const failed = await smsStore._withLock(() => {
      placeholderMsg.status = 'failed';
      smsStore._persist();
    });
    return send(res, 500, {
      error: 'no outbound SMS number configured (set TWILIO_SMS_FROM or TWILIO_CALLER_ID)',
    });
  }

  try {
    const client = twilio(TWILIO_API_KEY, TWILIO_API_SECRET, {
      accountSid: TWILIO_ACCOUNT_SID,
    });
    const result = await client.messages.create({ to, from, body: text });
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
    console.error('[sms] send failed:', err.message);
    await smsStore._withLock(() => {
      const conv = smsStore._data[to];
      if (conv) {
        const m = conv.messages.find((x) => x === placeholderMsg);
        if (m) m.status = 'failed';
        smsStore._persist();
      }
    });
    return send(res, 502, { error: 'twilio send failed', detail: err.message });
  }
}

async function handleSmsInbound(req, res) {
  // Public endpoint — anyone who knows the ngrok URL can POST here, but
  // Twilio's webhook signature is the proper auth. For v1 we accept any
  // well-formed Twilio form body; signature verification is a v2 item.
  let params;
  try {
    params = await readFormBody(req);
  } catch (err) {
    // Twilio expects TwiML even on error so it doesn't retry forever.
    res.writeHead(400, { 'Content-Type': 'text/xml; charset=utf-8' });
    res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Invalid request.</Say></Response>');
    return;
  }

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

function handleSmsList(req, res) {
  // Optional ?number=+1… to fetch a single thread in full.
  const url = new URL(req.url, 'http://localhost');
  const numParam = url.searchParams.get('number');
  if (numParam) {
    const conv = smsStore.getConversation(numParam);
    if (!conv) return send(res, 404, { error: 'no such conversation' });
    return send(res, 200, conv);
  }
  return send(res, 200, { conversations: smsStore.listConversations() });
}

requireEnv();
server.listen(PORT, HOST, () => {
  console.log(
    `[token-server] listening on http://${HOST}:${PORT} ` +
      `(account ${TWILIO_ACCOUNT_SID.slice(0, 6)}…)`
  );
  console.log(
    `[token-server] sms store: ${SMS_STORE_PATH}` +
      (TWILIO_SMS_FROM || TWILIO_CALLER_ID
        ? ` · sender: ${TWILIO_SMS_FROM || TWILIO_CALLER_ID}`
        : ' · sender: NOT CONFIGURED (sms/send will 500)')
  );
});
