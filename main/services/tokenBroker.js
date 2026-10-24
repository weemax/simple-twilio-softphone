// Capability token broker.
//
// In production we expect the renderer to call a serverless function or
// backend that signs a Twilio AccessToken with Voice grants. The main
// process can either:
//   (a) call that backend itself (default), or
//   (b) when TWILIO_ACCOUNT_SID + TWILIO_API_KEY + TWILIO_API_SECRET +
//       TWILIO_TWIML_APP_SID are set in the main-process env, mint the
//       token directly using @twilio/AccessToken (skipping the network).
//
// Either way, the Auth Token / API Secret never crosses the IPC boundary —
// the renderer only ever sees the JWT.

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { localAuthHeaders } = require('./localApiAuth');

const TOKEN_BACKEND_URL = process.env.TOKEN_BACKEND_URL || 'http://127.0.0.1:5050/token'; // default to local token server
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_API_KEY = process.env.TWILIO_API_KEY || '';
const TWILIO_API_SECRET = process.env.TWILIO_API_SECRET || '';
const TWILIO_TWIML_APP_SID = process.env.TWILIO_TWIML_APP_SID || '';

let cached = null;
const CACHE_TTL_MS = 50 * 60 * 1000; // ~50 minutes (token TTL is 1h)

function canMintDirectly() {
  return Boolean(
    TWILIO_ACCOUNT_SID &&
      TWILIO_API_KEY &&
      TWILIO_API_SECRET &&
      TWILIO_TWIML_APP_SID
  );
}

async function fetchFromBackend(identity) {
  if (!TOKEN_BACKEND_URL) {
    throw new Error(
      'TOKEN_BACKEND_URL is not set. Start the local token server (see server/) or configure Twilio Functions.'
    );
  }
  const url = new URL(TOKEN_BACKEND_URL);
  const lib = url.protocol === 'https:' ? https : http;
  const body = JSON.stringify({ identity });

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...localAuthHeaders(url),
        },
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              new Error(`Token backend ${res.statusCode}: ${text}`)
            );
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error(`Token backend returned invalid JSON: ${text}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Token backend timed out'));
    });
    req.write(body);
    req.end();
  });
}

async function mintDirectly(identity) {
  // Lazy-require so the dependency is only needed in this branch.
  const { AccessToken } = require('@twilio/voice-sdk').jwt ||
    require('@twilio/voice-sdk');
  // The voice SDK doesn't ship an AccessToken helper; use the dedicated
  // twilio package or @twilio/access-token if installed.
  let tokenLib;
  try {
    tokenLib = require('@twilio/access-token').AccessToken;
  } catch (e) {
    throw new Error(
      'Direct minting requires the `twilio` or `@twilio/access-token` package on the main process. Install it or set TOKEN_BACKEND_URL.'
    );
  }
  const { VoiceGrant } = tokenLib;
  const token = new tokenLib(
    TWILIO_ACCOUNT_SID,
    TWILIO_API_KEY,
    TWILIO_API_SECRET,
    { identity, ttl: 3600 }
  );
  token.addGrant(new VoiceGrant({ outgoingApplicationSid: TWILIO_TWIML_APP_SID }));
  return { token: token.toJwt(), identity };
}

async function fetchToken(identity) {
  if (!identity || typeof identity !== 'string') {
    throw new Error('identity is required');
  }
  // Tiny in-process cache: if the same identity asks again within TTL,
  // return the cached token.
  const now = Date.now();
  if (cached && cached.identity === identity && now - cached.at < CACHE_TTL_MS) {
    return { token: cached.token, identity, cached: true };
  }
  const result = canMintDirectly()
    ? await mintDirectly(identity)
    : await fetchFromBackend(identity);
  cached = { identity, token: result.token, at: now };
  return { token: result.token, identity, cached: false };
}

// Forget the cached token. Setup calls this after it replaces the API key or
// the TwiML Application, so the next registration signs with the new ones
// instead of reusing a token the old ones issued.
function invalidateCache() {
  cached = null;
}

module.exports = { fetchToken, canMintDirectly, invalidateCache };
