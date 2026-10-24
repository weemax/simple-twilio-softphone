/**
 * @jest-environment node
 */
// TWP-7: a tunnel such as ngrok reaches the token server from 127.0.0.1, so
// the loopback check alone let anyone holding the tunnel URL fetch call
// tokens, read SMS history and send billable SMS. These tests put a
// tunnel-shaped proxy (loopback connection, public Host, the X-Forwarded-*
// headers ngrok documents) in front of the real server and check that only
// Twilio's webhooks get through, while the app's own brokers still work.
//
// TWP-8: anyone holding the tunnel URL could also post unsigned webhooks
// and forge inbound SMS, delivery updates and calls. Through the same
// tunnel, the webhooks now need Twilio's signature over the exact public
// URL and every parameter; the requests here are signed the way Twilio
// documents (checked against Twilio's own worked example below).
// Fake credentials and fictional data only; nothing here reaches Twilio.

// TWP-9 truthful send outcomes: recorded SDK error shapes, never a provider call.
jest.mock('../server/node_modules/twilio', () => {
  const real = jest.requireActual('../server/node_modules/twilio');
  const client = () => ({ messages: { create: async params => {
    if (params.body === 'The destination rejected this test message.') throw Object.assign(new Error('Invalid To phone number'), {status:400,code:21211});
    throw Object.assign(new Error('Connection ended before a response'), {code:'ETIMEDOUT'});
  } } });
  return Object.assign(client, real);
});

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PUBLIC_HOST = 'fictional-softphone.ngrok-free.app';
const PUBLIC_BASE_URL = `https://${PUBLIC_HOST}`;
const AUTH_TOKEN = 'fictional-auth-token-for-tests-0001';
const FICTIONAL_NUMBER = '+15555550123';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-private-'));
const storePath = path.join(workDir, 'sms-store.json');
const keyPath = path.join(workDir, 'local-api-key');

const ENV = {
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_API_KEY: 'SK00000000000000000000000000000000',
  TWILIO_API_SECRET: 'fake-secret-for-tests-only',
  TWILIO_TWIML_APP_SID: 'AP00000000000000000000000000000000',
  TWILIO_CALLER_ID: '+15555550100',
  OPERATOR_IDENTITY: 'operator',
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  PUBLIC_BASE_URL,
  SMS_PUBLIC_BASE_URL: undefined,
  SMS_STATUS_CALLBACK_URL: undefined,
  SMS_STORE_PATH: storePath,
  OPERATOR_LOCAL_API_KEY_FILE: keyPath,
  TOKEN_BACKEND_URL: undefined,
  SMS_BACKEND_URL: undefined,
};
const previousEnv = {};
for (const [k, v] of Object.entries(ENV)) {
  previousEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

// Same shape server/smsStore.js persists.
fs.writeFileSync(
  storePath,
  JSON.stringify({
    [FICTIONAL_NUMBER]: {
      number: FICTIONAL_NUMBER,
      lastMessageAt: 1761264000000,
      lastBody: 'See you at the depot at 9.',
      messages: [
        {
          sid: 'SM00000000000000000000000000000001',
          direction: 'inbound',
          body: 'See you at the depot at 9.',
          at: 1761264000000,
          status: 'received',
        },
      ],
    },
  })
);

const { startServer } = require('../server/server');
const { localAuthHeaders } = require('../main/services/localApiAuth');

let server;
let tunnel;
let port;
let tunnelPort;
let tokenBroker;
let smsBroker;

function request(targetPort, { method = 'GET', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: targetPort, method, path: p, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// What ngrok does to a public request before it reaches the upstream: it
// connects from this machine, keeps the public Host, and adds
// X-Forwarded-For / -Proto / -Host (https://ngrok.com/docs/http/).
function startTunnel(upstreamPort) {
  const proxy = http.createServer((req, res) => {
    const up = http.request(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        method: req.method,
        path: req.url,
        agent: false,
        headers: {
          ...req.headers,
          host: PUBLIC_HOST,
          'x-forwarded-for': '203.0.113.7',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': PUBLIC_HOST,
        },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      }
    );
    req.pipe(up);
  });
  return new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(proxy)));
}

const json = { 'Content-Type': 'application/json' };
const form = { 'Content-Type': 'application/x-www-form-urlencoded' };

function storedMessages() {
  return JSON.parse(fs.readFileSync(storePath, 'utf8'));
}

