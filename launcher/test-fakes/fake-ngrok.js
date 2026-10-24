#!/usr/bin/env node
// Stand-in for the ngrok agent in launcher tests. It never contacts ngrok:
// its "public" address is a local proxy that forwards the way ngrok does
// (connects from loopback, keeps a public Host, adds X-Forwarded-* headers),
// and its local status answers /api/endpoints and the deprecated
// /api/tunnels in the shapes ngrok's agent API documents. The log message
// names are ones the installed ngrok 3 binary contains; the error codes are
// the ones ngrok's error pages document.
//
// FAKE_NGROK_MODE: ok (default) | signin | session-limit | silent
// FAKE_NGROK_API: tunnels-only answers only the older /api/tunnels
// FAKE_NGROK_RECORD: file to write { pid, args } to
// SIGUSR2 makes it exit as if the agent stopped on its own.

const fs = require('fs');
const http = require('http');

const args = process.argv.slice(2);
const mode = process.env.FAKE_NGROK_MODE || 'ok';
if (process.env.FAKE_NGROK_RECORD) {
  fs.writeFileSync(process.env.FAKE_NGROK_RECORD, JSON.stringify({ pid: process.pid, args }));
}
const log = (entry) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');

log({ lvl: 'info', msg: 'no configuration paths supplied', obj: 'app' });

if (mode === 'signin') {
  const err =
    'authentication failed: Usage of ngrok requires a verified account and authtoken.\n\n' +
    'Sign up for an account: https://dashboard.ngrok.com/signup\n' +
    'Install your authtoken: https://dashboard.ngrok.com/get-started/your-authtoken\r\n\r\nERR_NGROK_4018\r\n';
  log({ lvl: 'eror', msg: 'session closing', obj: 'tunnels.session', err });
  process.stderr.write('ERROR:  authentication failed: Usage of ngrok requires a verified account and authtoken.\nERROR:  \nERROR:  ERR_NGROK_4018\n');
  process.exit(1);
}
if (mode === 'session-limit') {
  const err =
    'Your account is limited to 1 simultaneous ngrok agent sessions.\n' +
    'You can run multiple simultaneous tunnels from a single agent session by defining the tunnels in your agent configuration file and starting them with the command `ngrok start --all`.\r\n\r\nERR_NGROK_108\r\n';
  log({ lvl: 'eror', msg: 'session closing', obj: 'tunnels.session', err });
  process.stderr.write('ERROR:  Your account is limited to 1 simultaneous ngrok agent sessions.\nERROR:  ERR_NGROK_108\n');
  process.exit(1);
}

const target = args[1] || '80';
const [targetHost, targetPort] = target.includes(':') ? target.split(':') : ['127.0.0.1', target];
const publicHost = 'fictional-dev-domain.ngrok-free.app';

process.on('SIGTERM', () => process.exit(0));
process.on('SIGUSR2', () => {
  log({ lvl: 'eror', msg: 'session closing', obj: 'tunnels.session', err: 'connection reset' });
  process.exit(1);
});

if (mode === 'silent') {
  setInterval(() => {}, 1 << 30);
} else {
  const proxy = http.createServer((req, res) => {
    const up = http.request(
      {
        host: targetHost,
        port: Number(targetPort),
        method: req.method,
        path: req.url,
        agent: false,
        headers: {
          ...req.headers,
          host: publicHost,
          'x-forwarded-for': '203.0.113.7',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': publicHost,
        },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      }
    );
    up.on('error', () => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('ERR_NGROK_8012: failed to reach the upstream');
    });
    req.pipe(up);
  });
  proxy.listen(0, '127.0.0.1', () => {
    const publicUrl = `http://127.0.0.1:${proxy.address().port}`;
    const upstream = `http://${targetHost}:${targetPort}`;
    const status = {
      '/api/endpoints': {
        endpoints: [{ name: 'command_line', url: publicUrl, upstream: { url: upstream, protocol: 'http1' } }],
        uri: '/api/endpoints',
      },
      '/api/tunnels': {
        tunnels: [{ name: 'command_line', public_url: publicUrl, proto: 'https', config: { addr: upstream, inspect: true } }],
        uri: '/api/tunnels',
      },
    };
    const api = http.createServer((req, res) => {
      const body = status[req.url];
      if (!body || (process.env.FAKE_NGROK_API === 'tunnels-only' && req.url === '/api/endpoints')) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    api.listen(0, '127.0.0.1', () => {
      log({ lvl: 'info', msg: 'starting web service', obj: 'web', addr: `127.0.0.1:${api.address().port}`, allow_hosts: [] });
      log({ lvl: 'info', msg: 'client session established', obj: 'tunnels.session' });
      log({ lvl: 'info', msg: 'tunnel session started', obj: 'tunnels.session' });
      log({ lvl: 'info', msg: 'started tunnel', obj: 'tunnels', name: 'command_line', addr: `http://${targetHost}:${targetPort}`, url: publicUrl });
    });
  });
}
