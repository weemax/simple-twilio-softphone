// `npm run phone`: start the local service, React, ngrok and the desktop
// app, wait until each is actually ready, and stop exactly what was started.
//
// Order: React and ngrok start first (React's first compile is the slowest
// step). The service starts once ngrok has assigned an address, so it can
// check Twilio's signatures and request delivery updates against that
// address. Electron opens once the service and React both answer.
//
// A tunnel problem never stops the launch: contacts and message history work
// without it, and the app shows what needs it. Anything else that fails
// stops what was already started.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { OwnedProcess, processStart, stillRunning, groupAlive, stopGroup } = require('./processes');
const runLock = require('./runLock');
const checks = require('./checks');
const ngrok = require('./ngrok');

const DEFAULT_TIMEOUTS = {
  tunnel: 30000,
  service: 20000,
  tunnelCheck: 10000,
  react: 180000,
  electron: 60000,
  stop: 8000,
};

const SESSION_NAME = 'session.json';
const STOP_ORDER = ['electron', 'react', 'service', 'ngrok'];
const LABELS = { service: 'service', react: 'react', electron: 'app', ngrok: 'ngrok' };
const NAMES = {
  service: 'the local service',
  react: 'React',
  electron: 'the desktop app',
  ngrok: 'the ngrok tunnel',
};
// What the app can still do without a tunnel, and what needs one.
const TUNNEL_LIMITS =
  'Calls, incoming texts and delivery updates need the tunnel; contacts, message history and sending texts still work.';

function seconds(ms) {
  return `${Math.round(ms / 100) / 10} seconds`;
}

function describeExit(exit) {
  if (!exit) return 'still running';
  return exit.signal ? `stopped by ${exit.signal}` : `exit code ${exit.code}`;
}

function defaultCommands(projectDir) {
  return {
    service: {
      command: process.execPath,
      args: [path.join(projectDir, 'server', 'server.js')],
      cwd: projectDir,
    },
    react: {
      command: process.execPath,
      args: [path.join(projectDir, 'node_modules', 'react-scripts', 'bin', 'react-scripts.js'), 'start'],
      cwd: projectDir,
    },
    electron: {
      command: checks.electronExecutable(projectDir),
      args: ['.'],
      cwd: projectDir,
    },
  };
}

function resolveOptions(options) {
  const projectDir = path.resolve(options.projectDir || path.join(__dirname, '..'));
  const env = options.env || process.env;
  const defaults = defaultCommands(projectDir);
  const commands = {};
  for (const name of ['service', 'react', 'electron']) {
    commands[name] = { ...defaults[name], ...((options.commands || {})[name] || {}) };
  }
  return {
    projectDir,
    env,
    runDir: options.runDir || path.join(projectDir, '.operator-phone'),
    envFile: options.envFile || path.join(projectDir, 'server', '.env'),
    servicePort: options.servicePort || null,
    reactPort: options.reactPort || null,
    ngrokPath: options.ngrokPath,
    checkInstalls: options.checkInstalls !== false,
    handleSignals: options.handleSignals !== false,
    timeouts: { ...DEFAULT_TIMEOUTS, ...(options.timeouts || {}) },
    commands,
    out: options.out || process.stdout,
    onEvent: options.onEvent || (() => {}),
  };
}

class PhoneSession {
  constructor(options) {
    this.o = resolveOptions(options);
    this.launchId = crypto.randomBytes(8).toString('hex');
    this.owned = new Map();
    this.stopRequested = null;
    this.stopping = false;
    this.lockHeld = false;
    this.tunnel = { state: 'starting' };
    this.sessionFile = path.join(this.o.runDir, SESSION_NAME);
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.stopSignal = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
  }

  write(text) {
    try {
      this.o.out.write(text + '\n');
    } catch (_) {
      // The terminal is gone; keep stopping what we started.
    }
  }

  say(text) {
    this.write(`[phone] ${text}`);
  }

  line(name, text) {
    this.write(`[${LABELS[name] || name}] ${text}`);
  }

