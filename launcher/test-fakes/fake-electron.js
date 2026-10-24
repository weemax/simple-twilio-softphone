#!/usr/bin/env node
// Stand-in for the Electron app in launcher tests. On start it records what
// the launcher promised would be ready (the React page, the service's
// /health, the session file), then prints the line main.js prints once its
// window has loaded.
//
// FAKE_ELECTRON_MODE: ok (default) | already-open (prints what main.js
//                     prints when another copy holds the single-instance
//                     lock, and exits)
// FAKE_ELECTRON_RECORD: file to write what it saw to
// SIGUSR2 makes it exit 0, as when the person quits Operator.

const fs = require('fs');
const http = require('http');

function get(url) {
  return new Promise((resolve) => {
    http
      .get(url, { agent: false }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', (err) => resolve({ status: 0, body: err.message }));
  });
}

process.on('SIGUSR2', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

(async () => {
  if (process.env.FAKE_ELECTRON_MODE === 'already-open') {
    console.log('[operator] already open: focusing the existing window');
    process.exit(0);
  }
  const renderer = await get(process.env.OPERATOR_RENDERER_URL + '/');
  const health = await get(process.env.SMS_BACKEND_URL + '/health');
  let session = null;
  try {
    session = JSON.parse(fs.readFileSync(process.env.OPERATOR_SESSION_FILE, 'utf8'));
  } catch (_) {
    // recorded as null
  }
  if (process.env.FAKE_ELECTRON_RECORD) {
    fs.writeFileSync(
      process.env.FAKE_ELECTRON_RECORD,
      JSON.stringify({
        pid: process.pid,
        rendererStatus: renderer.status,
        health: (() => {
          try {
            return JSON.parse(health.body);
          } catch (_) {
            return null;
          }
        })(),
        session,
        env: {
          OPERATOR_RENDERER_URL: process.env.OPERATOR_RENDERER_URL,
          SMS_BACKEND_URL: process.env.SMS_BACKEND_URL,
          TOKEN_BACKEND_URL: process.env.TOKEN_BACKEND_URL,
          OPERATOR_SESSION_FILE: process.env.OPERATOR_SESSION_FILE,
        },
      })
    );
  }
  console.log('[operator] window ready');
  setInterval(() => {}, 1 << 30);
})();
