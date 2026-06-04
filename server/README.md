# Operator — local token server

A tiny HTTP service that signs Twilio capability tokens (AccessTokens with
Voice grants) so the softphone's renderer never needs to see your Twilio
Auth Token.

## Why this exists

The Electron renderer runs in a sandboxed process. Putting the Auth Token
in a renderer-side env file means it lands in plaintext on disk and any
XSS-equivalent renderer bug could exfiltrate it. Instead:

1. The user enters their SID + Auth Token in the in-app **Configure** form.
2. The Auth Token is encrypted at rest using Electron `safeStorage` and
   never crosses the IPC boundary as a network payload.
3. When the renderer wants to register a `Device`, it asks main for a
   capability token.
4. Main POSTs to this server, this server signs the JWT with the API
   Secret (not the Auth Token), and returns the JWT to main → renderer.

The auth token still needs to be on disk somewhere for **this** server to
read. That's the same risk profile as Twilio Functions or any other
server-side integration. We mitigate by binding to `127.0.0.1` only — the
server refuses any non-loopback connection.

## Setup

```bash
cd server
npm install
cp .env.example .env
# edit .env with your Twilio credentials
npm start
```

### Required env

You can get all four values from the Twilio console:

- `TWILIO_ACCOUNT_SID` — your account SID (AC…)
- `TWILIO_API_KEY` — create one in console → Account → API keys & tokens
- `TWILIO_API_SECRET` — shown once when you create the API key
- `TWILIO_TWIML_APP_SID` — create a Voice TwiML App; copy its SID (AP…)

### .env.example

```env
PORT=5050
HOST=127.0.0.1
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_KEY=SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_SECRET=your_api_secret_here
TWILIO_TWIML_APP_SID=APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Endpoints

### `GET /health`

Returns `{ok: true, ts: <epoch_ms>}`. Useful for the renderer to verify
the server is up before requesting a token.

### `POST /token`

Request:

```json
{ "identity": "operator-izzy" }
```

Response:

```json
{
  "identity": "operator-izzy",
  "token": "eyJ…",
  "ttl": 3600
}
```

Errors are JSON `{ "error": "…" }` with a 4xx/5xx status.

## Security notes

- The server only binds to `127.0.0.1` (or whatever `HOST` you set). It
  will refuse connections from any other address.
- It only accepts POST `/token` and GET `/health`. Everything else 404s.
- The TwiML App SID determines where outbound calls are routed. Whatever
  TwiML that app points to will run for outbound calls — make sure you
  trust the URL configured in the Twilio console.
- For inbound calls, configure a Twilio phone number's voice webhook to
  point at the same TwiML App (or directly at your TwiML Bin).

## Production alternative

If you don't want to run a local Node process, deploy the equivalent
serverless function to Twilio Functions, AWS Lambda, Cloudflare Workers,
etc. The renderer's main process just needs an HTTP endpoint that returns
`{ token, identity, ttl }` for a `POST` with `{ identity }`.
