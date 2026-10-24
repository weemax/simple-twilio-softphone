/**
 * @jest-environment node
 */
// TWP-9 piece 2 on the real token server, over real HTTP: the setup routes
// are private like every route not in PUBLIC_ROUTES (TWP-7), so a tunnel
// cannot reach them even though it connects from 127.0.0.1; the desktop
// app's own broker (main/services/setupBroker.js) can; Connect makes the
// service work without a restart (calls get tokens, Twilio's signed
// webhooks verify against the Auth Token and address Connect saved); and
// no answer ever carries the Auth Token or an API secret.
// Fictional account on 127.0.0.1 (tools/fake-twilio); nothing reaches Twilio.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startFakeTwilio } = require('../tools/fake-twilio');

const PUBLIC_HOST = 'fictional-softphone.ngrok-free.app';
const PUBLIC_BASE_URL = `https://${PUBLIC_HOST}`;
const IDENTITY = 'operator-fictional';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-setup-routes-'));
const envFile = path.join(workDir, '.env');
const ENV = {
  OPERATOR_ENV_FILE: envFile,
  OPERATOR_SETUP_STATE_FILE: path.join(workDir, 'setup.json'),
  SMS_STORE_PATH: path.join(workDir, 'sms-store.json'),
  OPERATOR_LOCAL_API_KEY_FILE: path.join(workDir, 'local-api-key'),
};
const CLEARED = [
  'TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY', 'TWILIO_API_SECRET', 'TWILIO_TWIML_APP_SID',
  'TWILIO_CALLER_ID', 'TWILIO_SMS_FROM', 'TWILIO_AUTH_TOKEN', 'OPERATOR_IDENTITY',
  'PUBLIC_BASE_URL', 'SMS_PUBLIC_BASE_URL', 'SMS_STATUS_CALLBACK_URL', 'OPERATOR_INSTALL_ID',
  'TOKEN_BACKEND_URL', 'SMS_BACKEND_URL',
];
const previous = {};
for (const k of [...Object.keys(ENV), ...CLEARED, 'OPERATOR_TWILIO_API_BASE']) previous[k] = process.env[k];

let fake;
let server;
let tunnel;
let tunnelPort;
let port;
let broker;
let keyHeader;

const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
const json = { 'Content-Type': 'application/json' };

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

