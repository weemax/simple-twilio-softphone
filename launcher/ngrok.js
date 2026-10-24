// Starting ngrok and reading the address it assigned.
//
// ngrok runs with JSON logs on stdout. Its "starting web service" line names
// the local status address of *this* ngrok (4040, or the next free port when
// another ngrok already holds 4040), and the tunnel's public address is read
// from that status: /api/endpoints, or the older /api/tunnels that ngrok
// documents as deprecated. Nobody types a domain: every ngrok account's dev
// domain is chosen automatically when no --url is given.

const fs = require('fs');
const path = require('path');
const { OwnedProcess } = require('./processes');
const { get, waitUntil } = require('./checks');

// What known ngrok errors mean for the person running Operator.
const EXPLANATIONS = {
  ERR_NGROK_4018:
    'ngrok is not signed in. Sign in once: copy your authtoken from https://dashboard.ngrok.com/get-started/your-authtoken, then run: ngrok config add-authtoken <your authtoken>',
  ERR_NGROK_105:
    'ngrok rejected its saved sign-in. Copy your authtoken again from https://dashboard.ngrok.com/get-started/your-authtoken, then run: ngrok config add-authtoken <your authtoken>',
  ERR_NGROK_107:
    'ngrok rejected its saved sign-in. Copy your authtoken again from https://dashboard.ngrok.com/get-started/your-authtoken, then run: ngrok config add-authtoken <your authtoken>',
  ERR_NGROK_108:
    'Your ngrok account already has as many ngrok agents running as its plan allows. npm run phone did not start them and leaves them running. Stop one (for example, an ngrok in another terminal), then run npm run phone again.',
  ERR_NGROK_334:
    'Your ngrok address is already online from another ngrok (for example, one started by hand in another terminal). npm run phone did not start it and leaves it running. Stop it, then run npm run phone again.',
};

function findExecutable(name, envPath = process.env.PATH || '') {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch (_) {
        // not here
      }
    }
  }
  return null;
}

// The explanation for the first known ngrok error code in `text`, or null.
function explainNgrokError(text) {
  const match = /ERR_NGROK_\d+/.exec(text || '');
  if (!match) return null;
  return {
    code: match[0],
    message:
      EXPLANATIONS[match[0]] ||
      `ngrok stopped with ${match[0]}. See https://ngrok.com/docs/errors/${match[0].toLowerCase().replace(/_/g, '-')}/`,
  };
}

function lastErrorText(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      // a plain ERROR: line on stderr
    }
    if (entry && entry.err && entry.err !== '<nil>') return String(entry.err).split('\n')[0];
    if (!entry && /error/i.test(line)) return line.replace(/^ERROR:\s*/, '').trim();
  }
  return null;
}

class TunnelError extends Error {
  constructor(reason, code = null) {
    super(reason);
    this.reason = reason;
    this.code = code;
  }
}

function pickFor(port, entries) {
  const forPort = entries.filter((e) => {
    const upstream = String(e.upstream || '').replace(/\/+$/, '');
    return upstream.endsWith(`:${port}`) || upstream === String(port);
  });
  const best = forPort.find((e) => String(e.url).startsWith('https:')) || forPort[0];
  return best && best.url ? String(best.url).replace(/\/+$/, '') : null;
}

// The public address forwarding to `port` in this ngrok's local status.
async function readAssignedAddress(apiAddr, port) {
  const endpoints = await get(`http://${apiAddr}/api/endpoints`, { timeoutMs: 2000 }).catch(() => null);
  if (endpoints && endpoints.status === 200 && endpoints.json && Array.isArray(endpoints.json.endpoints)) {
    const found = pickFor(
      port,
      endpoints.json.endpoints.map((e) => ({ url: e.url, upstream: e.upstream && e.upstream.url }))
    );
    if (found) return found;
  }
  const tunnels = await get(`http://${apiAddr}/api/tunnels`, { timeoutMs: 2000 });
  if (tunnels.status !== 200 || !tunnels.json || !Array.isArray(tunnels.json.tunnels)) return null;
  return pickFor(
    port,
    tunnels.json.tunnels.map((t) => ({ url: t.public_url, upstream: t.config && t.config.addr }))
  );
}

// Starts ngrok for `port`. Resolves { process, url } once its local status
// shows the assigned address; rejects with a TunnelError that explains why
// not. A failed ngrok is stopped before rejecting.
async function startTunnel({
  executable,
  port,
  cwd,
  env,
  timeoutMs,
  onLog,
  onSpawned = () => {},
  shouldStop = () => false,
}) {
  let apiAddr = null;
  let logUrl = null;
  let fatal = null;
  const proc = new OwnedProcess({
    name: 'ngrok',
    command: executable,
    args: ['http', `127.0.0.1:${port}`, '--log', 'stdout', '--log-format', 'json'],
    cwd,
    env,
    onLine(line) {
      let entry = null;
      try {
        entry = JSON.parse(line);
      } catch (_) {
        // plain text, usually the final ERROR: lines on stderr
      }
      if (entry && entry.msg === 'starting web service' && entry.addr) apiAddr = entry.addr;
      if (entry && entry.msg === 'started tunnel' && entry.url) {
        logUrl = entry.url;
        onLog(`started ${entry.url}`);
      }
      const known = explainNgrokError(entry ? entry.err : line);
      if (known && !fatal) {
        fatal = known;
        onLog(`${known.code}: ${(entry ? String(entry.err) : line).split('\n')[0]}`);
      }
    },
  });
  try {
    await proc.start();
  } catch (err) {
    throw new TunnelError(`ngrok could not start: ${err.message}`);
  }
  onSpawned(proc);

  const result = await waitUntil(
    async () => {
      if (!logUrl) return null;
      if (!apiAddr) return logUrl; // no local status address logged; use the logged one
      return (await readAssignedAddress(apiAddr, port)) || null;
    },
    {
      timeoutMs,
      stopped: () => {
        if (shouldStop()) return 'npm run phone was asked to stop.';
        if (fatal) return fatal.message;
        if (proc.exit) {
          const detail = explainNgrokError(proc.recentLines.join('\n'));
          if (detail) return detail.message;
          const last = lastErrorText(proc.recentLines);
          return `ngrok stopped before its tunnel was ready${last ? `: ${last}` : '.'}`;
        }
        return null;
      },
    }
  );
  if (!result.ok) {
    await proc.stop(3000);
    if (result.timedOut) {
      const last = lastErrorText(proc.recentLines);
      throw new TunnelError(
        `ngrok did not report a tunnel within ${Math.round(timeoutMs / 1000)} seconds` +
          (last ? ` (last message: ${last})` : '') +
          '. Check your internet connection, then run npm run phone again.'
      );
    }
    throw new TunnelError(result.reason, fatal && fatal.code);
  }
  return { process: proc, url: result.value.replace(/\/+$/, ''), statusAddr: apiAddr };
}

module.exports = {
  findExecutable,
  explainNgrokError,
  readAssignedAddress,
  startTunnel,
  TunnelError,
  EXPLANATIONS,
};
