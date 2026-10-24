/**
 * @jest-environment node
 */
// TWP-14, accepted TWP-9 piece 1 ("Start with one command",
// docs/phone-ux-plan.md): `npm run phone` starts the local service, React,
// Electron and ngrok; reads ngrok's assigned address from its local status
// and passes it to the service; waits on actual readiness; explains missing
// installs/settings, occupied ports, stale runs and ngrok sign-in; a second
// launch cannot create a second writer; quitting stops only what it started.
//
// The service is the real server/server.js. React, Electron and ngrok are
// stand-ins in launcher/test-fakes that never reach a network: the fake
// ngrok's "public" address is a local proxy. All values are fictional.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const twilio = require('../server/node_modules/twilio');
const { startPhone, stopPhone, TUNNEL_LIMITS } = require('../launcher/supervisor');
const { EXPLANATIONS, readAssignedAddress } = require('../launcher/ngrok');
const { waitUntil } = require('../launcher/checks');
const { pidAlive, groupAlive, processStart } = require('../launcher/processes');
const runLock = require('../launcher/runLock');

jest.setTimeout(60000);

const ROOT = path.resolve(__dirname, '..');
const FAKES = path.join(ROOT, 'launcher', 'test-fakes');
const FAKE_NGROK = path.join(FAKES, 'fake-ngrok.js');
const AUTH_TOKEN = 'fictional-auth-token-for-launcher-tests';
const OLD_ADDRESS = 'https://fictional-reserved-domain.ngrok-free.app';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-phone-'));
  cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function collector() {
  const out = { text: '', write: (s) => (out.text += s) };
  return out;
}

// A process the launcher did not start, which it must leave running.
function foreignProcess(options = {}) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    stdio: 'ignore',
    ...options,
  });
  cleanups.push(async () => {
    try {
      process.kill(options.detached ? -child.pid : child.pid, 'SIGKILL');
    } catch (_) {
      // already gone
    }
  });
  return child;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// What the person's server/.env would hold. Every setting the service reads
// is given here, so a real server/.env in this checkout is never used.
const SETTINGS = {
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_API_KEY: 'SK00000000000000000000000000000000',
  TWILIO_API_SECRET: 'fictional-secret',
  TWILIO_TWIML_APP_SID: 'AP00000000000000000000000000000000',
  TWILIO_CALLER_ID: '+15555550100',
  TWILIO_SMS_FROM: '',
  TWILIO_AUTH_TOKEN: AUTH_TOKEN,
  OPERATOR_IDENTITY: 'operator',
  PUBLIC_BASE_URL: OLD_ADDRESS,
  SMS_PUBLIC_BASE_URL: '',
  SMS_STATUS_CALLBACK_URL: '',
  HOST: '',
};

async function setup({ settings = SETTINGS, env = {}, writeEnvFile = true } = {}) {
  const dir = tempDir();
  const files = {
    dir,
    runDir: path.join(dir, 'run'),
    envFile: path.join(dir, 'server.env'),
    electron: path.join(dir, 'electron.json'),
    react: path.join(dir, 'react.json'),
    ngrok: path.join(dir, 'ngrok.json'),
  };
  if (writeEnvFile) {
    fs.writeFileSync(
      files.envFile,
      Object.entries(settings)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n'
    );
  }
  const fullEnv = {
    ...process.env,
    ...settings,
    SMS_STORE_PATH: path.join(dir, 'sms-store.json'),
    OPERATOR_LOCAL_API_KEY_FILE: path.join(dir, 'local-api-key'),
    SMS_BACKEND_URL: '',
    TOKEN_BACKEND_URL: '',
    FAKE_ELECTRON_RECORD: files.electron,
    FAKE_REACT_RECORD: files.react,
    FAKE_NGROK_RECORD: files.ngrok,
    ...env,
  };
  for (const k of Object.keys(fullEnv)) if (fullEnv[k] === undefined) delete fullEnv[k];
  return {
    files,
    options: {
      projectDir: ROOT,
      runDir: files.runDir,
      envFile: files.envFile,
      env: fullEnv,
      servicePort: await freePort(),
      reactPort: await freePort(),
      ngrokPath: FAKE_NGROK,
      checkInstalls: false,
      handleSignals: false,
      timeouts: { tunnel: 10000, service: 15000, tunnelCheck: 5000, react: 15000, electron: 15000, stop: 4000 },
      commands: {
        react: { command: process.execPath, args: [path.join(FAKES, 'fake-react.js')] },
        electron: { command: process.execPath, args: [path.join(FAKES, 'fake-electron.js')] },
      },
    },
  };
}

