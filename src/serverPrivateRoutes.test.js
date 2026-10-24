/**
 * @jest-environment node
 */
// TWP-7: a tunnel such as ngrok reaches the token server from 127.0.0.1, so
// the loopback check alone let anyone holding the tunnel URL fetch call
// tokens, read SMS history and send billable SMS. These tests put a
// tunnel-shaped proxy (loopback connection, public Host, the X-Forwarded-*
// headers ngrok documents) in front of the real server and check that only
// Twilio's webhooks get through, while the app's own brokers still work.
// Fake credentials and fictional data only; nothing here reaches Twilio.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PUBLIC_HOST = 'fictional-softphone.ngrok-free.app';
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

beforeAll(async () => {
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

  it('keeps serving the voice webhook to inbound calls', async () => {
    const res = await request(tunnelPort, {
      method: 'POST',
      path: '/twiml',
      headers: form,
      body: new URLSearchParams({
        AccountSid: ENV.TWILIO_ACCOUNT_SID,
        CallSid: 'CA00000000000000000000000000000001',
        From: '+15555550199',
        To: '+15555550100',
        Direction: 'inbound',
        CallStatus: 'ringing',
      }).toString(),
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain('<Client>operator</Client>');
  });

  it('keeps accepting inbound SMS and delivery status webhooks', async () => {
    const inbound = await request(tunnelPort, {
      method: 'POST',
      path: '/sms/inbound',
      headers: form,
      body: new URLSearchParams({
        AccountSid: ENV.TWILIO_ACCOUNT_SID,
        MessageSid: 'SM00000000000000000000000000000002',
        SmsSid: 'SM00000000000000000000000000000002',
        SmsStatus: 'received',
        From: '+15555550199',
        To: '+15555550100',
        Body: 'Running ten minutes late.',
        NumMedia: '0',
        NumSegments: '1',
      }).toString(),
    });
    const status = await request(tunnelPort, {
      method: 'POST',
      path: '/sms/status',
      headers: form,
      body: new URLSearchParams({
        AccountSid: ENV.TWILIO_ACCOUNT_SID,
        MessageSid: 'SM00000000000000000000000000000001',
        MessageStatus: 'delivered',
        SmsStatus: 'delivered',
      }).toString(),
    });
    const health = await request(tunnelPort, { path: '/health' });

    expect(inbound.status).toBe(200);
    expect(storedMessages()['+15555550199'].messages[0].body).toBe(
      'Running ten minutes late.'
    );
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body).updated).toBe(true);
    expect(health.status).toBe(200);
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
