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

Also required if you want inbound calls to ring the app:

- `OPERATOR_IDENTITY` — the Twilio Client identity to dial for inbound
  calls. Must match the "Client Identity" entered in the app's Configure
  form. Without this, `/twiml` tells inbound callers the operator isn't
  configured and hangs up.

### .env.example

```env
PORT=5050
HOST=127.0.0.1
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_KEY=SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_SECRET=your_api_secret_here
TWILIO_TWIML_APP_SID=APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_CALLER_ID=+1xxxxxxxxxx
OPERATOR_IDENTITY=operator-username
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

The grant also sets `incomingAllow: true`, so the softphone `Device` can
receive inbound calls, not just place outbound ones.

Errors are JSON `{ "error": "…" }` with a 4xx/5xx status.

### `GET|POST /twiml`

Returns TwiML for both directions, distinguished by `From`: only calls the
softphone itself originates carry a `client:` scheme, so that's the
reliable signal (an empty `To` is not — inbound calls also arrive with
`To` set to the dialed Twilio number).

- **Outbound** (`From` starts with `client:`) — routes by `To`:
  - `<Dial answerOnBridge="true"><Client>{to}</Client></Dial>` if `to`
    looks like a Client identity (Operator→Operator, no PSTN)
  - `<Dial answerOnBridge="true"><Number>{to}</Number></Dial>` if `to`
    looks like a phone number
  - `<Response><Say>…</Say></Response>` for anything else

  `answerOnBridge` delays Twilio's "answered" signal until the far end
  actually picks up, so the caller keeps hearing ringback instead of the
  call appearing connected while it's still ringing.

- **Inbound** (`From` does not start with `client:`) — a PSTN caller (or
  another client) dialed the Twilio number. Routes to the operator
  softphone: `<Dial><Client>{OPERATOR_IDENTITY}</Client></Dial>`, with the
  caller's own number as `callerId` (falls back to `TWILIO_CALLER_ID` if
  absent). If `OPERATOR_IDENTITY` isn't set, the caller hears a message
  saying the operator isn't configured yet.

Set this URL as the Voice URL of your TwiML App in the Twilio console.
For inbound calls to a real phone number, also point the number's "A
call comes in" webhook here.

This endpoint is **publicly reachable** (it must be — Twilio's webhook
callers aren't on localhost). The endpoint is authless, but the URL is
unguessable, and the response contains no secrets.

## Security notes

- `/token` only binds to `127.0.0.1` and refuses non-loopback connections
  — it returns signed JWTs and must never leak.
- `/twiml` is the only public endpoint. There is no auth, but the
  response contains only TwiML — no secrets, no PII — so the worst
  case from URL exposure is "someone can make calls billed to your
  account" which is the same risk as the TwiML App URL being public
  anyway.
- If you're using ngrok, the random subdomain is your only auth. If you
  want a hard second factor, put the endpoint behind a path secret
  (e.g. `/twiml/RANDOM_HEX`) and configure that in the Twilio console.

## Production alternative

If you don't want to run a local Node process, deploy the equivalent
serverless function to Twilio Functions, AWS Lambda, Cloudflare Workers,
etc. The renderer's main process just needs an HTTP endpoint that returns
`{ token, identity, ttl }` for a `POST` with `{ identity }`.
