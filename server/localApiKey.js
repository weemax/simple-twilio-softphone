// Local API key for the token server's private routes.
//
// A tunnel such as ngrok connects to this server from 127.0.0.1, so the
// loopback check alone cannot tell the Operator app apart from anyone on
// the internet who knows the tunnel URL. On every start the server
// generates a fresh random key and writes it to a 0600 file beside it; the
// Electron main process reads that file and sends the key as a bearer token
// (see main/services/localApiAuth.js). A request that came in through the
// tunnel never carries it, and neither does a web page that posts to
// 127.0.0.1 from the browser.
//
// Optional env, honored by both the server and the Electron main process:
//   OPERATOR_LOCAL_API_KEY_FILE — where the key file lives
//                                 (default server/.local-api-key)

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_KEY_FILE = path.join(__dirname, '.local-api-key');

function keyFilePath() {
  return process.env.OPERATOR_LOCAL_API_KEY_FILE || DEFAULT_KEY_FILE;
}

function generateKey() {
  return crypto.randomBytes(32).toString('hex');
}

// Write via <file>.tmp + rename so a reader never sees a half-written key.
function writeKeyFile(key, filePath = keyFilePath()) {
  const tmpPath = filePath + '.tmp';
  fs.rmSync(tmpPath, { force: true });
  fs.writeFileSync(tmpPath, key + '\n', { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

// Returns the key, or null when the server has not written one yet.
function readKeyFile(filePath = keyFilePath()) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim() || null;
  } catch (_) {
    return null;
  }
}

function keysMatch(expected, presented) {
  if (typeof expected !== 'string' || typeof presented !== 'string') {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  DEFAULT_KEY_FILE,
  keyFilePath,
  generateKey,
  writeKeyFile,
  readKeyFile,
  keysMatch,
};
