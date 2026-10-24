// A small client for the parts of Twilio's REST API the in-app setup uses:
// the account's phone numbers, API keys and TwiML Applications, and (read
// only) Messaging Services.
//
// Credentials are used as HTTP Basic auth and never appear in an error
// message, a log line or a return value. Every failure is a TwilioError
// whose `kind` says what went wrong in terms setup can act on:
//   invalid-credentials  Twilio refused the sign-in (HTTP 401)
//   forbidden            the credentials are valid but may not do this (403)
//   not-found            the resource does not exist (404)
//   rejected             Twilio refused the request (other 4xx)
//   unreachable          no answer, a timeout, or a Twilio-side error (5xx, 429)
//
// OPERATOR_TWILIO_API_BASE redirects every request to a fake Twilio on this
// machine for tests; anything but http://localhost or http://127.0.0.1 is
// ignored, so credentials cannot be sent to another host that way.

const http = require('http');
const https = require('https');

const DEFAULT_API = 'https://api.twilio.com';
const DEFAULT_MESSAGING = 'https://messaging.twilio.com';

class TwilioError extends Error {
  constructor(kind, message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'TwilioError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

// The two base URLs requests go to. A loopback fake serves both, with the
// messaging API under /messaging.
function resolveBases(env = process.env) {
  const override = env.OPERATOR_TWILIO_API_BASE;
  if (override) {
    try {
      const u = new URL(override);
      if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) {
        const origin = u.origin;
        return { api: origin, messaging: `${origin}/messaging` };
      }
    } catch (_) {
      // fall through to the real addresses
    }
  }
  return { api: DEFAULT_API, messaging: DEFAULT_MESSAGING };
}

function classify(status, body) {
  const message = (body && body.message) || `Twilio answered HTTP ${status}`;
  const code = body && body.code ? body.code : null;
  if (status === 401) return new TwilioError('invalid-credentials', message, { status, code });
  if (status === 403) return new TwilioError('forbidden', message, { status, code });
  if (status === 404) return new TwilioError('not-found', message, { status, code });
  if (status === 429 || status >= 500) return new TwilioError('unreachable', message, { status, code });
  return new TwilioError('rejected', message, { status, code });
}

// `auth` is { user, pass }. Resolves the parsed JSON body (null for an
// empty one, as after DELETE).
function request({ base, method, path, auth, form, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = form ? new URLSearchParams(form).toString() : '';
    const req = lib.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        agent: false,
        timeout: timeoutMs,
        headers: {
          Accept: 'application/json',
          Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64'),
          ...(payload
            ? {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          if (text) {
            try {
              body = JSON.parse(text);
            } catch (_) {
              body = null;
            }
          }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
          reject(classify(res.statusCode, body));
        });
      }
    );
    req.on('timeout', () =>
      req.destroy(new TwilioError('unreachable', 'Twilio did not answer in time.'))
    );
    req.on('error', (err) =>
      reject(
        err instanceof TwilioError
          ? err
          : new TwilioError('unreachable', `Could not reach Twilio (${err.code || err.message}).`)
      )
    );
    if (payload) req.write(payload);
    req.end();
  });
}

function capabilities(raw) {
  const c = (raw && raw.capabilities) || {};
  return { voice: Boolean(c.voice), sms: Boolean(c.sms), mms: Boolean(c.mms) };
}

// A number as setup uses it. Routes are kept as Twilio reports them.
function numberFrom(raw) {
  return {
    sid: raw.sid,
    e164: raw.phone_number,
    friendlyName: raw.friendly_name || raw.phone_number,
    capabilities: capabilities(raw),
    voiceUrl: raw.voice_url || '',
    voiceApplicationSid: raw.voice_application_sid || '',
    smsUrl: raw.sms_url || '',
    smsApplicationSid: raw.sms_application_sid || '',
    trunkSid: raw.trunk_sid || '',
  };
}

function appFrom(raw) {
  return {
    sid: raw.sid,
    friendlyName: raw.friendly_name || '',
    voiceUrl: raw.voice_url || '',
    smsUrl: raw.sms_url || '',
    smsStatusCallback: raw.sms_status_callback || '',
  };
}

// `accountSid` plus either the Auth Token (account-level work: keys, apps,
// numbers) or an API key and secret (checking that a stored key works).
function createApi({ accountSid, authToken, apiKey, apiSecret, env = process.env, timeoutMs }) {
  const bases = resolveBases(env);
  const auth = authToken
    ? { user: accountSid, pass: authToken }
    : { user: apiKey, pass: apiSecret };
  const root = `/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;
  const call = (method, p, form, base = bases.api) =>
    request({ base, method, path: p, auth, form, timeoutMs });

  return {
    // The read-only request Check account makes: it fails with
    // invalid-credentials for a wrong SID or token and lists the numbers.
    async listNumbers() {
      const body = await call('GET', `${root}/IncomingPhoneNumbers.json?PageSize=1000`);
      return {
        numbers: (body.incoming_phone_numbers || []).map(numberFrom),
        more: Boolean(body.next_page_uri),
      };
    },
    async getNumber(sid) {
      return numberFrom(await call('GET', `${root}/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`));
    },
    async updateNumber(sid, fields) {
      return numberFrom(
        await call('POST', `${root}/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, fields)
      );
    },
    async listApps() {
      const body = await call('GET', `${root}/Applications.json?PageSize=1000`);
      return (body.applications || []).map(appFrom);
    },
    async getApp(sid) {
      return appFrom(await call('GET', `${root}/Applications/${encodeURIComponent(sid)}.json`));
    },
    async createApp(fields) {
      return appFrom(await call('POST', `${root}/Applications.json`, fields));
    },
    async updateApp(sid, fields) {
      return appFrom(await call('POST', `${root}/Applications/${encodeURIComponent(sid)}.json`, fields));
    },
    async listKeys() {
      const body = await call('GET', `${root}/Keys.json?PageSize=1000`);
      return (body.keys || []).map((k) => ({ sid: k.sid, friendlyName: k.friendly_name || '' }));
    },
    // The only response that ever carries an API secret.
    async createKey(friendlyName) {
      const body = await call('POST', `${root}/Keys.json`, { FriendlyName: friendlyName });
      return { sid: body.sid, secret: body.secret, friendlyName: body.friendly_name || friendlyName };
    },
    async deleteKey(sid) {
      await call('DELETE', `${root}/Keys/${encodeURIComponent(sid)}.json`);
    },
    // A cheap authenticated read: does this sign-in work at all?
    async getAccount() {
      const body = await call('GET', `${root}.json`);
      return { sid: body.sid, status: body.status || null };
    },
    // The Messaging Service, if any, that holds this number. Best effort and
    // read only: a Messaging Service's own inbound setting overrides the
    // number's. Resolves { service: { sid, friendlyName } | null } or
    // { unknown: reason }.
    async messagingServiceFor(numberSid) {
      try {
        const services = await call('GET', '/v1/Services?PageSize=50', null, bases.messaging);
        for (const s of (services && services.services) || []) {
          const members = await call(
            'GET',
            `/v1/Services/${encodeURIComponent(s.sid)}/PhoneNumbers?PageSize=100`,
            null,
            bases.messaging
          );
          if (((members && members.phone_numbers) || []).some((m) => m.sid === numberSid)) {
            return { service: { sid: s.sid, friendlyName: s.friendly_name || '' } };
          }
        }
        return { service: null };
      } catch (err) {
        return { unknown: err.kind || 'error' };
      }
    },
  };
}

module.exports = { createApi, TwilioError, resolveBases, numberFrom };
