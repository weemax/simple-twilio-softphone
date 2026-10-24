# Operator — local token server

A tiny HTTP service that signs Twilio capability tokens (AccessTokens with
Voice grants) so the softphone's renderer never needs to see your Twilio
Auth Token.

## Why this exists

The Electron renderer runs in a sandboxed process. Putting the Auth Token
in a renderer-side env file means it lands in plaintext on disk and any
XSS-equivalent renderer bug could exfiltrate it. Instead:

1. The user enters their Account SID + Auth Token in the in-app
   **Settings → Twilio account** setup (see [In-app setup](#in-app-setup)).
2. This server saves them to its own `server/.env` (owner-only) and never
   returns them: no route, and no IPC call, ever answers with the Auth Token
   or an API secret.
3. When the renderer wants to register a `Device`, it asks main for a
   capability token.
4. Main POSTs to this server, this server signs the JWT with the API
   Secret (not the Auth Token), and returns the JWT to main → renderer.

The auth token still needs to be on disk somewhere for **this** server to
read. That's the same risk profile as Twilio Functions or any other
server-side integration. We mitigate by binding to `127.0.0.1` only and by
keeping every route except Twilio's webhooks private — see
[Public and private routes](#public-and-private-routes).

The old Configure form and its renderer-side secret store are gone: the renderer has
no channel that can read, write or clear a stored secret. A desktop Auth Token copy
an earlier version saved (`<userData>/secrets/store.json`) is neither read, migrated
nor deleted.

## In-app setup

The first launch with no Twilio settings opens **Settings → Twilio account**:
Account → Number → Review → Connected. `server/setup.js` does the work, over the
private `/setup/*` routes (`status`, `check`, `review`, `connect`, `repair`):

- **Check account** is one read-only request (the account's phone numbers). A wrong
  Account SID/Auth Token and an unreachable Twilio are reported differently. Values
  already in `server/.env` are reused without retyping; only their presence is shown.
- **Number**: choose one existing number. Capabilities and current voice/text routes
  are listed. Operator never buys a number; with none suitable it explains how to add
  one in the Twilio console.
- **Review** lists every change before **Connect**, from read-only requests. A route
  that is blank or already Operator's is updated. A route that goes anywhere else
  shows its current destination with an unchecked **Replace** control for that route
  alone; consent is tied to the exact destination reviewed and does not carry over if
  it changes. A Messaging Service that holds the number overrides the number's text
  route; Operator says so and never edits Messaging Services.
- **Connect** creates or reuses one Operator-owned API key and one TwiML Application
  (both named `Operator softphone [<install id>]`, the id saved as
  `OPERATOR_INSTALL_ID`) and sets the chosen number's voice and text routes to that
  application. Nothing else in the account is touched. A working key already in
  `server/.env` is reused; a new key's secret is saved before anything else can fail.
  Connecting twice changes nothing and creates nothing new; a failed step is named and
  **Retry** resumes. `server/.env` stays the single credential store (rewritten
  atomically, owner-only, other lines kept).
- **On every start** (`startRepair`), once connected, Operator checks only what it
  owns: a deleted or rejected key is replaced (the old Operator key is deleted only
  after the new one works), a deleted application is recreated, and the application's
  addresses follow the session's public address. A route that goes elsewhere, or was
  cleared, is only reported. An unreachable Twilio changes nothing. The result (no
  secrets) is kept in `server/.operator-setup.json` and shown in Settings → Connection.

Without `server/.env` writable (`OPERATOR_ENV_FILE` unset when not started directly),
setup refuses to run. `OPERATOR_TWILIO_API_BASE` (only `http://127.0.0.1:<port>` or
`localhost`) points every Twilio request at a fictional server for tests
(`tools/fake-twilio`); credentials can never be redirected elsewhere that way.

## Setup

```bash
cd server
npm install
cp .env.example .env
# edit .env with your Twilio credentials
npm start
```

### Required env

Normally the in-app setup writes all of these for you. To set them by hand, you can get
the first four from the Twilio console. Without them the service still starts (so the
app can open its setup), and `/token` and `/sms/send` answer `409` until they exist:

- `TWILIO_ACCOUNT_SID` — your account SID (AC…)
- `TWILIO_API_KEY` — create one in console → Account → API keys & tokens
- `TWILIO_API_SECRET` — shown once when you create the API key
- `TWILIO_TWIML_APP_SID` — create a Voice TwiML App; copy its SID (AP…)

Also required if you want inbound calls to ring the app:

- `OPERATOR_IDENTITY` — the Twilio Client identity to dial for inbound
  calls. The app registers as the same identity (the setup saves it here).
  Without this, `/twiml` tells inbound callers the operator isn't
  configured and hangs up.

Required for Twilio's webhooks — inbound calls, inbound SMS and delivery
updates. Without both, the server refuses every webhook (see
[Twilio webhook signatures](#twilio-webhook-signatures)):

- `TWILIO_AUTH_TOKEN` — your account's primary Auth Token (console →
  Account → API keys & tokens → Auth Token). Twilio signs every webhook
  request with it. The server uses it for nothing else.
- `PUBLIC_BASE_URL` — the public address Twilio calls, with no path, e.g.
  `https://YOUR-DOMAIN.ngrok-free.app`. The status callback for outbound
  SMS is derived from it too (`<base>/sms/status`). The older name
  `SMS_PUBLIC_BASE_URL` still works. Under `npm run phone` (project root)
  you do not need it: the launcher reads the address ngrok assigned and
  passes it, with `SMS_STATUS_CALLBACK_URL=<address>/sms/status`, in this
  server's environment, which `server/.env` never overrides.

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
TWILIO_AUTH_TOKEN=your_auth_token_here
PUBLIC_BASE_URL=https://YOUR-DOMAIN.ngrok-free.app
```

## Photos

Piece 4 of `docs/phone-ux-plan.md`. Photos are stored in `sms-media/` next to
`sms-store.json` (`SMS_MEDIA_DIR` overrides; `server/sms-media/` is git-ignored; the folder is
`0700`, files `0600`, and a `media-index.json` lists them). Kinds: **draft** (attached in the
composer, local only) and **message** (sent or received).

Private routes (local API key, never through the tunnel):

| Route | Does |
| --- | --- |
| `POST /sms/media?name=` | Attach: the body is the photo's bytes. Checked by contents (`imageCheck.js`: PNG sections and check values, JPEG markers and end, bounded dimensions), never by name or type. 415 for anything else, 413 at 5 MB or more. |
| `GET /sms/media/<id>` · `DELETE /sms/media/<id>` | Read a photo for the app's previews; discard a draft photo (a message's photos are not deleted this way). |
| `GET /sms/media-policy?to=` | What photos to this number would meet: country, MMS capability of the sending number (one read-only request, cached five minutes), public address, limits. |
| `POST /sms/media-prune` | Delete draft photos the app no longer lists (older than ten minutes). |
| `POST /sms/send` | Takes `media: [photo ids]`; a photo-only message has an empty `body`. |

`/sms/send` with photos checks everything before anything is stored as sent or linked
(`photoPolicy.js`): at most 10, text and photos under 5 MB, a destination whose area code is
in the United States or Canada (`nanpAreaCodes.js`), a sender not known to lack MMS, and
`PUBLIC_BASE_URL`. Only then are the photos taken out of the drafts, each given a new link, and
the message handed to Twilio with `mediaUrl`. After a confirmed failure the links are revoked and
the photos stay with the failed message for a reviewed resend (to the same number only); after
an unknown result the links stay open and the photos cannot be sent again from here. Clearing a
thread, or the 500-message retention, deletes the files and links of photos no stored message
holds.

Incoming photos (`NumMedia`/`MediaUrlN` on the signed `/sms/inbound`): the webhook is answered
at once with each JPEG/PNG shown as pending; `mediaFetch.js` then downloads each from
`https://api.twilio.com/2010-04-01/Accounts/<this account>/Messages/…/Media/…` only, follows at
most three redirects and only to `*.twiliocdn.com` over https, sends the API key to the first
address only, refuses private-network addresses, and stops at 5 MB or 20 seconds. Anything else
(other types, other hosts or accounts, too large, unreadable) becomes a placeholder with a reason.
Downloads a stop interrupted show as unavailable after the next start.

## Public and private routes

A tunnel such as ngrok forwards the internet to this server **from
127.0.0.1**, so "the connection is local" does not mean "the request is
from the Operator app". The server therefore splits its routes:

- **Public** (`PUBLIC_ROUTES` in `server.js`): `/health`, `/twiml`, `/`,
  `/sms/inbound`, `/sms/status`. These are what Twilio (and your tunnel
  health check) must reach, and their responses carry no secrets or
  message history. All of them except `/health` are Twilio's webhooks and
  also need a valid Twilio signature (next section).
- **Photo links** (`/media/<token>`): public too, but only a 43-character random token that
  was minted for one photo of a message the person just sent answers, for 24 hours. Every
  other path under `/media/`, a photo id, a listing or a path that leaves the folder is a
  plain 404; only `GET`/`HEAD` are accepted. See [Photos](#photos).
- **Private**: everything else — today `/token`, `/sms/send`, `/sms/conversations`, `/me`, `/sms/clear`
  and the photo routes `/sms/media*`. A new route is private unless it is added to
  `PUBLIC_ROUTES` on purpose. A private request must:
  1. arrive on a loopback connection (else `403 local only`);
  2. carry no proxy/tunnel forwarding headers (`Forwarded`, `Via`,
     `X-Forwarded-For`/`-Host`/`-Proto`, `X-Real-IP`, `CF-Connecting-IP`)
     and a loopback `Host` (`127.0.0.1`, `localhost`, `[::1]`) — else
     `403 private route: not reachable through a tunnel or proxy`;
  3. send this run's local API key as `Authorization: Bearer <key>` —
     else `401 missing or invalid local API key`.

The local API key is generated fresh on every start and written, once the
server owns its port, to `server/.local-api-key` with mode `0600`
(override with `OPERATOR_LOCAL_API_KEY_FILE`; the Electron main process
honors the same variable, so set it for both). The app's token and SMS
brokers read the file on every request, so restarting the server needs no
app restart. Tunnels can be configured to strip forwarding headers; the key
is what keeps a tunneled request out regardless, and it also stops a web
page in your browser from posting to `127.0.0.1:5050`.

After updating to this version, restart both the token server and the
app: an app started before the update does not send the key, so its token
and SMS requests get `401` until it restarts.

To call a private route by hand:

```bash
curl -X POST http://127.0.0.1:5050/token \
  -H "Authorization: Bearer $(cat server/.local-api-key)" \
  -H 'Content-Type: application/json' -d '{"identity":"operator"}'
```

## Twilio webhook signatures

Twilio signs every webhook request it sends: the `X-Twilio-Signature`
header is an HMAC-SHA1, keyed with your account's Auth Token, of the exact
URL Twilio requested (including any query string) followed by every POST
parameter. `/twiml`, `/`, `/sms/inbound` and `/sms/status` check it with
the Twilio SDK's `validateRequest` before doing anything
(`checkTwilioSignature` in `server.js`):

- The URL checked is `PUBLIC_BASE_URL` plus the path and query string the
  request arrived with. Behind a tunnel the server itself only sees
  `http://127.0.0.1:5050/…`, which is never what Twilio signed.
- Every POST parameter is included, so a request with any parameter
  added, dropped or changed is refused; so is a signature made for
  another URL or with another Auth Token. Parameters the server does not
  read stay in the check, because Twilio adds new ones without notice.
- A request without a valid signature gets `403` (`missing Twilio
  signature` or `invalid Twilio signature`) and changes nothing. While
  `TWILIO_AUTH_TOKEN` or `PUBLIC_BASE_URL` is missing, every webhook gets
  `503 webhook signature check not configured`. The server never skips the
  check.
- Each refusal is logged with its reason, e.g. `[webhook] refused POST
  /sms/inbound: X-Twilio-Signature does not match
  https://YOUR-DOMAIN.ngrok-free.app/sms/inbound …`. The boot log says
  which base URL the signatures are checked against, or why they cannot
  be.

If real calls or messages are refused (Twilio's error log shows an HTTP
retrieval failure, 11200, with status 403 or 503), check the boot log and
the `[webhook] refused …` lines, then:

1. `TWILIO_AUTH_TOKEN` must be the **primary** Auth Token. After you
   promote a secondary token, update it and restart the server.
2. The URLs in the Twilio console (the TwiML App's Voice URL, the number's
   "A message comes in" webhook) must start with exactly `PUBLIC_BASE_URL`:
   same `https`, same host. A changed tunnel address needs both updated.
3. If you set `SMS_STATUS_CALLBACK_URL`, it must be
   `PUBLIC_BASE_URL/sms/status`; the boot log warns when it is not. It is
   simpler to leave it unset.

`src/serverPrivateRoutes.test.js` signs fictional requests the way Twilio
does, behind a tunnel-shaped proxy, if you need a worked example.

## Endpoints

### `GET /health`

Returns `{ok: true, ts: <epoch_ms>}`. Useful for the renderer to verify
the server is up before requesting a token. When `npm run phone` started
the server it also returns `launch: <id>`, the random per-launch id from
`OPERATOR_LAUNCH_ID`, so the launcher and the app can tell this server,
reached directly or through the tunnel, from another program on the port.
The id identifies the run and grants nothing.

### `POST /token`

Private: needs the local API key (see above).

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
callers aren't on localhost), but it answers only requests with a valid
Twilio signature (see [Twilio webhook signatures](#twilio-webhook-signatures)),
and the response contains no secrets. Twilio may call it with GET or POST;
both are signed.

## Security notes

- `/token`, `/sms/send` and `/sms/conversations` are private: they return
  signed JWTs, send billable SMS and return message history, and must never
  be reachable through the tunnel. The server binds to `127.0.0.1` and
  checks every private request as described in
  [Public and private routes](#public-and-private-routes).
- `/twiml`, `/sms/inbound` and `/sms/status` are public, and refuse any
  request without a valid Twilio signature over the exact public URL and
  all its parameters — see
  [Twilio webhook signatures](#twilio-webhook-signatures). Knowing the
  tunnel URL is not enough to forge an inbound message, a delivery update
  or a call. Their responses contain only TwiML or `{ ok }` — no secrets,
  no history.
- A signature has no expiry, so someone who captured a genuine signed
  request could send it again. Twilio's requests travel over HTTPS to the
  tunnel, so that would take access to the traffic itself.
- `TWILIO_AUTH_TOKEN` is the account's master credential. It stays in
  `server/.env` (gitignored) and is used only to check signatures; tokens
  and SMS sends keep using the API key.

## Production alternative

If you don't want to run a local Node process, deploy the equivalent
serverless function to Twilio Functions, AWS Lambda, Cloudflare Workers,
etc. The renderer's main process just needs an HTTP endpoint that returns
`{ token, identity, ttl }` for a `POST` with `{ identity }`.


## Workspace endpoints and send outcomes

`GET /me` returns only `{ ok, callerId, smsFrom }` through the same private-route gate
as tokens and history. `POST /sms/clear` with `{ number }` confirms clearing local
history for that number; it does not contact Twilio. The desktop uses its SMS broker,
which supplies this run's local key. There is no unauthenticated browser/CORS fallback.

An explicit provider rejection records `failed`; a transport error or server-side
failure after submission records `unknown`, because Twilio may have accepted it.
These statuses survive in the existing conversation store. The renderer never
retries automatically, and offers resend only for confirmed failed/undelivered
messages. A late authoritative delivery update can still settle a known SID.
