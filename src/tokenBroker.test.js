/**
 * @jest-environment node
 */
// TWP-9 piece 2: setup can replace the API key and TwiML App, and a token the
// old ones signed must not be reused for the next registration. The broker
// keeps a token for 50 minutes per identity; setup:connect and setup:repair
// (main.js) invalidate it. A loopback stand-in for the token service counts
// how often it is asked; nothing reaches Twilio.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let server;
let asked = 0;
let broker;
const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'operator-token-')), 'key');
const previous = { ...process.env };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    asked += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ token: `signed-by-key-${asked}`, identity: 'operator' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.TOKEN_BACKEND_URL = `http://127.0.0.1:${server.address().port}/token`;
  process.env.OPERATOR_LOCAL_API_KEY_FILE = keyFile;
  for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY', 'TWILIO_API_SECRET', 'TWILIO_TWIML_APP_SID']) delete process.env[k];
  broker = require('../main/services/tokenBroker');
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  process.env = previous;
});

test('a token is reused until setup replaces the key or application, then a new one is signed', async () => {
  const first = await broker.fetchToken('operator');
  const again = await broker.fetchToken('operator');
  expect(again).toMatchObject({ token: first.token, cached: true });
  expect(asked).toBe(1);

  broker.invalidateCache();
  const fresh = await broker.fetchToken('operator');
  expect(fresh).toMatchObject({ token: 'signed-by-key-2', cached: false });
  expect(asked).toBe(2);
});