// Starts a launch in this process and makes sure it is stopped afterwards.
function launch(options) {
  const out = collector();
  const spawned = [];
  const run = startPhone({
    ...options,
    out,
    onEvent: (type, data) => {
      if (type === 'spawned') spawned.push(data);
    },
  });
  cleanups.push(async () => {
    run.stop('test cleanup');
    await run.done;
  });
  return { ...run, out, spawned };
}

function allGone(pids) {
  return pids.every((pid) => !pidAlive(pid) && !groupAlive(pid));
}

function postSigned(url, signedFor, params) {
  const body = new URLSearchParams(params).toString();
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, signedFor, params);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
          'x-twilio-signature': signature,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('npm run phone', () => {
  test("starts everything in order, hands ngrok's address to the service, and stops only what it started on quit", async () => {
    const { files, options } = await setup();
    const foreign = foreignProcess();
    const run = launch(options);

    const ready = await run.ready;
    expect(ready).not.toBeNull();
    const ngrokSaw = readJson(files.ngrok);
    // No fixed address set: ngrok is started exactly as before, with no --url.
    expect(ngrokSaw.args).toEqual(['http', `127.0.0.1:${options.servicePort}`, '--log', 'stdout', '--log-format', 'json']);
    expect(ready.tunnel).toEqual({ state: 'ready', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) });

    // The app opened only after the page and this launch's service answered,
    // and was told where both are and what the tunnel is.
    const app = readJson(files.electron);
    expect(app.rendererStatus).toBe(200);
    expect(app.health).toEqual(expect.objectContaining({ ok: true, launch: ready.launchId }));
    expect(app.session.tunnel).toEqual(expect.objectContaining({ state: 'ready', url: ready.tunnel.url }));
    expect(app.env).toEqual({
      OPERATOR_RENDERER_URL: `http://localhost:${options.reactPort}`,
      SMS_BACKEND_URL: `http://127.0.0.1:${options.servicePort}`,
      TOKEN_BACKEND_URL: `http://127.0.0.1:${options.servicePort}/token`,
      OPERATOR_SESSION_FILE: path.join(files.runDir, 'session.json'),
    });
    expect(run.spawned.map((s) => s.name)).toEqual(['react', 'ngrok', 'service', 'electron']);

    // Twilio's delivery update, signed for ngrok's assigned address and sent
    // through the tunnel, is accepted; one signed for the old address is not.
    const params = { MessageSid: 'SM00000000000000000000000000000009', MessageStatus: 'delivered' };
    const statusUrl = `${ready.tunnel.url}/sms/status`;
    expect(await postSigned(statusUrl, statusUrl, params)).toBe(200);
    expect(await postSigned(statusUrl, `${OLD_ADDRESS}/sms/status`, params)).toBe(403);

    const owned = [...Object.values(ready.pids), readJson(files.react).helperPid];
    process.kill(ready.pids.electron, 'SIGUSR2'); // the person quits Operator
    expect(await run.done).toBe(0);
    expect(run.out.text).toContain('Operator was closed.');
    expect(allGone(owned)).toBe(true);
    expect(pidAlive(foreign.pid)).toBe(true);
    expect(fs.existsSync(path.join(files.runDir, 'run.json'))).toBe(false);
    expect(fs.existsSync(path.join(files.runDir, 'session.json'))).toBe(false);
  });

  test('a second launch starts nothing while the first is running', async () => {
    const { options } = await setup();
    const first = launch(options);
    const ready = await first.ready;

    const second = launch({ ...options, reactPort: await freePort(), servicePort: await freePort() });
    expect(await second.done).toBe(1);
    expect(second.spawned).toEqual([]);
    expect(second.out.text).toContain('Operator is already running from npm run phone in this project');
    expect(second.out.text).toContain('Nothing new was started.');

    // The first launch, and its lock, are untouched.
    expect(Object.values(ready.pids).every(pidAlive)).toBe(true);
    expect(runLock.readLock(options.runDir).launchId).toBe(ready.launchId);
    first.stop('test');
    expect(await first.done).toBe(0);
  });

  test.each([
    ['ngrok is not signed in', { env: { FAKE_NGROK_MODE: 'signin' } }, EXPLANATIONS.ERR_NGROK_4018],
    ['another ngrok holds the account', { env: { FAKE_NGROK_MODE: 'session-limit' } }, EXPLANATIONS.ERR_NGROK_108],
    ['ngrok is not installed', { noNgrok: true }, 'ngrok is not installed.'],
  ])('%s: the rest still starts, and the limits are explained', async (_name, how, reason) => {
    const { files, options } = await setup({ env: how.env || {} });
    if (how.noNgrok) {
      delete options.ngrokPath;
      options.env.PATH = tempDir(); // no ngrok on the search path
    }
    const run = launch(options);
    const ready = await run.ready;

    expect(ready.tunnel.state).toBe('unavailable');
    expect(ready.tunnel.reason).toContain(reason);
    const app = readJson(files.electron);
    expect(app.session.tunnel).toEqual(expect.objectContaining({ state: 'unavailable', reason: ready.tunnel.reason }));
    expect(app.health).toEqual(expect.objectContaining({ ok: true, launch: ready.launchId }));
    expect(run.out.text).toContain(TUNNEL_LIMITS);
    expect(run.spawned.map((s) => s.name)).toEqual(
      how.noNgrok ? ['react', 'service', 'electron'] : ['react', 'ngrok', 'service', 'electron']
    );
    run.stop('test');
    expect(await run.done).toBe(0);
  });

  test('an occupied port is explained, left running, and nothing starts', async () => {
    const { options } = await setup();
    const occupant = net.createServer((s) => s.end('still here')).listen(options.servicePort, '127.0.0.1');
    cleanups.push(() => new Promise((r) => occupant.close(r)));
    await new Promise((r) => occupant.once('listening', r));

    const run = launch(options);
    expect(await run.done).toBe(1);
    expect(run.spawned).toEqual([]);
    expect(run.out.text).toContain(`Port ${options.servicePort}, which the local service needs, is already in use by`);
    expect(run.out.text).toContain('npm run phone did not start it and leaves it running.');
    expect(run.out.text).toContain('npm run phone -- --service-port');
    const answer = await new Promise((resolve) => {
      net.connect(options.servicePort, '127.0.0.1').on('data', (d) => resolve(String(d)));
    });
    expect(answer).toBe('still here');
    expect(runLock.readLock(options.runDir)).toBeNull();
  });

  test('missing packages are named with their fix, and nothing starts', async () => {
    const notInstalled = await setup();
    const run = launch({ ...notInstalled.options, checkInstalls: true, projectDir: tempDir() });
    expect(await run.done).toBe(1);
    expect(run.out.text).toContain('Fix: npm install\n');
    expect(run.out.text).toContain('Fix: npm install --prefix server');
    expect(run.spawned).toEqual([]);
  });

  // TWP-9 piece 2: a first launch has no Twilio settings yet; the in-app
  // setup fills them in, so the launcher no longer refuses to start.
  test('missing Twilio settings start the launch with a note pointing at the in-app setup', async () => {
    const withoutSecret = { ...SETTINGS, TWILIO_API_SECRET: '' };
    const missingSetting = await setup({ settings: withoutSecret });
    const run = launch(missingSetting.options);
    await run.ready;
    expect(run.out.text).toContain('Twilio is not connected yet (server/.env is missing TWILIO_API_SECRET)');
    expect(run.out.text).toContain('Settings → Twilio account');
    run.stop();
    expect(await run.done).toBe(0);

    const noFile = await setup({ writeEnvFile: false, settings: { ...SETTINGS, TWILIO_ACCOUNT_SID: '' } });
    const run2 = launch(noFile.options);
    await run2.ready;
    expect(run2.out.text).toContain('Twilio is not connected yet (server/.env does not exist)');
    run2.stop();
    expect(await run2.done).toBe(0);
  });

  test('a lock left by a run that ended unexpectedly is cleared when nothing of it remains', async () => {
    const { options } = await setup();
    const gone = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => gone.once('exit', r));
    runLock.ensureRunDir(options.runDir);
    runLock.writeAtomic(runLock.lockPath(options.runDir), {
      version: 1,
      launchId: 'earlier',
      launcher: { pid: gone.pid, started: 'Sat Oct 24 09:00:00 2026' },
      children: [{ name: 'service', pid: gone.pid, started: 'Sat Oct 24 09:00:01 2026' }],
    });

    const run = launch(options);
    expect(await run.ready).not.toBeNull();
    expect(run.out.text).toContain('Cleared the lock an earlier npm run phone left');
    run.stop('test');
    expect(await run.done).toBe(0);
  });

  test("an earlier run's leftovers block a launch, and --stop stops only those", async () => {
    const { options } = await setup();
    const leftover = foreignProcess({ detached: true });
    const unrelated = foreignProcess({ detached: true });
    const gone = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => gone.once('exit', r));
    await waitUntil(() => processStart(leftover.pid), { timeoutMs: 5000 });
    runLock.ensureRunDir(options.runDir);
    runLock.writeAtomic(runLock.lockPath(options.runDir), {
      version: 1,
      launchId: 'earlier',
      launcher: { pid: gone.pid, started: 'Sat Oct 24 09:00:00 2026' },
      children: [{ name: 'service', pid: leftover.pid, started: processStart(leftover.pid) }],
    });

    const run = launch(options);
    expect(await run.done).toBe(1);
    expect(run.spawned).toEqual([]);
    expect(run.out.text).toContain(`still running: the local service (process ${leftover.pid})`);
    expect(run.out.text).toContain('npm run phone -- --stop');

    const out = collector();
    expect(await stopPhone({ runDir: options.runDir, out, graceMs: 2000 })).toBe(0);
    expect(out.text).toContain(`Stopped the local service (process ${leftover.pid}) left by an earlier run`);
    expect(allGone([leftover.pid])).toBe(true);
    expect(pidAlive(unrelated.pid)).toBe(true);
    expect(runLock.readLock(options.runDir)).toBeNull();
  });

  test('a part that never becomes ready ends the launch with the reason, and what started is stopped', async () => {
    const { files, options } = await setup({ env: { FAKE_REACT_MODE: 'never' } });
    const run = launch({ ...options, timeouts: { ...options.timeouts, react: 1500 } });
    expect(await run.done).toBe(1);
    expect(run.out.text).toContain('React did not become ready within 1.5 seconds.');
    expect(run.spawned.map((s) => s.name)).toEqual(['react', 'ngrok', 'service']);
    expect(allGone([...run.spawned.map((s) => s.pid), readJson(files.react).helperPid])).toBe(true);
    expect(fs.existsSync(files.electron)).toBe(false);
  });

  test('when the service stops unexpectedly, the launcher says so and stops the rest', async () => {
    const { options } = await setup();
    const run = launch(options);
    const ready = await run.ready;
    process.kill(ready.pids.service, 'SIGKILL');
    expect(await run.done).toBe(1);
    expect(run.out.text).toContain('The local service stopped unexpectedly (stopped by SIGKILL).');
    expect(allGone(Object.values(ready.pids))).toBe(true);
  });

  test('when ngrok stops later, the app keeps running and is told the tunnel stopped', async () => {
    const { options } = await setup();
    const run = launch(options);
    const ready = await run.ready;
    process.kill(ready.pids.ngrok, 'SIGUSR2'); // the agent drops on its own
    const lost = await waitUntil(
      () => {
        const session = readJson(ready.sessionFile);
        return session.tunnel.state === 'lost' ? session.tunnel : null;
      },
      { timeoutMs: 5000 }
    );
    expect(lost.ok).toBe(true);
    expect(lost.value.reason).toContain('ngrok stopped (exit code 1)');
    expect(run.out.text).toContain(TUNNEL_LIMITS);
    expect(pidAlive(ready.pids.electron)).toBe(true);
    expect(pidAlive(ready.pids.service)).toBe(true);
    run.stop('test');
    expect(await run.done).toBe(0);
  });

  test('an Operator window already open outside npm run phone is explained', async () => {
    const { options } = await setup({ env: { FAKE_ELECTRON_MODE: 'already-open' } });
    const run = launch(options);
    expect(await run.done).toBe(1);
    expect(run.out.text).toContain('Operator is already open outside npm run phone');
    expect(allGone(run.spawned.map((s) => s.pid))).toBe(true);
  });
});