  // Problems that stop the launch, each with its fix.
  refuse(problems, closing) {
    this.say('Operator did not start:');
    for (const p of problems) {
      this.write(`  - ${p.what}`);
      if (p.fix) this.write(`    Fix: ${p.fix}`);
    }
    if (closing) this.say(closing);
    return 1;
  }

  requestStop(reason) {
    if (this.stopRequested) {
      // npm passes Ctrl+C on to this process as well, so one press can
      // arrive twice; only a later press needs an answer.
      if (this.stopping && Date.now() - this.stopRequestedAt > 1500) {
        this.say('Still stopping; each process gets a few seconds to exit before it is forced.');
      }
      return;
    }
    this.stopRequested = reason;
    this.stopRequestedAt = Date.now();
    this.resolveStop();
  }

  installSignals() {
    if (!this.o.handleSignals) return;
    this.signalHandlers = {};
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => this.requestStop(signal);
      this.signalHandlers[signal] = handler;
      process.on(signal, handler);
    }
  }

  removeSignals() {
    for (const [signal, handler] of Object.entries(this.signalHandlers || {})) {
      process.off(signal, handler);
    }
  }

  lockRecord() {
    return {
      version: 1,
      launchId: this.launchId,
      projectDir: this.o.projectDir,
      startedAt: new Date().toISOString(),
      launcher: { pid: process.pid, started: processStart(process.pid) },
      servicePort: this.servicePort || null,
      reactPort: this.reactPort || null,
      children: [...this.owned.values()].filter((p) => p.pid).map((p) => p.record()),
    };
  }

  saveRecord() {
    if (this.lockHeld) runLock.update(this.o.runDir, this.lockRecord());
  }

  // What the desktop app reads (main/services/session.js): this launch, the
  // service it started and the tunnel's state.
  writeSession() {
    runLock.writeAtomic(this.sessionFile, {
      version: 1,
      launchId: this.launchId,
      launcherPid: process.pid,
      service: { url: `http://127.0.0.1:${this.servicePort}` },
      tunnel: { ...this.tunnel, checkedAt: new Date().toISOString() },
    });
  }

  async spawn(name, extraEnv = {}, onLine) {
    const spec = this.o.commands[name];
    if (!spec.command) throw new Error(`No command to start ${NAMES[name]}.`);
    const env = { ...this.o.env, ...(spec.env || {}), ...extraEnv };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const proc = new OwnedProcess({
      name,
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env,
      onLine: onLine || ((text) => this.line(name, text)),
    });
    await proc.start();
    this.adopt(proc);
    return proc;
  }

  adopt(proc) {
    this.owned.set(proc.name, proc);
    this.saveRecord();
    this.o.onEvent('spawned', { name: proc.name, pid: proc.pid });
  }

  // Why waiting on `proc` should end early, or null.
  interrupted(proc, starting) {
    if (this.stopRequested) return 'stop';
    if (proc && proc.exit) {
      const tail = proc.recentLines.slice(-6).map((l) => `      ${l}`).join('\n');
      return `${NAMES[proc.name]} stopped while ${starting} (${describeExit(proc.exit)}).` +
        (tail ? `\n    Its last output:\n${tail}` : '');
    }
    return null;
  }

  // Ends a failed launch: explains, and the caller stops what started.
  fail(what, fix) {
    if (this.stopRequested) return 0;
    this.refuse([{ what, fix }], null);
    return 1;
  }

  refuseLock(lock) {
    const existing = lock.existing || {};
    if (lock.state === 'running') {
      const since = existing.startedAt ? ` since ${new Date(existing.startedAt).toLocaleTimeString()}` : '';
      return this.refuse(
        [
          {
            what: `Operator is already running from npm run phone in this project (process ${existing.launcher && existing.launcher.pid}${since}).`,
            fix: 'Use the window that is already open. To restart, quit Operator or press Ctrl+C in that terminal (or run npm run phone -- --stop), then run npm run phone again.',
          },
        ],
        'Nothing new was started.'
      );
    }
    if (lock.state === 'leftovers') {
      const list = lock.leftovers.map((c) => `${NAMES[c.name] || c.name} (process ${c.pid})`).join(', ');
      return this.refuse(
        [
          {
            what: `An earlier npm run phone ended without stopping what it started; still running: ${list}.`,
            fix: 'Run npm run phone -- --stop to stop just those, then run npm run phone again.',
          },
        ],
        'Nothing new was started.'
      );
    }
    return this.refuse(
      [{ what: 'Another npm run phone is starting at the same moment.', fix: 'Wait for it, then use its window.' }],
      'Nothing new was started.'
    );
  }

  async startAll() {
    const o = this.o;
    this.say('Starting Operator: local service, React, ngrok tunnel and desktop app.');

    if (o.checkInstalls) {
      const missing = checks.missingInstalls(o.projectDir);
      if (missing.length) return this.refuse(missing, 'Nothing was started.');
    }
    const settings = checks.readServiceSettings(o.envFile, o.env);
    if (settings.problems.length) return this.refuse(settings.problems, 'Nothing was started.');
    this.settings = settings;
    this.servicePort = o.servicePort || settings.port || 5050;
    this.reactPort = o.reactPort || 3000;

    const lock = runLock.acquire(o.runDir, this.lockRecord());
    if (!lock.ok) return this.refuseLock(lock);
    this.lockHeld = true;
    if (lock.cleared) {
      this.say('Cleared the lock an earlier npm run phone left when it ended unexpectedly; nothing it started was still running.');
    }

    const busy = [];
    for (const [port, host, name] of [
      [this.servicePort, '127.0.0.1', 'service'],
      [this.reactPort, o.env.HOST || '0.0.0.0', 'react'],
    ]) {
      const inUse = await checks.portInUse(port, host);
      if (inUse) busy.push({ ...inUse, name });
    }
    if (busy.length) {
      return this.refuse(
        busy.map((b) => ({
          what:
            `Port ${b.port}, which ${NAMES[b.name]} needs, is already in use by ` +
            (b.occupant ? `${b.occupant.command} (process ${b.occupant.pid})` : 'another program') +
            '. npm run phone did not start it and leaves it running.',
          fix:
            b.name === 'react'
              ? 'Stop that program (for example an earlier npm run dev), or use another port: npm run phone -- --react-port 3001'
              : 'Stop that program (for example an earlier npm run token-server or npm run dev:all), or use another port: npm run phone -- --service-port 5051',
        })),
        'Nothing was started.'
      );
    }
    this.writeSession();
    if (this.stopRequested) return 0;

    // React first: its first compile takes the longest.
    const react = await this.spawn('react', { PORT: String(this.reactPort), BROWSER: 'none' });

    const tunnel = await this.startTunnel();
    if (this.stopRequested) return 0;
    this.tunnel = tunnel;

    const serviceEnv = { PORT: String(this.servicePort), OPERATOR_LAUNCH_ID: this.launchId };
    if (tunnel.url) {
      serviceEnv.PUBLIC_BASE_URL = tunnel.url;
      serviceEnv.SMS_STATUS_CALLBACK_URL = `${tunnel.url}/sms/status`;
    }
    this.say(`Starting the local service on port ${this.servicePort}…`);
    const service = await this.spawn('service', serviceEnv);
    const serviceReady = await checks.waitUntil(
      async () => {
        const res = await checks.get(`http://127.0.0.1:${this.servicePort}/health`, { timeoutMs: 1000 });
        return res.status === 200 && res.json && res.json.launch === this.launchId;
      },
      { timeoutMs: o.timeouts.service, stopped: () => this.interrupted(service, 'starting') }
    );
    if (!serviceReady.ok) {
      if (serviceReady.reason === 'stop') return 0;
      return this.fail(
        serviceReady.reason ||
          `The local service did not answer at http://127.0.0.1:${this.servicePort}/health within ${seconds(o.timeouts.service)}.`,
        'Check the [service] lines above, fix what they name, then run npm run phone again.'
      );
    }

    if (tunnel.url) {
      const checked = await this.checkTunnel(tunnel.url);
      // ngrok may have stopped while the address was checked.
      if (this.tunnel.state !== 'lost') this.tunnel = checked;
    }
    this.writeSession();

    this.say(`Waiting for React to finish its first build on port ${this.reactPort}…`);
    const reactReady = await checks.waitUntil(
      async () => {
        const res = await checks.get(`http://127.0.0.1:${this.reactPort}/`, { timeoutMs: 5000 });
        return res.status === 200 && res.body.includes('id="root"');
      },
      { timeoutMs: o.timeouts.react, stopped: () => this.interrupted(react, 'building') }
    );
    if (!reactReady.ok) {
      if (reactReady.reason === 'stop') return 0;
      return this.fail(
        reactReady.reason || `React did not become ready within ${seconds(o.timeouts.react)}.`,
        'Check the [react] lines above, fix what they name, then run npm run phone again.'
      );
    }

    return this.openApp();
  }

  async startTunnel() {
    const o = this.o;
    const executable =
      o.ngrokPath !== undefined ? o.ngrokPath : ngrok.findExecutable('ngrok', o.env.PATH || '');
    if (!executable) {
      return {
        state: 'unavailable',
        reason:
          'ngrok is not installed. Install it from https://ngrok.com/download, sign in once with ngrok config add-authtoken <your authtoken>, then run npm run phone again.',
      };
    }
    this.say('Starting the ngrok tunnel…');
    try {
      const started = await ngrok.startTunnel({
        executable,
        port: this.servicePort,
        cwd: o.projectDir,
        env: o.env,
        timeoutMs: o.timeouts.tunnel,
        onLog: (text) => this.line('ngrok', text),
        onSpawned: (proc) => this.adopt(proc),
        shouldStop: () => Boolean(this.stopRequested),
      });
      this.owned.get('ngrok').exited.then(() => this.onTunnelExit());
      if (this.settings.publicBaseUrl && this.settings.publicBaseUrl.replace(/\/+$/, '') !== started.url) {
        this.say(
          `server/.env has PUBLIC_BASE_URL=${this.settings.publicBaseUrl}; this session uses ngrok's address ${started.url} instead. ` +
            "Operator's own Twilio settings follow it on each start once you have connected in Settings → Twilio account; " +
            'any other Twilio setting that points here must use this address for calls and texts to arrive.'
        );
      }
      return { state: 'started', url: started.url };
    } catch (err) {
      if (!(err instanceof ngrok.TunnelError)) throw err;
      return { state: 'unavailable', reason: err.reason };
    }
  }

  // Proves the public address reaches the service this launch started.
  async checkTunnel(url) {
    let last = null;
    const result = await checks.waitUntil(
      async () => {
        try {
          const res = await checks.get(`${url}/health`, {
            timeoutMs: 5000,
            headers: { 'ngrok-skip-browser-warning': '1', 'user-agent': 'operator-phone-launcher' },
          });
          if (res.status === 200 && res.json && res.json.launch === this.launchId) return true;
          last =
            res.status === 200
              ? 'the address answers, but not from the service this launch started'
              : `the address answered with HTTP ${res.status}`;
        } catch (err) {
          last = `the address could not be reached (${err.message})`;
        }
        return false;
      },
      { timeoutMs: this.o.timeouts.tunnelCheck, intervalMs: 1000, stopped: () => (this.stopRequested ? 'stop' : null) }
    );
    if (result.ok) return { state: 'ready', url };
    return {
      state: 'unreachable',
      url,
      reason: `ngrok started, but ${last || 'the address did not answer'}.`,
    };
  }

  onTunnelExit() {
    if (this.stopping || this.tunnel.state === 'unavailable') return;
    const proc = this.owned.get('ngrok');
    const known = ngrok.explainNgrokError(proc.recentLines.join('\n'));
    this.tunnel = {
      state: 'lost',
      url: this.tunnel.url,
      reason: `ngrok stopped (${describeExit(proc.exit)})${known ? `: ${known.message}` : '.'} Run npm run phone again to restart it.`,
    };
    if (this.lockHeld) this.writeSession();
    this.say(`The tunnel stopped: ${this.tunnel.reason} ${TUNNEL_LIMITS}`);
  }

  async openApp() {
    const o = this.o;
    let windowReady = false;
    let windowProblem = null;
    const appEnv = {
      OPERATOR_SESSION_FILE: this.sessionFile,
      OPERATOR_RENDERER_URL: `http://localhost:${this.reactPort}`,
    };
    // The app's brokers default to port 5050; point them at this service.
    if (!o.env.SMS_BACKEND_URL) appEnv.SMS_BACKEND_URL = `http://127.0.0.1:${this.servicePort}`;
    if (!o.env.TOKEN_BACKEND_URL) appEnv.TOKEN_BACKEND_URL = `http://127.0.0.1:${this.servicePort}/token`;
    this.say('Opening the desktop app…');
    const electron = await this.spawn(
      'electron',
      // A shell that sets ELECTRON_RUN_AS_NODE would start Electron as plain Node.
      { ...appEnv, ELECTRON_RUN_AS_NODE: undefined },
      (text) => {
        if (text.includes('[operator] window ready')) windowReady = true;
        if (text.includes('[operator] window failed to load')) windowProblem = text.replace(/^.*\[operator\]\s*/, '');
        if (text.includes('[operator] already open')) {
          windowProblem =
            'Operator is already open outside npm run phone, so it was brought to the front instead of opening a second window. Quit that copy, then run npm run phone again.';
        }
        this.line('electron', text);
      }
    );
    const opened = await checks.waitUntil(() => windowReady, {
      timeoutMs: o.timeouts.electron,
      stopped: () => windowProblem || this.interrupted(electron, 'opening'),
    });
    if (!opened.ok) {
      if (opened.reason === 'stop') return 0;
      return this.fail(
        opened.reason || `The desktop app did not open its window within ${seconds(o.timeouts.electron)}.`,
        'Check the [app] lines above, then run npm run phone again.'
      );
    }
    this.printReady();
    this.o.onEvent('ready', this.summary());
    this.resolveReady(this.summary());
    return null;
  }

  summary() {
    return {
      launchId: this.launchId,
      servicePort: this.servicePort,
      reactPort: this.reactPort,
      tunnel: { ...this.tunnel },
      sessionFile: this.sessionFile,
      runDir: this.o.runDir,
      pids: Object.fromEntries([...this.owned].map(([name, p]) => [name, p.pid])),
    };
  }

  printReady() {
    const t = this.tunnel;
    const tunnelText =
      t.state === 'ready'
        ? `${t.url} (reaches the local service)`
        : `${t.state === 'unreachable' ? `${t.url}, not reachable` : 'unavailable'}: ${t.reason}`;
    this.say('Operator is ready.');
    this.write(`  Local service   http://127.0.0.1:${this.servicePort} (answering)`);
    this.write(`  Public tunnel   ${tunnelText}`);
    if (t.state !== 'ready') this.write(`                  ${TUNNEL_LIMITS}`);
    this.write(`  React           http://localhost:${this.reactPort}`);
    this.write('  Desktop app     open');
    for (const note of this.settings.notes) this.write(`  Note: ${note}`);
    this.say('Quit Operator, or press Ctrl+C here, to stop everything this command started.');
  }

  // Waits until the app closes, a part stops unexpectedly or a stop is asked.
  supervise() {
    return new Promise((resolve) => {
      const unexpected = (name) => {
        const proc = this.owned.get(name);
        proc.exited.then((exit) => {
          if (this.stopping || this.stopRequested) return;
          if (name === 'electron') {
            const clean = exit.code === 0 || exit.signal === 'SIGTERM';
            this.say(clean ? 'Operator was closed.' : `The desktop app closed unexpectedly (${describeExit(exit)}).`);
            resolve(clean ? 0 : 1);
            return;
          }
          const tail = proc.recentLines.slice(-6).map((l) => `      ${l}`).join('\n');
          this.say(
            `${NAMES[name][0].toUpperCase()}${NAMES[name].slice(1)} stopped unexpectedly (${describeExit(exit)}).` +
              (tail ? `\n    Its last output:\n${tail}` : '')
          );
          resolve(1);
        });
      };
      ['electron', 'service', 'react'].forEach(unexpected);
      this.stopSignal.then(() => {
        this.say(`Stopping (${this.stopRequested})…`);
        resolve(0);
      });
    });
  }

  async stopAll() {
    this.stopping = true;
    const started = STOP_ORDER.map((n) => this.owned.get(n)).filter((p) => p && p.pid);
    if (!started.length) return;
    const left = started.filter((p) => p.running || groupAlive(p.pid));
    if (left.length) {
      this.say(`Stopping what npm run phone started: ${left.map((p) => NAMES[p.name]).join(', ')}.`);
    }
    // The window closes before the service it talks to.
    const electron = this.owned.get('electron');
    if (electron) await electron.stop(this.o.timeouts.stop);
    await Promise.all(started.filter((p) => p !== electron).map((p) => p.stop(this.o.timeouts.stop)));
    this.say('Stopped. Programs npm run phone did not start were left running.');
    this.o.onEvent('stopped', { names: started.map((p) => p.name) });
  }

  cleanupFiles() {
    if (!this.lockHeld) return;
    try {
      const current = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
      if (current.launchId === this.launchId) fs.rmSync(this.sessionFile, { force: true });
    } catch (_) {
      // already gone
    }
    runLock.release(this.o.runDir, this.launchId);
    this.lockHeld = false;
  }

  async run() {
    this.installSignals();
    let code;
    try {
      code = await this.startAll();
      if (code === null) code = await this.supervise();
    } catch (err) {
      this.say(`Operator could not start: ${err.message}`);
      code = 1;
    }
    try {
      await this.stopAll();
    } finally {
      this.cleanupFiles();
      this.removeSignals();
      this.resolveReady(null);
    }
    return code;
  }
}