// X-Twilio-Signature as Twilio's security docs describe it, written here
// rather than taken from the server's SDK: the full URL (query string
// included), then each POST parameter's name and value sorted by name,
// HMAC-SHA1 keyed with the Auth Token, base64.
function twilioSignature(url, params = {}, authToken = AUTH_TOKEN) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, name) => acc + name + params[name], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

// A webhook POST through the tunnel. `signedFor` is the URL, and `signed`
// the parameters, the signature covers; by default exactly what is sent.
function postWebhook(p, params, { signedFor = PUBLIC_BASE_URL + p, signed = params, signature } = {}) {
  return request(tunnelPort, {
    method: 'POST',
    path: p,
    headers: {
      ...form,
      'X-Twilio-Signature': signature === undefined ? twilioSignature(signedFor, signed) : signature,
    },
    body: new URLSearchParams(params).toString(),
  });
}

function unsignedPost(p, params) {
  return request(tunnelPort, {
    method: 'POST',
    path: p,
    headers: form,
    body: new URLSearchParams(params).toString(),
  });
}

// The parameters Twilio sends with each webhook (fictional values).
const INBOUND_SMS = {
  ToCountry: 'US',
  ToState: 'CA',
  SmsMessageSid: 'SM00000000000000000000000000000002',
  NumMedia: '0',
  ToCity: 'SAN FRANCISCO',
  FromZip: '94105',
  SmsSid: 'SM00000000000000000000000000000002',
  FromState: 'CA',
  SmsStatus: 'received',
  FromCity: 'SAN FRANCISCO',
  Body: 'Running ten minutes late.',
  FromCountry: 'US',
  To: '+15555550100',
  ToZip: '94105',
  NumSegments: '1',
  MessageSid: 'SM00000000000000000000000000000002',
  AccountSid: ENV.TWILIO_ACCOUNT_SID,
  From: '+15555550199',
  ApiVersion: '2010-04-01',
};
const DELIVERY_STATUS = {
  SmsSid: 'SM00000000000000000000000000000001',
  SmsStatus: 'delivered',
  MessageStatus: 'delivered',
  To: FICTIONAL_NUMBER,
  MessageSid: 'SM00000000000000000000000000000001',
  AccountSid: ENV.TWILIO_ACCOUNT_SID,
  From: '+15555550100',
  ApiVersion: '2010-04-01',
};
const INBOUND_CALL = {
  AccountSid: ENV.TWILIO_ACCOUNT_SID,
  ApiVersion: '2010-04-01',
  CallSid: 'CA00000000000000000000000000000001',
  CallStatus: 'ringing',
  Called: '+15555550100',
  CalledCountry: 'US',
  Caller: '+15555550199',
  CallerCountry: 'US',
  Direction: 'inbound',
  From: '+15555550199',
  FromCountry: 'US',
  To: '+15555550100',
  ToCountry: 'US',
};

// The server logs why it refused each webhook.
let warn;

beforeAll(async () => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  server = await startServer({ port: 0, host: '127.0.0.1' });
  port = server.address().port;
  tunnel = await startTunnel(port);
  tunnelPort = tunnel.address().port;

  // The Electron main process has no Twilio credentials of its own; without
  // these it would try to mint tokens itself instead of asking the server.
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_API_KEY;
  delete process.env.TWILIO_API_SECRET;
  delete process.env.TWILIO_TWIML_APP_SID;
  process.env.TOKEN_BACKEND_URL = `http://127.0.0.1:${port}/token`;
  process.env.SMS_BACKEND_URL = `http://127.0.0.1:${port}`;
  tokenBroker = require('../main/services/tokenBroker');
  smsBroker = require('../main/services/smsBroker');
});