// What ngrok does to a public request: connects from this machine, keeps
// the public Host and adds X-Forwarded-*.
function startTunnel(upstreamPort) {
  const proxy = http.createServer((req, res) => {
    const up = http.request(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        method: req.method,
        path: req.url,
        agent: false,
        headers: { ...req.headers, host: PUBLIC_HOST, 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' },
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

// X-Twilio-Signature as Twilio's docs describe it, written here rather than
// taken from the server's SDK.
function twilioSignature(url, params, authToken) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

beforeAll(async () => {
  fake = await startFakeTwilio();
  Object.assign(process.env, ENV, { OPERATOR_TWILIO_API_BASE: fake.base });
  for (const k of CLEARED) delete process.env[k];
  const { startServer } = require('../server/server');
  server = await startServer({ port: 0 });
  port = server.address().port;
  tunnel = await startTunnel(port);
  tunnelPort = tunnel.address().port;
  process.env.SMS_BACKEND_URL = `http://127.0.0.1:${port}`;
  broker = require('../main/services/setupBroker');
  keyHeader = { Authorization: `Bearer ${fs.readFileSync(ENV.OPERATOR_LOCAL_API_KEY_FILE, 'utf8').trim()}` };
});

afterAll(async () => {
  await new Promise((r) => tunnel.close(r));
  await new Promise((r) => server.close(r));
  await fake.close();
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('before Twilio is connected', () => {
  test('the service starts without credentials and says so instead of failing calls and texts obscurely', async () => {
    const token = await request(port, { method: 'POST', path: '/token', headers: { ...json, ...keyHeader }, body: JSON.stringify({ identity: IDENTITY }) });
    expect(token.status).toBe(409);
    expect(JSON.parse(token.body)).toMatchObject({ notConfigured: true });
    const sms = await request(port, { method: 'POST', path: '/sms/send', headers: { ...json, ...keyHeader }, body: JSON.stringify({ to: '+15555550123', body: 'hello' }) });
    expect(sms.status).toBe(409);
    expect(JSON.parse(sms.body).status).toBe('failed');
    const list = await request(port, { path: '/sms/conversations', headers: keyHeader });
    expect(JSON.parse(list.body).conversations).toEqual([]); // no placeholder message was saved
    const status = JSON.parse((await request(port, { path: '/setup/status', headers: keyHeader })).body);
    expect(status).toMatchObject({ ok: true, available: true, credentials: false, connected: false, hasAuthToken: false });
  });
});

describe('setup routes are private', () => {
  const routes = [
    ['GET', '/setup/status'],
    ['POST', '/setup/check'],
    ['POST', '/setup/review'],
    ['POST', '/setup/connect'],
    ['POST', '/setup/repair'],
  ];
  const body = JSON.stringify({ accountSid: 'AC' + '1'.repeat(32), authToken: 'a-token-someone-typed-0001' });

  test.each(routes)('%s %s is refused through the tunnel, even with the local key', async (method, p) => {
    for (const headers of [{ ...json, ...keyHeader }, json]) {
      const res = await request(tunnelPort, { method, path: p, headers, body: method === 'POST' ? body : undefined });
      expect(res.status).toBe(403);
      expect(res.body).toContain('not reachable through a tunnel or proxy');
    }
    expect(fake.requests).toEqual([]); // nothing was forwarded to Twilio
  });

  test.each(routes)('%s %s is refused on this machine without the local key', async (method, p) => {
    const res = await request(port, { method, path: p, headers: json, body: method === 'POST' ? body : undefined });
    expect(res.status).toBe(401);
    expect(fake.requests).toEqual([]);
  });
});

describe('the desktop broker connects the account, and the service works without a restart', () => {
  let numberSid;
  const answers = [];

  test('check, review and connect through the broker', async () => {
    const number = fake.addNumber({ phone_number: '+15555550101' });
    numberSid = number.sid;
    const input = { accountSid: fake.accountSid, authToken: fake.authToken, publicBaseUrl: PUBLIC_BASE_URL, identity: IDENTITY, numberSid };

    const checked = await broker.check(input);
    answers.push(checked);
    expect(checked).toMatchObject({ ok: true });
    expect(checked.numbers[0]).toMatchObject({ e164: '+15555550101', voice: { state: 'blank' } });

    const reviewed = await broker.review(input);
    answers.push(reviewed);
    expect(reviewed.rows.map((r) => r.id)).toEqual(['key', 'app', 'voice', 'sms', 'callback', 'identity', 'sender', 'settings']);
    expect(fake.writes()).toEqual([]);

    const connected = await broker.connect(input);
    answers.push(connected);
    expect(connected.ok).toBe(true);
    expect(connected.steps.every((s) => s.status === 'done')).toBe(true);
  });

  test('calls now get a capability token and the sender follows the chosen number', async () => {
    const token = await request(port, { method: 'POST', path: '/token', headers: { ...json, ...keyHeader }, body: JSON.stringify({ identity: IDENTITY }) });
    expect(token.status).toBe(200);
    expect(JSON.parse(token.body).token.split('.')).toHaveLength(3);
    const me = JSON.parse((await request(port, { path: '/me', headers: keyHeader })).body);
    expect(me).toMatchObject({ callerId: '+15555550101', smsFrom: '+15555550101' });
  });

  test('Twilio’s signed webhooks verify against the Auth Token and address Connect saved', async () => {
    const params = { From: '+15555550123', To: '+15555550101', Body: 'Hello from the depot', MessageSid: 'SM' + 'c'.repeat(32), SmsStatus: 'received' };
    const send = (signature) =>
      request(tunnelPort, { method: 'POST', path: '/sms/inbound', headers: { ...form, 'X-Twilio-Signature': signature }, body: new URLSearchParams(params).toString() });
    const bad = await send(twilioSignature(`${PUBLIC_BASE_URL}/sms/inbound`, params, 'some-other-token'));
    expect(bad.status).toBe(403);
    const good = await send(twilioSignature(`${PUBLIC_BASE_URL}/sms/inbound`, params, fake.authToken));
    expect(good.status).toBe(200);
    const list = JSON.parse((await request(port, { path: '/sms/conversations', headers: keyHeader })).body);
    expect(list.conversations.map((c) => c.number)).toEqual(['+15555550123']);
  });

  test('status reports what is connected without any secret, and no answer carried one', async () => {
    const status = await broker.status();
    answers.push(status);
    expect(status).toMatchObject({ ok: true, credentials: true, connected: true, hasAuthToken: true, number: '+15555550101', identity: IDENTITY });
    const text = JSON.stringify(answers);
    expect(text).not.toContain(fake.authToken);
    for (const k of fake.state.keys) expect(text).not.toContain(k.secret);
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
  });

  test('the broker forwards only the fields setup reads, as bounded text', () => {
    const cleaned = broker.cleanInput({
      accountSid: 'AC' + '1'.repeat(32),
      authToken: 'x'.repeat(500),
      admin: true,
      replace: { voice: 'abc', sms: 42, other: 'z' },
      numberSid: { not: 'text' },
    });
    expect(Object.keys(cleaned).sort()).toEqual(['accountSid', 'authToken', 'replace']);
    expect(cleaned.authToken).toHaveLength(128);
    expect(cleaned.replace).toEqual({ voice: 'abc' });
  });
});
