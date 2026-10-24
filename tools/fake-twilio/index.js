// A fictional Twilio account on 127.0.0.1, for testing the in-app setup
// without any real provider, credential or phone number. It serves the
// parts of Twilio's REST API server/twilioApi.js calls, keeps its state in
// memory, answers with Twilio's JSON shapes and status codes, and records
// every request (credentials are never recorded) so a test can assert what
// was and was not written.
//
//   const fake = await startFakeTwilio();
//   process.env.OPERATOR_TWILIO_API_BASE = fake.base;
//   ...
//   await fake.close();

const crypto = require('crypto');
const http = require('http');

const hex = (n) => crypto.randomBytes(n).toString('hex');

const ACCOUNT_SID = 'AC' + '1'.repeat(32);
const AUTH_TOKEN = 'fictional-auth-token-0001';

function startFakeTwilio({ accountSid = ACCOUNT_SID, authToken = AUTH_TOKEN } = {}) {
  const state = {
    numbers: [],
    apps: [],
    keys: [], // { sid, secret, friendly_name }
    services: [], // { sid, friendly_name, numberSids: [] }
    media: new Map(), // pathname -> { bytes, type, status, redirectTo, auth }
  };
  const requests = [];
  let unreachable = false;
  const failures = [];
  const droppedResponses = [];
  let ignoredVoiceUrlUpdates = 0;

  function addNumber(fields = {}) {
    const n = {
      sid: 'PN' + hex(16),
      phone_number: '+15555550100',
      friendly_name: fields.phone_number || '+15555550100',
      capabilities: { voice: true, sms: true, mms: true, fax: false },
      voice_url: '',
      voice_application_sid: '',
      sms_url: '',
      sms_application_sid: '',
      trunk_sid: '',
      ...fields,
    };
    state.numbers.push(n);
    return n;
  }
  function addApp(fields = {}) {
    const a = {
      sid: 'AP' + hex(16),
      friendly_name: 'Some other app',
      voice_url: '',
      sms_url: '',
      sms_status_callback: '',
      ...fields,
    };
    state.apps.push(a);
    return a;
  }
  function addKey(friendlyName = 'Some key') {
    const k = { sid: 'SK' + hex(16), secret: hex(16), friendly_name: friendlyName };
    state.keys.push(k);
    return k;
  }
  function addService(friendlyName, numberSids = []) {
    const s = { sid: 'MG' + hex(16), friendly_name: friendlyName, numberSids };
    state.services.push(s);
    return s;
  }

  // A photo of an incoming message, as the media URL in a webhook points to it.
  // `redirectTo` is a full URL to redirect to instead of serving the bytes.
  // `cdn: true` redirects to a /cdn/ path on this fake that serves the bytes
  // without credentials, as Twilio's real media CDN does. Resolves the media
  // URL (and the CDN one) once the fake is listening: see addMedia below.
  // `gate` is a promise the fake waits for before answering, so a test can
  // hold a download open and see the photo while it is still pending.
  function registerMedia({ bytes = Buffer.alloc(0), type = 'image/jpeg', status = 200, redirectTo = null, cdn = false, gate = null, accountSid: sid = accountSid } = {}) {
    const mediaPath = `/2010-04-01/Accounts/${sid}/Messages/MM${hex(16)}/Media/ME${hex(16)}`;
    const cdnPath = cdn ? `/cdn/${hex(16)}` : null;
    state.media.set(mediaPath, { bytes, type, status, redirectTo, cdnPath, gate, auth: true });
    if (cdnPath) state.media.set(cdnPath, { bytes, type, status, redirectTo: null, cdnPath: null, gate, auth: false });
    return { mediaPath, cdnPath };
  }

  function authorised(header) {
    const m = /^Basic (.+)$/.exec(header || '');
    if (!m) return false;
    const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    const pass = rest.join(':');
    if (user === accountSid && pass === authToken) return 'token';
    const key = state.keys.find((k) => k.sid === user);
    return key && key.secret === pass ? 'key' : false;
  }

  const send = (res, status, body) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };
  const missing = (res) => send(res, 404, { code: 20404, message: 'The requested resource was not found', status: 404 });

  const server = http.createServer((req, res) => {
    if (unreachable) return req.socket.destroy();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://fake');
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      const entry = {
        method: req.method,
        path: url.pathname,
        form,
        auth: authorised(req.headers.authorization),
        hasAuthHeader: Boolean(req.headers.authorization),
      };
      requests.push(entry);
      const served = state.media.get(url.pathname);
      if (served && req.method === 'GET') {
        if (served.auth && !entry.auth) return send(res, 401, { code: 20003, message: 'Authenticate', status: 401 });
        if (served.gate) await served.gate;
        const origin = `http://127.0.0.1:${server.address().port}`;
        const location = served.cdnPath ? origin + served.cdnPath : served.redirectTo;
        if (location) {
          res.writeHead(307, { Location: location });
          return res.end();
        }
        res.writeHead(served.status, { 'Content-Type': served.type, 'Content-Length': served.bytes.length });
        return res.end(served.bytes);
      }
      const failure = failures.findIndex((f) => f.method === req.method && f.pattern.test(url.pathname));
      if (failure >= 0) {
        const f = failures[failure];
        if (!f.persist) failures.splice(failure, 1);
        if (f.drop) return req.socket.destroy();
        return send(res, f.status, { code: f.code || 0, message: f.message || 'Injected failure', status: f.status });
      }
      if (!entry.auth) {
        return send(res, 401, { code: 20003, message: 'Authenticate', status: 401 });
      }
      const droppedResponse = droppedResponses.findIndex((d) => d.method === req.method && d.pattern.test(url.pathname));
      if (droppedResponse >= 0) {
        droppedResponses.splice(droppedResponse, 1);
        return route(req.method, url, form, {
          writeHead() {
            return this;
          },
          end() {
            req.socket.destroy();
          },
        }, entry.auth);
      }
      route(req.method, url, form, res, entry.auth);
    });
  });

  function route(method, url, form, res, auth) {
    const p = url.pathname;
    let m;
    if ((m = /^\/messaging\/v1\/Services$/.exec(p)) && method === 'GET') {
      return send(res, 200, { services: state.services.map((s) => ({ sid: s.sid, friendly_name: s.friendly_name })), meta: { next_page_url: state.moreServices ? 'next' : null } });
    }
    if ((m = /^\/messaging\/v1\/Services\/(MG[0-9a-f]+)\/PhoneNumbers$/.exec(p)) && method === 'GET') {
      const s = state.services.find((x) => x.sid === m[1]);
      if (!s) return missing(res);
      return send(res, 200, { phone_numbers: s.numberSids.map((sid) => ({ sid })), meta: { next_page_url: s.moreNumbers ? 'next' : null } });
    }
    const base = `/2010-04-01/Accounts/${accountSid}`;
    if (!p.startsWith(base)) return missing(res);
    const rest = p.slice(base.length);
    if (rest === '.json' && method === 'GET') return send(res, 200, { sid: accountSid, status: 'active' });
    if (rest === '/IncomingPhoneNumbers.json' && method === 'GET') {
      return send(res, 200, { incoming_phone_numbers: state.numbers, next_page_uri: null });
    }
    if ((m = /^\/IncomingPhoneNumbers\/(PN[0-9a-f]+)\.json$/.exec(rest))) {
      const n = state.numbers.find((x) => x.sid === m[1]);
      if (!n) return missing(res);
      if (method === 'GET') return send(res, 200, n);
      if (method === 'POST') {
        // Setting an application replaces the number's own URL, as Twilio does.
        if ('VoiceApplicationSid' in form) {
          n.voice_application_sid = form.VoiceApplicationSid;
          n.voice_url = '';
          n.trunk_sid = '';
        }
        if ('SmsApplicationSid' in form) {
          n.sms_application_sid = form.SmsApplicationSid;
          n.sms_url = '';
        }
        return send(res, 200, n);
      }
    }
    if (rest === '/Applications.json') {
      if (method === 'GET') return send(res, 200, { applications: state.apps });
      if (method === 'POST') {
        const a = addApp({
          friendly_name: form.FriendlyName,
          voice_url: form.VoiceUrl || '',
          sms_url: form.SmsUrl || '',
          sms_status_callback: form.SmsStatusCallback || '',
        });
        return send(res, 201, a);
      }
    }
    if ((m = /^\/Applications\/(AP[0-9a-f]+)\.json$/.exec(rest))) {
      const a = state.apps.find((x) => x.sid === m[1]);
      if (!a) return missing(res);
      if (method === 'GET') return send(res, 200, a);
      if (method === 'POST') {
        if ('FriendlyName' in form) a.friendly_name = form.FriendlyName;
        if ('VoiceUrl' in form && ignoredVoiceUrlUpdates === 0) a.voice_url = form.VoiceUrl;
        else if ('VoiceUrl' in form) ignoredVoiceUrlUpdates -= 1;
        if ('SmsUrl' in form) a.sms_url = form.SmsUrl;
        if ('SmsStatusCallback' in form) a.sms_status_callback = form.SmsStatusCallback;
        return send(res, 200, a);
      }
    }
    if (rest === '/Keys.json') {
      if (method === 'GET') {
        return send(res, 200, { keys: state.keys.map((k) => ({ sid: k.sid, friendly_name: k.friendly_name })) });
      }
      if (method === 'POST') {
        // Keys can only be created with the account's own Auth Token.
        if (auth !== 'token') return send(res, 403, { code: 20003, message: 'Permission denied', status: 403 });
        const k = addKey(form.FriendlyName);
        return send(res, 201, { sid: k.sid, secret: k.secret, friendly_name: k.friendly_name });
      }
    }
    if ((m = /^\/Keys\/(SK[0-9a-f]+)\.json$/.exec(rest))) {
      const i = state.keys.findIndex((x) => x.sid === m[1]);
      if (i < 0) return missing(res);
      if (method === 'DELETE') {
        state.keys.splice(i, 1);
        res.writeHead(204);
        return res.end();
      }
      if (method === 'GET') return send(res, 200, { sid: m[1], friendly_name: state.keys[i].friendly_name });
    }
    return missing(res);
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        accountSid,
        authToken,
        state,
        requests,
        addNumber,
        addApp,
        addKey,
        addService,
        addMedia: (spec) => {
          const { mediaPath, cdnPath } = registerMedia(spec);
          const origin = `http://127.0.0.1:${server.address().port}`;
          return { url: origin + mediaPath, cdnUrl: cdnPath ? origin + cdnPath : null };
        },
        // Requests that changed something (everything but GET).
        writes: () => requests.filter((r) => r.method !== 'GET'),
        clearRequests: () => requests.splice(0),
        setUnreachable: (v) => {
          unreachable = v;
        },
        // The next matching request (or every one, with persist) fails.
        failNext: (method, pattern, fields = {}) => failures.push({ method, pattern, status: 500, ...fields }),
        dropNextResponse: (method, pattern) => droppedResponses.push({ method, pattern }),
        ignoreNextVoiceUrlUpdate: () => {
          ignoredVoiceUrlUpdates += 1;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startFakeTwilio, ACCOUNT_SID, AUTH_TOKEN };