// A fixed ngrok address (NGROK_URL in server/.env, or --ngrok-url): ngrok is
// started on it, the service checks Twilio against it, and nothing else is
// used. The domain is .invalid, so it can never resolve: the stand-in cannot
// serve it, and the reachability check fails with that reason. The live
// check, one launch and one call, is the one that reaches the real domain.
describe('a fixed ngrok address (NGROK_URL or --ngrok-url)', () => {
  const FIXED = 'https://fictional-fixed-domain.invalid';
  const NO_PUBLIC_BASE_URL = { ...SETTINGS, PUBLIC_BASE_URL: '' };

  test('ngrok is started on that address, and the service checks Twilio against it', async () => {
    const { files, options } = await setup({ settings: { ...NO_PUBLIC_BASE_URL, NGROK_URL: FIXED } });
    const run = launch(options);
    const ready = await run.ready;

    expect(readJson(files.ngrok).args).toEqual([
      'http',
      `127.0.0.1:${options.servicePort}`,
      '--url',
      FIXED,
      '--log',
      'stdout',
      '--log-format',
      'json',
    ]);
    expect(ready.tunnel).toEqual({
      state: 'unreachable',
      url: FIXED,
      reason: expect.stringContaining('ngrok started, but the address could not be reached'),
    });
    expect(readJson(files.electron).session.tunnel).toEqual(expect.objectContaining({ state: 'unreachable', url: FIXED }));

    // Delivery updates signed for the fixed address are accepted by the service
    // this launch started; ones signed for the old random address are refused.
    const params = { MessageSid: 'SM00000000000000000000000000000008', MessageStatus: 'delivered' };
    const localStatus = `http://127.0.0.1:${options.servicePort}/sms/status`;
    expect(await postSigned(localStatus, `${FIXED}/sms/status`, params)).toBe(200);
    expect(await postSigned(localStatus, `${OLD_ADDRESS}/sms/status`, params)).toBe(403);

    run.stop('test');
    expect(await run.done).toBe(0);
  });

  test('--ngrok-url sets the same address for one run, without a setting in server/.env', async () => {
    const { files, options } = await setup({ settings: NO_PUBLIC_BASE_URL });
    const run = launch({ ...options, ngrokUrl: FIXED });
    const ready = await run.ready;

    expect(readJson(files.ngrok).args).toEqual(expect.arrayContaining(['--url', FIXED]));
    expect(ready.tunnel).toEqual(expect.objectContaining({ state: 'unreachable', url: FIXED }));
    run.stop('test');
    expect(await run.done).toBe(0);
  });

  test('--ngrok-url with no address is refused by the command line before anything starts', () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'launcher', 'phone.js'), '--ngrok-url'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--ngrok-url needs an https address');
  });

  test.each([
    ['NGROK_URL is not https', { settings: { NGROK_URL: 'http://fictional-fixed-domain.invalid' } }, 'NGROK_URL in server/.env is http://fictional-fixed-domain.invalid, which is not an https address with no path.'],
    ['NGROK_URL has a path', { settings: { NGROK_URL: `${FIXED}/twiml` } }, `NGROK_URL in server/.env is ${FIXED}/twiml, which is not an https address with no path.`],
    ['--ngrok-url has a path', { ngrokUrl: `${FIXED}/twiml` }, `The --ngrok-url option is ${FIXED}/twiml, which is not an https address with no path.`],
    ['server/.env names another address', { settings: { NGROK_URL: FIXED, PUBLIC_BASE_URL: OLD_ADDRESS } }, `server/.env has PUBLIC_BASE_URL=${OLD_ADDRESS}, but the fixed ngrok address is ${FIXED}. Only one of them can be right.`],
  ])('%s: nothing starts, and the fix is named', async (_name, how, what) => {
    const { files, options } = await setup({ settings: { ...NO_PUBLIC_BASE_URL, ...(how.settings || {}) } });
    const run = launch({ ...options, ngrokUrl: how.ngrokUrl });
    expect(await run.done).toBe(1);
    expect(run.spawned).toEqual([]);
    expect(run.out.text).toContain(what);
    expect(run.out.text).toContain('Nothing was started.');
    expect(run.out.text).toContain('Fix: ');
    expect(fs.existsSync(files.ngrok)).toBe(false);
  });

  test.each([
    ['ngrok opens another address', { FAKE_NGROK_MODE: 'other-address' }, `instead of the fixed address ${FIXED}`],
    ['the domain is not on the account', { FAKE_NGROK_MODE: 'not-on-account' }, EXPLANATIONS.ERR_NGROK_320],
  ])('%s: the app opens without a tunnel, and no other address is used', async (_name, env, reason) => {
    const { files, options } = await setup({ settings: { ...NO_PUBLIC_BASE_URL, NGROK_URL: FIXED }, env });
    const run = launch(options);
    const ready = await run.ready;

    expect(readJson(files.ngrok).args).toContain(FIXED);
    expect(ready.tunnel.state).toBe('unavailable');
    expect(ready.tunnel.reason).toContain(reason);
    expect(ready.tunnel.url).toBeUndefined();
    const app = readJson(files.electron);
    expect(app.health).toEqual(expect.objectContaining({ ok: true, launch: ready.launchId }));
    expect(app.session.tunnel.url).toBeUndefined();
    expect(run.out.text).toContain(TUNNEL_LIMITS);
    run.stop('test');
    expect(await run.done).toBe(0);
  });
});

