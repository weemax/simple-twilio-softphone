/**
 * @jest-environment node
 */
// TWP-14, accepted TWP-9 piece 1: the app keeps local-service health and
// tunnel reachability distinct. main/services/session.js answers the
// renderer's session:status call from a live /health check of the real
// server and the session file npm run phone writes; an app started some
// other way says the tunnel was not checked rather than guessing.

const fs = require('fs');
const os = require('os');
const path = require('path');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-session-'));
const LAUNCH_ID = 'a1b2c3d4e5f60718';
process.env.OPERATOR_LAUNCH_ID = LAUNCH_ID;
process.env.SMS_STORE_PATH = path.join(workDir, 'sms-store.json');
process.env.OPERATOR_LOCAL_API_KEY_FILE = path.join(workDir, 'local-api-key');

const { startServer } = require('../server/server');
const { readStatus } = require('../main/services/session');
const runLock = require('../launcher/runLock');
const { EXPLANATIONS } = require('../launcher/ngrok');

let server;
let serviceBase;
const sessionFile = path.join(workDir, 'session.json');

// The file as launcher/supervisor.js writes it (writeSession).
function writeSession(launchId, tunnel) {
  runLock.writeAtomic(sessionFile, {
    version: 1,
    launchId,
    launcherPid: process.pid,
    service: { url: serviceBase },
    tunnel: { ...tunnel, checkedAt: new Date().toISOString() },
  });
}

beforeAll(async () => {
  server = await startServer({ port: 0 });
  serviceBase = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(workDir, { recursive: true, force: true });
});

test("started by npm run phone: this launch's service is ready and the tunnel is reported as found", async () => {
  writeSession(LAUNCH_ID, { state: 'ready', url: 'https://fictional-dev-domain.ngrok-free.app' });
  expect(await readStatus({ sessionFile, serviceBase })).toEqual({
    managed: true,
    service: { state: 'ready', url: serviceBase, detail: null },
    tunnel: { state: 'ready', url: 'https://fictional-dev-domain.ngrok-free.app', reason: null },
  });
});

test('a tunnel problem stays separate from a healthy service', async () => {
  writeSession(LAUNCH_ID, { state: 'unavailable', reason: EXPLANATIONS.ERR_NGROK_4018 });
  const status = await readStatus({ sessionFile, serviceBase });
  expect(status.service.state).toBe('ready');
  expect(status.tunnel).toEqual({ state: 'unavailable', url: null, reason: EXPLANATIONS.ERR_NGROK_4018 });
});

test('another program answering on the port is not mistaken for this launch', async () => {
  writeSession('someotherlaunch', { state: 'ready', url: 'https://fictional-dev-domain.ngrok-free.app' });
  expect((await readStatus({ sessionFile, serviceBase })).service.state).toBe('other');
});

test('a service that does not answer is reported with the reason', async () => {
  writeSession(LAUNCH_ID, { state: 'ready', url: 'https://fictional-dev-domain.ngrok-free.app' });
  const status = await readStatus({ sessionFile, serviceBase: 'http://127.0.0.1:1', timeoutMs: 500 });
  expect(status.service).toEqual({ state: 'unavailable', url: 'http://127.0.0.1:1', detail: expect.stringContaining('ECONNREFUSED') });
  expect(status.tunnel.state).toBe('ready');
});

test('started some other way (npm start): the tunnel is not checked, and the service still is', async () => {
  expect(await readStatus({ sessionFile: undefined, serviceBase })).toEqual({
    managed: false,
    service: { state: 'ready', url: serviceBase, detail: null },
    tunnel: { state: 'unmanaged', url: null, reason: null },
  });
});

test('npm run phone gone without closing the app: the tunnel status is unknown, not ready', async () => {
  const status = await readStatus({ sessionFile: path.join(workDir, 'gone.json'), serviceBase });
  expect(status.tunnel.state).toBe('lost');
  expect(status.tunnel.reason).toContain('no longer running');
});
