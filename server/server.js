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
const twilio = require('twilio');

const PORT = parseInt(process.env.PORT || '5050', 10);
const HOST = process.env.HOST || '127.0.0.1';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  TWILIO_TWIML_APP_SID,
} = process.env;

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

  if (url === '/twiml') {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return send(res, 405, { error: 'method not allowed' });
    }
    return handleTwiml(req, res);
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
function handleTwiml(req, res) {
  const params = parseQueryAndBody(req);
  const to = (params.To || '').toString().trim();

  const { VoiceResponse } = twilio.twiml;
  const response = new VoiceResponse();

  if (!to) {
    response.say('No destination number was provided.');
    return sendTwiml(res, response);
  }

  if (/^[A-Za-z0-9_\-]{1,64}$/.test(to)) {
    // Operator-to-Operator (Client) call.
    const dial = response.dial({ callerId: undefined });
    dial.client(to);
  } else if (/^\+?[0-9\s\-\(\)]{1,32}$/.test(to)) {
    // PSTN call. Twilio will use the account's default callerId unless
    // the TwiML App has one configured.
    const dial = response.dial();
    dial.number(to);
  } else {
    response.say('Invalid destination format.');
  }

  return sendTwiml(res, response);
}

function parseQueryAndBody(req) {
  // Combine query string and (form-encoded) body into one object.
  // For GET, there's no body — for POST, Twilio posts form-urlencoded.
  const out = {};
  try {
    const u = new URL(req.url, 'http://localhost');
    u.searchParams.forEach((v, k) => (out[k] = v));
  } catch (_) {}
  return out;
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

requireEnv();
server.listen(PORT, HOST, () => {
  console.log(
    `[token-server] listening on http://${HOST}:${PORT} ` +
      `(account ${TWILIO_ACCOUNT_SID.slice(0, 6)}…)`
  );
});
