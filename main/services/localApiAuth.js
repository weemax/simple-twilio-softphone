// Authorization for the main process's requests to the local token server.
//
// The server's private routes (/token, /sms/send, /sms/conversations) need
// the key it writes on every start, because a tunnel's requests also arrive
// from 127.0.0.1. See server/localApiKey.js. The key is read per request so
// a restarted server's new key is picked up without restarting the app.

const { readKeyFile } = require('../../server/localApiKey');

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Headers to add to a request for `url` (a WHATWG URL). Only a server on
// this machine gets the key — never a remote TOKEN_BACKEND_URL.
function localAuthHeaders(url) {
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return {};
  const key = readKeyFile();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

module.exports = { localAuthHeaders };