// Starts a session. `ready` resolves with its summary once the window is
// open (null if it never opened); `done` resolves with the exit code once
// everything it started has stopped; `stop()` asks it to stop.
function startPhone(options = {}) {
  const session = new PhoneSession(options);
  const done = session.run();
  return {
    ready: session.ready,
    done,
    stop: (reason = 'stop requested') => session.requestStop(reason),
    session,
  };
}

// `npm run phone -- --stop`: stops the launcher running from this project,
// or what an earlier one left running, and nothing else.
async function stopPhone(options = {}) {
  const projectDir = path.resolve(options.projectDir || path.join(__dirname, '..'));
  const runDir = options.runDir || path.join(projectDir, '.operator-phone');
  const out = options.out || process.stdout;
  const say = (text) => out.write(`[phone] ${text}\n`);
  const found = runLock.inspect(runDir);
  if (found.state === 'none') {
    say('Nothing to stop: npm run phone is not running from this project.');
    return 0;
  }
  if (found.state === 'running') {
    const launcher = found.existing.launcher;
    say(`Asking the running npm run phone (process ${launcher.pid}) to stop what it started…`);
    process.kill(launcher.pid, 'SIGTERM');
    const gone = await checks.waitUntil(() => !stillRunning(launcher), { timeoutMs: options.timeoutMs || 30000 });
    if (!gone.ok) {
      say(`It is still stopping. Check its terminal (process ${launcher.pid}).`);
      return 1;
    }
    say('Stopped.');
    return 0;
  }
  if (found.state === 'leftovers') {
    const order = (c) => (STOP_ORDER.includes(c.name) ? STOP_ORDER.indexOf(c.name) : STOP_ORDER.length);
    for (const child of [...found.leftovers].sort((a, b) => order(a) - order(b))) {
      const result = await stopGroup(child.pid, options.graceMs || 8000);
      say(`Stopped ${NAMES[child.name] || child.name} (process ${child.pid}) left by an earlier run (${result}).`);
    }
  } else {
    say('Cleared the lock an earlier npm run phone left; nothing it started was still running.');
  }
  fs.rmSync(path.join(runDir, SESSION_NAME), { force: true });
  runLock.removeIfUnchanged(runDir, found.existing);
  return 0;
}

module.exports = { startPhone, stopPhone, DEFAULT_TIMEOUTS, TUNNEL_LIMITS };