describe('npm run phone as its own process', () => {
  async function launcherProcess() {
    const { files, options } = await setup();
    const { out, onEvent, ...serializable } = options;
    const child = spawn(process.execPath, [path.join(FAKES, 'run-session.js')], {
      env: { ...process.env, FAKE_SESSION_OPTIONS: JSON.stringify(serializable) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    const exited = new Promise((r) => child.once('exit', (code) => r(code)));
    cleanups.push(async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
    });
    const ready = await waitUntil(() => text.includes('Operator is ready.'), {
      timeoutMs: 30000,
      stopped: () => (child.exitCode !== null ? text : null),
    });
    expect(ready).toEqual({ ok: true, value: true });
    const owned = runLock.readLock(options.runDir).children.map((c) => c.pid);
    owned.push(readJson(files.react).helperPid);
    return { child, exited, owned, options, output: () => text };
  }

  test('Ctrl+C stops everything it started and nothing else', async () => {
    const foreign = foreignProcess({ detached: true });
    const { child, exited, owned, options, output } = await launcherProcess();
    child.kill('SIGINT');
    expect(await exited).toBe(0);
    expect(output()).toContain('Stopping (SIGINT)');
    expect(allGone(owned)).toBe(true);
    expect(pidAlive(foreign.pid)).toBe(true);
    expect(runLock.readLock(options.runDir)).toBeNull();
  });

  test('npm run phone -- --stop from another terminal stops the running launch', async () => {
    const { exited, owned, options } = await launcherProcess();
    const out = collector();
    expect(await stopPhone({ runDir: options.runDir, out })).toBe(0);
    expect(out.text).toContain('Stopped.');
    expect(await exited).toBe(0);
    expect(allGone(owned)).toBe(true);
  });
});

describe("ngrok's local status", () => {
  test.each([['/api/endpoints'], ['/api/tunnels only']])('the assigned address is read from %s', async (which) => {
    const port = await freePort();
    const child = spawn(process.execPath, [FAKE_NGROK, 'http', `127.0.0.1:${port}`, '--log', 'stdout', '--log-format', 'json'], {
      env: { ...process.env, FAKE_NGROK_API: which.includes('only') ? 'tunnels-only' : '' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    cleanups.push(async () => child.kill('SIGKILL'));
    const lines = [];
    child.stdout.on('data', (d) => lines.push(...String(d).trim().split('\n').map((l) => JSON.parse(l))));
    const started = await waitUntil(() => lines.find((l) => l.msg === 'started tunnel'), { timeoutMs: 5000 });
    const statusAddr = lines.find((l) => l.msg === 'starting web service').addr;

    expect(await readAssignedAddress(statusAddr, port)).toBe(started.value.url);
    // Another port's forwarding is never taken for ours.
    expect(await readAssignedAddress(statusAddr, port + 1)).toBeNull();
  });
});