afterAll(async () => {
  warn.mockRestore();
  for (const s of [tunnel, server]) {
    if (!s) continue;
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(previousEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('through a tunnel', () => {
  it('refuses call tokens, SMS history and sending', async () => {
    const before = storedMessages();

    const token = await request(tunnelPort, {
      method: 'POST',
      path: '/token',
      headers: json,
      body: JSON.stringify({ identity: 'operator' }),
    });
    const history = await request(tunnelPort, { path: '/sms/conversations' });
    const thread = await request(tunnelPort, {
      path: `/sms/conversations?number=${encodeURIComponent(FICTIONAL_NUMBER)}`,
    });
    // An invalid `to` keeps a broken guard from ever reaching Twilio: it
    // would answer 400 from validation instead of 403.
    const sendSms = await request(tunnelPort, {
      method: 'POST',
      path: '/sms/send',
      headers: json,
      body: JSON.stringify({ to: 'not-a-number', body: 'billable?' }),
    });

    for (const res of [token, history, thread, sendSms]) {
      expect(res.status).toBe(403);
      expect(res.body).not.toContain('eyJ'); // no JWT
      expect(res.body).not.toContain('depot'); // no message text
    }
    expect(storedMessages()).toEqual(before);
  });

  it('refuses a private route even when the request carries the local key', async () => {
    const res = await request(tunnelPort, {
      method: 'POST',
      path: '/token',
      headers: { ...json, Authorization: `Bearer ${fs.readFileSync(keyPath, 'utf8').trim()}` },
      body: JSON.stringify({ identity: 'operator' }),
    });

    expect(res.status).toBe(403);
  });

  it('keeps serving the voice webhook to inbound calls Twilio signed', async () => {
    const res = await postWebhook('/twiml', INBOUND_CALL);

    expect(res.status).toBe(200);
    expect(res.body).toContain('<Client>operator</Client>');
  });

  // The server reads only a few of these parameters; the signature covers
  // them all, so the check passes only if every one is included.
  it('keeps accepting inbound SMS and delivery status webhooks Twilio signed', async () => {
    const inbound = await postWebhook('/sms/inbound', INBOUND_SMS);
    const status = await postWebhook('/sms/status', DELIVERY_STATUS);
    const health = await request(tunnelPort, { path: '/health' });

    expect(inbound.status).toBe(200);
    expect(storedMessages()['+15555550199'].messages[0].body).toBe(
      'Running ten minutes late.'
    );
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body).updated).toBe(true);
    expect(storedMessages()[FICTIONAL_NUMBER].messages[0].status).toBe('delivered');
    expect(health.status).toBe(200);
  });
});

describe('Twilio webhook signatures through a tunnel', () => {
  it("signs test requests exactly like Twilio's documented example", () => {
    // https://www.twilio.com/docs/usage/security#validating-requests
    const signature = twilioSignature(
      'https://example.com/myapp.php?foo=1&bar=2',
      {
        CallSid: 'CA1234567890ABCDE',
        Caller: '+14158675310',
        Digits: '1234',
        From: '+14158675310',
        To: '+18005551212',
      },
      '12345'
    );

    expect(signature).toBe('L/OH5YylLD5NRKLltdqwSvS0BnU=');
  });

  it('refuses unsigned inbound SMS, delivery updates and calls', async () => {
    const before = storedMessages();
    const forgedSms = { ...INBOUND_SMS, From: FICTIONAL_NUMBER, Body: 'This is your bank. Reply with your PIN.' };

    const results = [
      await unsignedPost('/sms/inbound', forgedSms),
      await unsignedPost('/sms/status', { ...DELIVERY_STATUS, MessageStatus: 'failed', SmsStatus: 'failed' }),
      await unsignedPost('/twiml', INBOUND_CALL),
      await unsignedPost('/', INBOUND_CALL),
    ];

    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    for (const r of results) expect(r.body).not.toContain('<Dial');
    expect(storedMessages()).toEqual(before);
  });

  it('refuses a signature made with another Auth Token', async () => {
    const before = storedMessages();

    const res = await postWebhook('/sms/inbound', INBOUND_SMS, {
      signature: twilioSignature(PUBLIC_BASE_URL + '/sms/inbound', INBOUND_SMS, 'some-other-auth-token'),
    });

    expect(res.status).toBe(403);
    expect(storedMessages()).toEqual(before);
  });

  it('refuses a signature for any URL other than the exact public one', async () => {
    const before = storedMessages();

    const results = [
      // The URL this server itself sees behind the tunnel.
      await postWebhook('/sms/inbound', INBOUND_SMS, { signedFor: 'http://127.0.0.1:5050/sms/inbound' }),
      await postWebhook('/sms/inbound', INBOUND_SMS, { signedFor: `http://${PUBLIC_HOST}/sms/inbound` }),
      await postWebhook('/sms/inbound', INBOUND_SMS, {
        signedFor: 'https://another-softphone.ngrok-free.app/sms/inbound',
      }),
      // A genuine delivery-update signature replayed on another webhook.
      await postWebhook('/sms/inbound', DELIVERY_STATUS, { signedFor: PUBLIC_BASE_URL + '/sms/status' }),
    ];

    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect(storedMessages()).toEqual(before);
  });

  it('refuses a signed request whose parameters were added, dropped or changed', async () => {
    const before = storedMessages();
    const { ToCity, ...withoutToCity } = INBOUND_SMS;

    const results = [
      await postWebhook('/sms/inbound', { ...INBOUND_SMS, Body: 'Send the code to this number.' }, { signed: INBOUND_SMS }),
      await postWebhook('/sms/inbound', { ...INBOUND_SMS, From: FICTIONAL_NUMBER }, { signed: INBOUND_SMS }),
      await postWebhook('/sms/inbound', { ...INBOUND_SMS, NumMedia: '1', MediaUrl0: 'https://example.com/a.jpg' }, { signed: INBOUND_SMS }),
      await postWebhook('/sms/inbound', withoutToCity, { signed: INBOUND_SMS }),
      await postWebhook('/sms/status', { ...DELIVERY_STATUS, MessageStatus: 'failed' }, { signed: DELIVERY_STATUS }),
    ];

    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    expect(storedMessages()).toEqual(before);
  });

  // HANDOFF §3: the TwiML App's Voice URL may use GET.
  it('accepts a signed voice webhook sent with GET', async () => {
    const p = `/twiml?${new URLSearchParams(INBOUND_CALL)}`;

    const signed = await request(tunnelPort, {
      path: p,
      headers: { 'X-Twilio-Signature': twilioSignature(PUBLIC_BASE_URL + p) },
    });
    const unsigned = await request(tunnelPort, { path: p });

    expect(signed.status).toBe(200);
    expect(signed.body).toContain('<Client>operator</Client>');
    expect(unsigned.status).toBe(403);
  });

  // HANDOFF §3: a Voice URL may be the bare tunnel address, which Twilio
  // signs exactly as it is written in the console.
  it('accepts a signed voice webhook at the tunnel root, with or without the slash', async () => {
    const withSlash = await postWebhook('/', INBOUND_CALL, { signedFor: PUBLIC_BASE_URL + '/' });
    const bare = await postWebhook('/', INBOUND_CALL, { signedFor: PUBLIC_BASE_URL });

    expect([withSlash.status, bare.status]).toEqual([200, 200]);
    expect(bare.body).toContain('<Client>operator</Client>');
  });
});

describe('Twilio webhooks without the signature settings', () => {
  // A second copy of the server with its own store and key file, started
  // without TWILIO_AUTH_TOKEN: it must refuse webhooks, not skip the check.
  const unconfiguredStore = path.join(workDir, 'unconfigured-sms-store.json');
  let unconfigured;
  let unconfiguredTunnel;
  const saved = {};

  beforeAll(async () => {
    for (const k of ['TWILIO_AUTH_TOKEN', 'SMS_STORE_PATH', 'OPERATOR_LOCAL_API_KEY_FILE']) {
      saved[k] = process.env[k];
    }
    delete process.env.TWILIO_AUTH_TOKEN;
    process.env.SMS_STORE_PATH = unconfiguredStore;
    process.env.OPERATOR_LOCAL_API_KEY_FILE = path.join(workDir, 'unconfigured-local-api-key');
    let isolated;
    jest.isolateModules(() => {
      isolated = require('../server/server');
    });
    unconfigured = await isolated.startServer({ port: 0, host: '127.0.0.1' });
    unconfiguredTunnel = await startTunnel(unconfigured.address().port);
  });

  afterAll(async () => {
    for (const s of [unconfiguredTunnel, unconfigured]) {
      if (!s) continue;
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('refuses every webhook, signed or not', async () => {
    const port = unconfiguredTunnel.address().port;
    const post = (p, params, signature) =>
      request(port, {
        method: 'POST',
        path: p,
        headers: { ...form, ...(signature ? { 'X-Twilio-Signature': signature } : {}) },
        body: new URLSearchParams(params).toString(),
      });

    const results = [
      await post('/sms/inbound', INBOUND_SMS),
      await post('/sms/inbound', INBOUND_SMS, twilioSignature(PUBLIC_BASE_URL + '/sms/inbound', INBOUND_SMS)),
      await post('/sms/status', DELIVERY_STATUS, twilioSignature(PUBLIC_BASE_URL + '/sms/status', DELIVERY_STATUS)),
      await post('/twiml', INBOUND_CALL, twilioSignature(PUBLIC_BASE_URL + '/twiml', INBOUND_CALL)),
    ];

    expect(results.map((r) => r.status)).toEqual([503, 503, 503, 503]);
    expect(fs.existsSync(unconfiguredStore)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TWILIO_AUTH_TOKEN is not set'));
  });
});

describe('on this machine', () => {
  it("serves the app's brokers a call token and the SMS history", async () => {
    const { token } = await tokenBroker.fetchToken('operator');
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const { conversations } = await smsBroker.listConversations();

    expect(claims.grants.identity).toBe('operator');
    expect(conversations.map((c) => c.number)).toContain(FICTIONAL_NUMBER);
  });

  it('refuses requests without the local key, including a web page posting to 127.0.0.1', async () => {
    const before = storedMessages();

    const noKey = await request(port, {
      method: 'POST',
      path: '/token',
      headers: json,
      body: JSON.stringify({ identity: 'operator' }),
    });
    const wrongKey = await request(port, {
      path: '/sms/conversations',
      headers: { Authorization: 'Bearer 0123456789abcdef' },
    });
    // A cross-site form/fetch with text/plain needs no CORS preflight.
    const browserPost = await request(port, {
      method: 'POST',
      path: '/sms/send',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://attacker.example' },
      body: JSON.stringify({ to: 'not-a-number', body: 'billable?' }),
    });

    expect([noKey.status, wrongKey.status, browserPost.status]).toEqual([401, 401, 401]);
    expect(storedMessages()).toEqual(before);
  });

  it('keeps the key file readable by this user only', () => {
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('never sends the key to a token backend on another host', () => {
    expect(localAuthHeaders(new URL('https://tokens.example.com/token'))).toEqual({});
    expect(localAuthHeaders(new URL(`http://127.0.0.1:${port}/token`))).toHaveProperty(
      'Authorization'
    );
  });
});

// Accepted TWP-9 piece 3: sender metadata and confirmed local-history clearing
// must share TWP-7's authenticated private boundary, never a browser fallback.
describe('workspace private routes', () => {
  it('denies sender metadata and clearing through a tunnel, including a stolen local key', async () => {
    const before = storedMessages();
    for (const headers of [{}, {Authorization:`Bearer ${fs.readFileSync(keyPath,'utf8').trim()}`}]) {
      const me = await request(tunnelPort, {path:'/me',headers});
      const clear = await request(tunnelPort, {path:'/sms/clear',method:'POST',headers:{...json,...headers},body:JSON.stringify({number:FICTIONAL_NUMBER})});
      expect(me.status).toBe(403);expect(clear.status).toBe(403);
    }
    expect(storedMessages()).toEqual(before);
  });

  it('requires the local key and clears only the requested local conversation through the broker', async () => {
    const before = storedMessages();
    const untrusted = await request(port, {path:'/sms/clear',method:'POST',headers:{...json,Origin:'https://attacker.example'},body:JSON.stringify({number:FICTIONAL_NUMBER})});
    const noKey = await request(port,{path:'/me'});
    expect(untrusted.status).toBe(401);expect(noKey.status).toBe(401);
    expect(storedMessages()).toEqual(before);
    const me = await smsBroker.getMe();
    expect(me).toMatchObject({callerId:ENV.TWILIO_CALLER_ID,smsFrom:ENV.TWILIO_CALLER_ID});
    const clear = await smsBroker.clearConversation(FICTIONAL_NUMBER);
    expect(clear.cleared).toBe(true);
    expect(storedMessages()[FICTIONAL_NUMBER].messages).toEqual([]);
    for (const number of Object.keys(before).filter(n=>n!==FICTIONAL_NUMBER)) expect(storedMessages()[number]).toEqual(before[number]);
  });
});

// The provider's 4xx proves rejection; a transport error does not prove non-delivery.
describe('truthful outbound outcomes', () => {
  it('persists confirmed failure separately from an unknown send result', async () => {
    const headers={...json,Authorization:`Bearer ${fs.readFileSync(keyPath,'utf8').trim()}`};
    const responses=[];
    for (const [body,outcome] of [['The destination rejected this test message.','failed'],['Please confirm tomorrow’s meeting.','unknown']]) {
      const res=await request(port,{path:'/sms/send',method:'POST',headers,body:JSON.stringify({to:'+12025550101',body})});
      expect(res.status).toBe(502);expect(JSON.parse(res.body).status).toBe(outcome);
      const messages=storedMessages()['+12025550101'].messages;
      expect(messages[messages.length-1]).toMatchObject({body,status:outcome});
      responses.push({response:JSON.parse(res.body),persistedStatus:messages[messages.length-1].status});
    }
    console.log('Workspace API send-outcome proof:',JSON.stringify(responses));
  });
});
