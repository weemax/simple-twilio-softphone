// Processes `npm run phone` owns.
//
// Every child starts detached, which on macOS and Linux makes it the leader
// of a new process group. Stopping a child signals that whole group, so the
// helpers it started (React's compiler, Electron's GPU and renderer
// processes) stop with it, and nothing outside the group is touched.
//
// A pid alone does not prove a process is the one we started: the system
// reuses pids. A record therefore keeps the start time `ps` reports, and a
// recorded process counts as still running only while both match.

const { spawn, execFileSync } = require('child_process');
const readline = require('readline');

const POSIX = process.platform !== 'win32';

// The start time `ps` reports for `pid`, or null when it is gone (or on
// Windows, where pids alone are compared).
function processStart(pid) {
  if (!POSIX || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch (_) {
    return null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Whether `record` ({ pid, started }) still names the same live process.
function stillRunning(record) {
  if (!record || !pidAlive(record.pid)) return false;
  if (!POSIX || !record.started) return true;
  return processStart(record.pid) === record.started;
}

// Whether any process is left in the group a detached child led.
function groupAlive(pgid) {
  if (!POSIX) return pidAlive(pgid);
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Whether anything a recorded child started is still running: the child
// itself, or, once it has exited, the rest of its group. The system does
// not hand a group's id to a new process while that group has members, so
// a group with that id and no leader is what the child left behind.
function ownedGroupRunning(record) {
  if (!record) return false;
  if (stillRunning(record)) return true;
  return POSIX && !pidAlive(record.pid) && groupAlive(record.pid);
}

function signalGroup(pgid, signal) {
  try {
    if (POSIX) process.kill(-pgid, signal);
    else process.kill(pgid, signal);
    return true;
  } catch (_) {
    return false;
  }
}

function untilGroupGone(pgid, deadline) {
  return new Promise((resolve) => {
    const check = () => {
      if (!groupAlive(pgid)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, 50);
    };
    check();
  });
}

// SIGTERM the group, then SIGKILL whatever is left after `graceMs`.
async function stopGroup(pgid, graceMs = 8000) {
  if (!groupAlive(pgid)) return 'gone';
  signalGroup(pgid, 'SIGTERM');
  if (await untilGroupGone(pgid, Date.now() + graceMs)) return 'stopped';
  signalGroup(pgid, 'SIGKILL');
  await untilGroupGone(pgid, Date.now() + 2000);
  return 'killed';
}

// A child process this launcher started and is responsible for stopping.
class OwnedProcess {
  constructor({ name, command, args = [], cwd, env, onLine }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.onLine = onLine || (() => {});
    this.child = null;
    this.exit = null; // { code, signal } once it has exited
    this.recentLines = [];
  }

  // Resolves once the process is running, or rejects when it cannot start
  // (for example, the command does not exist).
  start() {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      this.exited = new Promise((done) => {
        child.once('exit', (code, signal) => {
          this.exit = { code, signal };
          done(this.exit);
        });
      });
      for (const [stream, source] of [
        ['stdout', child.stdout],
        ['stderr', child.stderr],
      ]) {
        readline.createInterface({ input: source }).on('line', (line) => {
          this.recentLines.push(line);
          if (this.recentLines.length > 40) this.recentLines.shift();
          this.onLine(line, stream);
        });
      }
      child.once('error', (err) => {
        if (!this.pid) reject(err);
      });
      child.once('spawn', () => {
        this.pid = child.pid;
        this.started = processStart(child.pid);
        resolve(this);
      });
    });
  }

  get running() {
    return Boolean(this.child) && this.exit === null;
  }

  record() {
    return { name: this.name, pid: this.pid, started: this.started };
  }

  // Stops this process and every process in its group.
  async stop(graceMs) {
    if (!this.pid) return 'never-started';
    const result = await stopGroup(this.pid, graceMs);
    if (this.running) await this.exited;
    return result;
  }
}

module.exports = {
  OwnedProcess,
  processStart,
  pidAlive,
  stillRunning,
  groupAlive,
  ownedGroupRunning,
  stopGroup,
};
