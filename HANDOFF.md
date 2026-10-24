# Operator — Developer Handoff

**Project:** Twilio-powered desktop soft phone (Electron + React)
**Location:** `/Users/izzy/Projects/WebWolf/twilio-phone`
**Status:** Voice soft phone end-to-end (UI + Twilio Voice + WebRTC Device + Token broker). SMS chat feature shipped 2026-06-10 — server endpoints, IPC bridge, renderer service, and chat panel UI. Inbound calls now route to the softphone with an Answer/Decline UI, and outbound/inbound Dials preserve ringback via `answerOnBridge` (see §6a). Inbound SMS now also triggers a native OS notification + bundled sound (see §10a). Outbound PSTN calls require the TwiML App's outbound Caller ID to be set in console (see §8a); inbound calls require `OPERATOR_IDENTITY` set in `server/.env` (see §13); SMS requires the inbound webhook URL to be set on a Twilio number (see §3b).
**Recent updates:** Inbound PSTN ringing wired (2026-07-19, see §15). API-key rotation recovery documented (2026-07-19, see §16).
**Original Author:** Kevin Whinnery (forked from kwhinnery/operator, abandoned)
**Last Updated:** 2026-07-28

---

## 1. What is this app?

Operator is a Twilio Voice soft phone that runs as a desktop Electron app. The user enters their Twilio credentials once; the app then:

- stores the Auth Token in macOS Keychain (via Electron `safeStorage`)
- fetches a signed capability JWT from a local Node service
- uses the JWT to register a Twilio `Device` (WebRTC) inside the renderer
- lets the user dial a number, place a call, mute, hang up, send DTMF

It does **not** include phone-number purchasing, Operator-to-Operator VoIP, or Operator-to-Operator chat yet. SMS chat shipped 2026-06-10 — see §10a.

---

## 2. Quick Start

Three processes are needed for full development. Open three terminals at the project root.

### One-time setup

```bash
cd /Users/izzy/Projects/WebWolf/twilio-phone
npm install
cd server && npm install && cp .env.example .env
# edit .env — see server/README.md for what each value is
cd ..
```

`.env` values you need (all from console.twilio.com):
- `TWILIO_ACCOUNT_SID` — Account → API keys & tokens
- `TWILIO_API_KEY` — create one in API keys & tokens
- `TWILIO_API_SECRET` — shown once when you create the API key
- `TWILIO_TWIML_APP_SID` — Voice → TwiML Apps → copy SID

### Each session

```
# Terminal 1 — token server (signs Twilio AccessTokens + serves /twiml)
npm run token-server

# Terminal 2 — React dev server (port 3000)
npm run dev

# Terminal 3 — Electron window
npm start
```

Or combine 1+2:
```
npm run dev:all
```

### Production-mode test (no dev server)

```
npm run build
ELECTRON_IS_DEV=0 npm start
```

---

## 3. ngrok tunnel (required for Twilio to reach you)

Twilio's webhook servers need a public HTTPS URL pointing at your local `/twiml` endpoint. ngrok is the standard dev tunnel.

```
ngrok http --domain=YOUR-RESERVED-DOMAIN.ngrok-free.app 5050
```

The reserved dev domain (free, no endpoint hours) must be set up first at https://dashboard.ngrok.com/cloud-edge/domains — see screenshot in §11 for what that page looks like.

Copy the printed `https://…ngrok-free.app` URL and:

1. In console.twilio.com → Voice → TwiML Apps → your app → set **Voice URL** to `https://YOUR-DOMAIN.ngrok-free.app/twiml`
2. HTTP method: GET or POST (server handles both)
3. Save

**Important gotcha:** if you point the Voice URL at the bare tunnel (`https://…ngrok-free.app` with no path), the server now serves TwiML at `/` too (defensive — added after a real bug). Use `/twiml` for cleanliness.

**Verify it's reachable from outside your box:**
```bash
curl -H "ngrok-skip-browser-warning: true" https://YOUR-DOMAIN.ngrok-free.app/health
# expect: {"ok":true,"ts":...}
```

**Only the webhooks answer through the tunnel.** `/twiml`, `/`, `/sms/inbound`, `/sms/status` and `/health` are the public routes (`PUBLIC_ROUTES` in `server/server.js`). Every other route is private: the tunnel connects from 127.0.0.1, so the server also refuses any private request that carries forwarding headers (`X-Forwarded-*`, `Forwarded`, `Via`, `CF-Connecting-IP`) or a non-loopback `Host`, and requires the local API key the server writes to `server/.local-api-key` on each start (only the Electron main process reads it). Through the tunnel:
```bash
curl -X POST -H "ngrok-skip-browser-warning: true" https://YOUR-DOMAIN.ngrok-free.app/token
# expect: 403 {"error":"private route: not reachable through a tunnel or proxy"}
```

If you get NXDOMAIN from your own terminal, your local DNS is broken — Twilio uses its own DNS, so this doesn't block the test. Use 1.1.1.1 to confirm globally:
```bash
nslookup YOUR-DOMAIN.ngrok-free.app 1.1.1.1
```

### 3b. SMS webhook (same tunnel, different path)

The SMS feature reuses the same ngrok tunnel. Inbound SMS is delivered to a separate endpoint that the SMS feature exposes:

1. In console.twilio.com → Phone Numbers → Manage → Active Numbers → click your SMS-capable number
2. Scroll to the **"Messaging"** section
3. Under **"A MESSAGE COMES IN"** set:
   - **Webhook URL:** `https://YOUR-DOMAIN.ngrok-free.app/sms/inbound`
   - **Method:** POST
4. Click **Save**

The server returns an empty `<Response/>` on receipt so Twilio doesn't retry, and persists the message locally. The renderer's `SmsPanel` picks it up on the next 3s poll (see §6b).

**Note on A2P 10DLC (US, production):** For US destinations, Twilio requires A2P 10DLC brand + campaign registration before production SMS will deliver. Dev with a single verified/owned number is unrestricted. Register at https://console.twilio.com/us1/develop/sms/a2p-registration when you go to prod.

### 3c. SMS status callback (delivery receipts)

To get the `sent` → `delivered` / `failed` badge updates in the panel, the server registers a per-message `statusCallback` with Twilio when sending. Twilio POSTs to that URL whenever the message's delivery status changes. The server looks the message up by SID in the store and updates its status; the next 3s poll surfaces the change in the UI.

**Setup (one-time):**

1. Add this env var to `server/.env`:
   ```
   SMS_STATUS_CALLBACK_URL=https://YOUR-DOMAIN.ngrok-free.app/sms/status
   ```
2. Restart the token server. You should see on boot:
   ```
   [token-server] sms status callback: https://YOUR-DOMAIN.ngrok-free.app/sms/status
   ```
3. No Twilio console change is needed — the status callback URL is per-message, registered automatically by our `handleSmsSend` when it calls `messages.create()`.

**Alternative: set `SMS_PUBLIC_BASE_URL`** (e.g. `https://YOUR-DOMAIN.ngrok-free.app`) and the server will derive `/sms/status` from it. Same effect, one fewer path to keep in sync.

**Settling time:** outbound messages typically reach `delivered` within 2–10 seconds in the US. International can take longer. The 3s polling means there's up to a 3s display lag between Twilio delivering and the badge updating.

**What you see in the panel:**
- `queued` / `sending` — pending (white-ish badge)
- `sent` — accepted by Twilio, not yet delivered (white badge)
- `delivered` — confirmed delivered (green-tinted badge)
- `failed` / `undelivered` — terminal failure (red badge)

**Without the callback configured**, the badge stays at whatever Twilio returned at `messages.create()` time, which is usually `queued` or `sent`. The boot log will say `sms status callback: NOT CONFIGURED` if the env var is missing.

---

## 4. Architecture

```
┌────────────────────────────────────────────────────┐
│ Electron main process (main.js)                    │
│  - BrowserWindow with contextIsolation + preload   │
│  - IPC handlers: config, secrets, token,           │
│    notification, sms, app                          │
│  - safeStorage-backed secret store (Keychain)     │
│  - Token broker (talks to local server)            │
│  - SMS broker (talks to local server)              │
│  - Notification handler (native Notification API) │
└─────────────────┬──────────────────────────────────┘
                  │ IPC (allowlisted channels)
┌─────────────────▼──────────────────────────────────┐
│ Preload (preload.js)                               │
│  - Exposes window.operator.{config,token,secrets,  │
│    sms,notifications,app,on} to renderer via       │
│    contextBridge                                   │
└─────────────────┬──────────────────────────────────┘
                  │ bridged API
┌─────────────────▼──────────────────────────────────┐
│ React renderer (src/)                              │
│  - TwilioProvider context (Device singleton)       │
│  - SmsProvider context (SMS service + 3s polling)  │
│  - AccountConfig → encrypts Auth Token             │
│  - Dialpad / CallControls / CallScreen             │
│  - SmsPanel (conversation list, thread, composer)  │
│  - twilioService.js wraps @twilio/voice-sdk Device │
│  - smsService.js polls /sms/conversations, detects │
│    new inbound messages by SID                     │
│  - smsNotifications.js shows a native notification │
│    and plays public/notification.wav               │
└─────────────────────────────────────────────────────┘

        ┌────────────────────────┐
        │ server/server.js       │  127.0.0.1:5050
        │  POST /token → JWT     │  (token: private, local API key)
        │  GET|POST /twiml → XML │  (twiml: public via ngrok)
        │  POST /sms/send        │  (sms/send: private, local API key)
        │  GET /sms/conversations│  (sms/list: private, local API key)
        │  POST /sms/inbound     │  (sms/inbound: public via ngrok)
        │  POST /sms/status      │  (sms/status: public via ngrok)
        │  GET /health           │
        └────────────────────────┘
                ▲
                │ public webhook
        ┌───────┴────────────────┐
        │   Twilio Voice + SMS   │
        └────────────────────────┘
                ▲
                │ WebRTC (audio)
        ┌───────┴────────────────┐
        │  User's Twilio Device  │
        │  (in the Electron app) │
        └────────────────────────┘
```

### IPC contract

The preload (`preload.js`) gates everything behind allowlists. **When adding new IPC**, edit both `INVOKABLE_CHANNELS` and the matching `ipcMain.handle` in `main.js`. The signatures must match exactly — there was a real bug where `config.set(cfg)` was called on the renderer but main expected `(key, value)`. The renderer's `set` now passes both args. Keep them in sync.

Two channel types:
- `INVOKABLE_CHANNELS` — renderer → main, request/response via `ipcRenderer.invoke`
- `SUBSCRIBABLE_CHANNELS` — main → renderer, push via `ipcRenderer.on` (used for `call:incoming`, `error:log`)

### Secret storage

`main/services/secrets.js` uses Electron `safeStorage` (macOS Keychain, Windows DPAPI, libsecret on Linux). If safeStorage is unavailable, secrets fall back to a plaintext JSON file at `<userData>/secrets/store.json` with a warning logged. The renderer never sees the Auth Token; only the resulting JWT crosses the IPC boundary.

### Token broker

`main/services/tokenBroker.js` has two modes:
1. **Default:** POST to `TOKEN_BACKEND_URL` (defaults to `http://127.0.0.1:5050/token`) and return the JWT. Used in dev with our Node server. For a loopback URL the request carries the server's local API key (`main/services/localApiAuth.js`); a remote backend never receives it.
2. **Direct mint:** if `TWILIO_ACCOUNT_SID` + `TWILIO_API_KEY` + `TWILIO_API_SECRET` + `TWILIO_TWIML_APP_SID` are set in the **main-process** env, sign the JWT in-process using `@twilio/voice-sdk` (lazy-loaded). Skips the network round-trip.

---

## 5. File map

| File | Purpose |
|------|---------|
| `package.json` | Root project. Scripts: `dev`, `start`, `build`, `test`, `token-server`, `dev:all`. |
| `main.js` | Electron main. Creates window with `contextIsolation: true`, registers all IPC handlers, blocks in-app navigation to external URLs. |
| `preload.js` | Context-isolated bridge. Exposes `window.operator.{config, token, secrets, sms, notifications, app, on}`. Channel allowlists. |
| `main/services/secrets.js` | safeStorage wrapper, plaintext fallback. |
| `main/services/config.js` | Plaintext non-secret config (SID, identity). |
| `main/services/tokenBroker.js` | Fetches/mints capability tokens. |
| `main/services/smsBroker.js` | HTTP client to local server's `/sms/*` endpoints. Mirrors tokenBroker pattern. |
| `main/services/localApiAuth.js` | Adds the local server's API key (`Authorization: Bearer …`) to the brokers' requests to a loopback server, read fresh per request. |
| `server/server.js` | Local Node service. `POST /token` (private), `GET\|POST /twiml` (public via ngrok), `POST /sms/send` + `GET /sms/conversations` (private), `POST /sms/inbound` + `POST /sms/status` (public via ngrok), `GET /health` (public). Private routes refuse tunneled/proxied requests and need the local API key (`checkPrivateAccess`); any route not in `PUBLIC_ROUTES` is private. |
| `server/localApiKey.js` | Generates the per-start local API key and writes it 0600 to `server/.local-api-key` (or `OPERATOR_LOCAL_API_KEY_FILE`) once the server owns its port. |
| `server/smsStore.js` | JSON-backed conversation store. E.164 keyed, 500-msg cap, atomic write. Exposes `updateMessageBySid` for status callbacks. |
| `server/.env.example` | Documents the required env vars (now includes optional `TWILIO_SMS_FROM` and `OPERATOR_IDENTITY`). |
| `server/README.md` | Server-specific setup, security notes. |
| `src/App.js` | Top-level: header, status bar, routing between AccountConfig / dialer / CallScreen / SmsPanel. |
| `src/App.css` | Dark softphone theme. |
| `src/services/twilioService.js` | Device wrapper, snapshot pub/sub, token-refresh, mute, DTMF (with quiet local feedback tones), forwards `ringing`/`hasEarlyMedia`/`reconnecting`/`reconnected`, call placement. |
| `src/services/smsService.js` | SMS service singleton. Pub/sub snapshot, 3s polling, send, getThread, inbound-notification detection (dedupes by message SID, capped at `MAX_SEEN_INBOUND_IDS`). |
| `src/services/smsNotifications.js` | Renderer-side helpers for inbound SMS alerts: plays `public/notification.wav` and calls `window.operator.notifications.show(...)` for a native OS notification. |
| `src/hooks/useTwilioClient.js` | Singleton hook that owns the TwilioService lifecycle. |
| `src/hooks/useSmsClient.js` | Singleton hook that owns the SmsService lifecycle. |
| `src/contexts/TwilioContext.jsx` | React Context wrapper for the hook. |
| `src/contexts/SmsContext.jsx` | React Context wrapper for the SMS hook. |
| `src/components/AccountConfig/AccountConfig.jsx` | SID + Auth Token form. Auth Token goes into safeStorage. |
| `src/components/Dialpad/Dialpad.jsx` | 12-key keypad, backspace, in-call DTMF. |
| `src/components/CallControls/CallControls.jsx` | Call / hangup / mute / accept / reject buttons. |
| `src/components/CallScreen/CallScreen.jsx` | Live call UI with duration timer, in-call DTMF keypad, and incoming Answer/Decline UI. |
| `src/components/SmsPanel/SmsPanel.jsx` | SMS chat panel: conversation list, thread view with bubbles + status badges, composer. |
| `src/components/SmsPanel/SmsPanel.css` | Dark-theme styles for the SMS panel. |
| `public/index.html`, `public/manifest.json` | App shell metadata. |
| `public/notification.wav` | Bundled sound played on new inbound SMS. Local asset so alerts don't depend on a network request. |
| `HANDOFF.md` | This file. |

---

## 6. How a call flows (outbound)

1. User types a number into the dialpad, clicks **Call**
2. `App.js` calls `placeCall(number)` from `useTwilioClient`
3. `twilioService.placeCall` calls `device.connect({ params: { To: number } })`
4. Twilio Voice SDK establishes WebRTC, Twilio creates an outbound call
5. Twilio POSTs to the TwiML App's Voice URL (our ngrok `/twiml`), with
   `From` set to `client:{identity}` — that's how `handleTwiml` tells this
   apart from an inbound call (see §6a)
6. `server.js` `handleTwiml` reads `To` from POST body or query string, emits:
   - `<Dial answerOnBridge="true"><Client>{to}</Client></Dial>` if `to` matches the safe-identifier regex (Operator→Operator; server-side path implemented, see §8c)
   - `<Dial answerOnBridge="true"><Number>{to}</Number></Dial>` if `to` looks like a phone number
7. Twilio dials the number/client. Because `answerOnBridge` is set, Twilio
   keeps playing ringback to our caller until the far end actually
   answers, instead of marking the call answered as soon as the far leg
   starts ringing
8. Renderer's `TwilioService` forwards the SDK's `ringing` event (and
   `hasEarlyMedia`) into the snapshot, so the UI shows "Ringing…" during
   step 7. Once the far end answers, `Call.status()` becomes `'open'`
   (the SDK's status for an active call — `twilioService`/`CallScreen`/
   `CallControls` all treat `'open'` and the legacy `'connected'` the
   same), and the duration timer starts

## 6a. How a call flows (inbound)

1. A PSTN caller (or another Twilio Client) dials the Twilio number
2. Twilio POSTs to the same TwiML App Voice URL (`/twiml`). Since `From`
   does **not** start with `client:`, `handleTwiml` routes this as inbound
   rather than outbound (an empty `To` is not a reliable signal — inbound
   calls arrive with `To` set to the dialed Twilio number)
3. `server.js` emits `<Dial><Client>{OPERATOR_IDENTITY}</Client></Dial>`,
   with `callerId` set to the caller's own number (falls back to
   `TWILIO_CALLER_ID`). If `OPERATOR_IDENTITY` isn't configured, the
   caller hears a message instead and the call ends
4. This requires the `/token` grant's `incomingAllow: true` (set in
   `handleToken`) — without it Twilio drops the inbound leg to the
   Device even though the TwiML explicitly `<Dial>`s to the identity
5. The renderer's `Device` fires `incoming`; `TwilioService` stores the
   call as `incomingCall` and forwards `ringing`/`hasEarlyMedia` the same
   way as outbound calls
6. `App.js` renders `CallScreen` with `incoming={true}`, showing
   **Answer**/**Decline** instead of the normal in-call controls
7. Accepting moves the call from `incomingCall` to `currentCall`;
   `CallScreen` derives the `incoming`/`outgoing` label from the SDK's own
   `direction` flag (not which state slot the call is in), so an answered
   inbound call keeps showing as "Incoming" with the caller's number

## 6b. How SMS flows (outbound + inbound)

**Outbound:**
1. User types a message in the `SmsPanel` composer, presses Enter
2. `SmsPanel` calls `send({ to, body })` from `useSms`
3. `smsService.send` invokes `window.operator.sms.send(...)` via the preload bridge
4. Main process IPC handler `sms:send` calls `smsBroker.sendMessage(...)`
5. Broker POSTs to `http://127.0.0.1:5050/sms/send` with `{ to, body }` and the local API key as a bearer token
6. `server.js` `handleSmsSend`:
   - Persists a placeholder message locally with status `sending` (so the UI sees it immediately, even if Twilio is slow)
   - Calls Twilio's REST `messages.create({ to, from, body })` using the existing `TWILIO_API_KEY` + `TWILIO_API_SECRET`
   - On success: updates the local record with the real `sid` and Twilio's `status`
   - On failure: updates the local record to `failed` (so the UI shows the attempt with a red badge)
7. `smsService` triggers an immediate `_refresh()` so the open thread updates without waiting for the next 3s poll
8. Renderer re-renders the thread with the new outbound message + status badge

**Inbound:**
1. Twilio receives an SMS at the configured number and POSTs to the inbound webhook (our ngrok `/sms/inbound`)
2. `server.js` `handleSmsInbound` parses the form body (`From`, `Body`, `MessageSid`, `SmsStatus`)
3. Persists to the store with direction `inbound`, real `sid` from Twilio, status `received`
4. Returns empty `<Response/>` to Twilio so it doesn't retry
5. Renderer's `smsService` is polling every 3s; the next poll fetches the updated conversation list
6. `smsService._detectNewInboundMessages` diffs the fetched inbound messages against SIDs already seen this renderer session; any genuinely new one triggers `notifyInboundSms` (`src/services/smsNotifications.js`), which plays `public/notification.wav` and calls `window.operator.notifications.show(...)` to show a native OS notification (`main.js`'s `notification:show` IPC handler, silent so it can't double up with the bundled sound). History already present when the renderer first hydrates is seeded into the seen-set without alerting.
7. If the user is on the `SmsPanel`, `SmsPanel` detects the new message count in the selected thread and re-fetches the thread in the background
8. New bubble appears in the thread view with `at` timestamp

**Trust model on inbound:** for v1 the inbound endpoint trusts the tunnel URL (ngrok's URL is unguessable and no secrets are exposed in the response). Twilio webhook signature verification is a v2 item — flagged in the `handleSmsInbound` comment.

---

## 7. What's known to work

- Electron app boots (production + dev)
- React build is clean (`CI=true npm run build`)
- Tests pass (`npm test`)
- Token server boots, signs real JWTs against your Twilio creds
- AccountConfig saves SID + identity to `config.json`, Auth Token to safeStorage
- Re-launch persistence (credentials survive quit/reopen)
- Device registers with Twilio (status bar goes green "Ready")
- Outbound call reaches Twilio, hits `/twiml`, returns valid TwiML (verified in ngrok logs: `POST /twiml 200 OK`)
- Cancel button on Reconfigure screen (was missing — added)
- Defensive coercion on `config.get()` (was returning objects — fixed)
- Inbound call routing (`/twiml` → `<Dial><Client>{OPERATOR_IDENTITY}</Client></Dial>`, `/token` → `incomingAllow: true`) and the Answer/Decline `CallScreen` UI — covered by regression tests (`serverTwiml.test.js`, `twilioService.test.js`, `CallScreen.test.js`) but not exercised against a real inbound number (see §8e)
- Outbound and Client-to-Client `<Dial>` now sets `answerOnBridge="true"` so callers keep hearing ringback instead of the call appearing connected while the far end is still ringing; `ringing`/`hasEarlyMedia`/`reconnecting`/`reconnected` are forwarded through `TwilioService` snapshots and reflected in the UI (see §6, §6a)
- In-call DTMF keypad on `CallScreen`, with the SDK's loud local feedback tones replaced by quiet ones (`twilioService.js` `DTMF_FEEDBACK_SOUNDS`)
- **SMS chat end-to-end (108 passing assertions across 3 layers):**
  - Server: `POST /sms/inbound` webhook persists with real Twilio SID; `POST /sms/send` persists optimistic + updates on success/failure; `GET /sms/conversations` returns list + single-thread shape
  - IPC: main broker hits the server, preload bridge exposes `window.operator.sms.list/send`
  - Renderer: `SmsService` polls every 3s, `SmsPanel` shows conversation list + thread + composer with status badges
  - Failed outbound sends are persisted as `failed` (visible in UI) instead of vanishing
  - In-app `Voice` / `Messages` tab navigation; active calls always win over the SMS panel
- **SMS inbound notifications:** native OS notification + bundled sound (`public/notification.wav`) on genuinely new inbound messages; deduped per renderer session by message SID so reordering or re-polling never double-alerts, and history already loaded at session start is not alerted

## 8. What's known to be broken

### 8a. Outbound call hangs up immediately with 31005

**Root cause identified (2026-06-05): Missing Caller ID on the TwiML App.**

When a Client (WebRTC) call is originated via a TwiML App and the TwiML `<Dial>` has no `callerId` attribute, and the TwiML App itself has no outbound Caller ID configured, Twilio cannot determine what caller ID to present or use as the A-leg of the call. This produces error 31005.

**Confirmed working (no code changes needed):**
- Tunnel routing — ngrok shows `POST /twiml 200 OK`
- TwiML response — server correctly returns `<Response><Dial><Number>+16266958105</Number></Dial></Response>`
- Token broker — Device registers successfully ("Ready")
- `server.js` syntax: clean (verified with `node --check`)
- React build: clean (`CI=true npm run build` — compiled successfully)

**Fix required (Twilio Console — user must do this):**

The TwiML App needs an outbound Caller ID configured. Here is the exact steps:

1. Go to https://console.twilio.com/us1/voice/twiml/apps
2. Find your TwiML App (the one with SID starting `AP…`) and click on its name/link
3. Scroll to the **"Voice"** section
4. Look for the field **"Caller ID for outbound calls"** (it may be labeled "Outbound Caller ID" or just show "Not configured")
5. Click the dropdown and select a verified Twilio phone number from your account — if you have no verified numbers, you need to buy one first (see Phone Numbers → Buy a number) or verify your mobile at https://console.twilio.com/us1/develop/phone-numbers/verified
6. Click **Save** at the bottom of the page

After saving, restart ngrok and the token server, then retry the call.

**Verification:** After the fix, the call log at console.twilio.com → Monitor → Calls should show:
- `Duration > 0` (means the call actually connected, not a setup error)
- No 31005 error
- Status: `completed`

If the call still shows 31005 after adding a Caller ID, also check:
- **Geographic permissions:** go to console.twilio.com → Account → Regulatory Compliance → Geographic Permissions and ensure "United States" or the relevant country is allowed for voice.
- **Test number:** try `+1 650 253 0000` (Google's public test number) instead of `+16266958105` to rule out the destination rejecting the call.

### 8b. `main_test.js` is a stale duplicate

`/Users/izzy/Projects/WebWolf/twilio-phone/main_test.js` is leftover from earlier debugging. It's not loaded by `package.json` (which points to `main.js`) and doesn't affect anything. Safe to delete, but kept for reference. The user has been asked and has not consented to deletion; treat as read-only.

### 8c. Operator-to-Operator calls

The `server.js` `handleTwiml` will emit `<Dial><Client>…</Client></Dial>` if `To` looks like a safe identifier, but the receiving Operator must be **registered** with that identity in Twilio (i.e. the receiving user must have entered an identity matching and be online with a registered Device). Receiving inbound Client calls also requires the TwiML App to point at `/twiml` (which it does) and the receiver to have the same TwiML App configured. Not tested end-to-end.

### 8d. Token-server warnings

`server.js` `mintDirectly()` has a known-broken import (it tries to require `@twilio/voice-sdk.jwt`, which doesn't exist). This branch is only used if all four TWILIO_* env vars are set in the **main process** env, which the dev workflow doesn't do — so it's dead code in practice. Either delete the function or fix the import to use `require('twilio').jwt.AccessToken` (same as `handleToken`).

### 8e. Incoming call UI

The `incomingCall` state in `twilioService.js` is wired up, `handleTwiml`/`handleToken` now route real inbound calls to the operator's Client identity (see §6a), and the `incoming` prop flows to `CallScreen` (which shows Answer/Decline) and `CallControls`. This is covered by regression tests, but still has not been tested end-to-end against a real inbound number, and requires `OPERATOR_IDENTITY` to be set in `server/.env` (see §13).

---

## 9. Recent changes (what the next dev should know about)

These bugs were hit and fixed during the build-out. If you see these symptoms, the fix is already in:

- **`config.set/get` IPC signature mismatch.** Renderer called `set(cfg)` (one arg), main expected `set(key, value)` (two args). Result: state held raw objects, identity shown as `[object Object]`. **Fix:** `preload.js` now passes `(key, value)`; App.js and AccountConfig both read whole config object and coerce to string defensively.
- **"Configure → save → reconfigure → no Cancel button".** Clicking Reconfigure showed the form with no way back to the dialer without re-saving. **Fix:** Cancel button added to AccountConfig; only shown when there's already a saved config.
- **`/twiml` not matching the TwiML App's URL.** User pasted the bare ngrok URL (no path); server returned 404; Twilio played "We are sorry" generic error. **Fix:** server now serves TwiML at both `/` and `/twiml`. Use `/twiml` for the production URL.
- **`.env` not loaded by Node.** `node server/server.js` doesn't read `.env` automatically. **Fix:** `dotenv` added as a server dep, `require('dotenv').config(...)` at the top of `server.js`.
- **Inbound calls never reached the softphone.** `/twiml` had no inbound branch and `/token`'s `VoiceGrant` didn't allow incoming calls, so Twilio dropped any call placed to the Twilio number. **Fix:** `handleTwiml` now detects direction via `From` (`client:` prefix = outbound) and dials `<Client>{OPERATOR_IDENTITY}</Client>` for inbound; `/token` now sets `incomingAllow: true`.
- **Outbound calls appeared "connected" while still ringing.** `<Dial>` had no `answerOnBridge`, so Twilio's default behavior treated the call as answered as soon as the far leg started ringing — the caller heard nothing (no ringback) before the far end actually picked up, and `CallControls`/`CallScreen` only recognized the SDK's legacy `'connected'` status, not the current `'open'`. **Fix:** `answerOnBridge: true` added to outbound PSTN and Client `<Dial>`s; `TwilioService` forwards the SDK's `ringing`/`reconnecting`/`reconnected` events into snapshots; UI components treat `'open'` the same as `'connected'`.

---

## 10a. SMS chat — shipped 2026-06-10

End-to-end SMS chat in the `Messages` tab. Programmable SMS via Twilio REST + inbound webhook, polling-based UI (3s), JSON-file persistence, no new secrets required (reuses `TWILIO_API_KEY` / `TWILIO_API_SECRET` from `server/.env`).

**What works:**
- Outbound: composer → IPC → broker → server → Twilio `messages.create` → real SID + status reflected in the bubble
- Inbound: Twilio POSTs to `/sms/inbound` via ngrok → persisted → next 3s poll surfaces in list + thread
- Inbound notifications: a genuinely new inbound message triggers a native OS notification + bundled sound (`public/notification.wav`), deduped per session by message SID (see §6b)
- Delivery receipts: when `SMS_STATUS_CALLBACK_URL` is set, Twilio POSTs to `/sms/status` on every state change; badge updates `queued` → `sent` → `delivered` (or → `failed`/`undelivered`) within ~3s. See §3c.
- Failed sends are persisted as `failed` (red badge in UI) so they don't vanish
- Conversations sorted newest-first; 500-msg cap per thread; body capped at 1600 chars (Twilio limit)
- "+ New" button to start a thread with any E.164 number
- E.164 normalization is forgiving (`(650) 253-0000`, `6502530000`, `+165****0000` all → `+165****0000`)

**What does NOT work (explicitly out of scope for v1):**
- MMS / media attachments
- Group threads
- Read receipts
- Typing indicators
- Inbound signature verification (v1 trusts the tunnel URL; flagged for v2)
- SSE push for inbound (v1 uses 3s polling)

**Prod gate (US destinations):** A2P 10DLC brand + campaign registration is required for production SMS. Dev with a single verified/owned number is unrestricted. Register at https://console.twilio.com/us1/develop/sms/a2p-registration before going to prod.

## 10b. Roadmap (still planned, in rough priority order)

1. **Phone number management UI** — search/buy/release via Twilio's IncomingPhoneNumbers API. Will need a new IPC channel + main-side service.
2. **Inbound call audio** — OS-level ringer/notification when `incoming` fires (the in-app routing + Answer/Decline UI is implemented, see §6a; this item is specifically about an audible/OS alert so the operator notices a call while the app isn't focused). Electron's `Notification` API or a custom audio element.
3. **Operator-to-Operator VoIP** — `<Dial><Client>` path is wired in server.js, just untested. Needs a way to know which identities are online.
4. **Operator-to-Operator chat & video** — would need Twilio Conversations + Video SDKs, both new deps.
5. **Distribution** — `electron-builder` for macOS/Windows/Linux installers. Not in package.json yet.
6. **SMS: SSE push for inbound** — replace 3s polling with server-sent events. Saves battery, gives instant-feel UX.
7. **SMS: Twilio webhook signature verification** — currently trusts the tunnel URL. Add `twilio.validateRequest(...)` in `handleSmsInbound` before persisting.
8. **TwiML App caller ID** — must be set in console for outbound voice calls to work (see §8a).

---

## 11. Useful console links

- Voice → TwiML Apps: https://console.twilio.com/us1/voice/twiml/apps
- Monitor → Calls: https://console.twilio.com/us1/monitor/logs/calls
- Monitor → TwiML: https://console.twilio.com/us1/monitor/logs/twiml
- Monitor → Messages: https://console.twilio.com/us1/monitor/logs/messages
- Account → API keys: https://console.twilio.com/us1/account/keys-credentials/api-keys
- Phone Numbers → Manage → Active Numbers: https://console.twilio.com/us1/phone-numbers/incoming
- Phone Numbers → Verified: https://console.twilio.com/us1/develop/phone-numbers/verified
- Phone Numbers → Buy a number: https://console.twilio.com/us1/develop/phone-numbers/buy
- SMS → A2P 10DLC Registration: https://console.twilio.com/us1/develop/sms/a2p-registration
- ngrok dashboard (when running): http://127.0.0.1:4040

---

## 12. Commands reference

```bash
# from project root
npm run dev           # React dev server (port 3000)
npm start             # Electron
npm run token-server  # Localhost capability-token + /twiml broker
npm run dev:all       # token-server + dev together
npm run build         # Production build
npm test              # Smoke tests

# Production run
npm run build
ELECTRON_IS_DEV=0 npm start

# Cleanup
rm -rf ~/Library/Application\ Support/operator  # Wipes Electron userData
rm -rf ~/Library/Application\ Support/operator/secrets  # Wipes saved creds

# Server-only
cd server
node server.js                # Run directly
node --check server.js        # Syntax check
```

---

## 13. Environment variables

| Where | Variable | Purpose |
|-------|----------|---------|
| `server/.env` | `TWILIO_ACCOUNT_SID` | Twilio account SID (AC…) |
| `server/.env` | `TWILIO_API_KEY` | API key SID (SK…) |
| `server/.env` | `TWILIO_API_SECRET` | API key secret |
| `server/.env` | `TWILIO_TWIML_APP_SID` | TwiML App SID (AP…) |
| `server/.env` | `PORT` | default 5050 |
| `server/.env` | `HOST` | default 127.0.0.1 |
| `server/.env` | `TWILIO_CALLER_ID` | Verified Twilio number, used as `<Dial callerId>` (see §8a) and as fallback for outbound SMS |
| `server/.env` | `OPERATOR_IDENTITY` | **Required for inbound calls (added 2026-07-19).** The Twilio Client identity that inbound PSTN calls ring. Must match whatever identity the renderer registers with in the AccountConfig form. The TwiML App's inbound branch emits `<Dial><Client>{OPERATOR_IDENTITY}</Client></Dial>`. If unset, `/twiml` falls back to a `say`/hangup. |
| `server/.env` | `TWILIO_SMS_FROM` | **Optional.** Dedicated sender for outbound SMS; falls back to `TWILIO_CALLER_ID`. Set this if voice and SMS numbers differ. |
| `server/.env` | `SMS_STORE_PATH` | **Optional.** Override the conversation-store JSON path. Default `<server dir>/sms-store.json`. |
| `server/.env` | `SMS_STATUS_CALLBACK_URL` | **Optional.** Full URL Twilio should POST to on delivery status changes (e.g. `https://YOUR-DOMAIN.ngrok-free.app/sms/status`). See §3c. |
| `server/.env` | `SMS_PUBLIC_BASE_URL` | **Optional.** If `SMS_STATUS_CALLBACK_URL` is unset, the server derives `<base>/sms/status` from this. |
| main process | `TOKEN_BACKEND_URL` | override default `http://127.0.0.1:5050/token` |
| main process | `SMS_BACKEND_URL` | **Optional.** Override default `http://127.0.0.1:5050` for the SMS broker. |
| `server/.env` + main process | `OPERATOR_LOCAL_API_KEY_FILE` | **Optional.** Where the server writes, and the main process reads, the per-start local API key. Default `server/.local-api-key`. If you set it, set the same path for both processes. |
| main process | `TWILIO_*` (4 vars) | enable direct-mint mode in `tokenBroker.js` (currently broken — see §8d) |

---

## 15. Inbound calls — wiring (added 2026-07-19)

Inbound was previously stubbed (state wired, never tested). Three pieces connect to make ringing work end-to-end:

**1. Server-side (already in `server/server.js` HEAD):**

```js
// handleToken (server.js ~line 207) — VoiceGrant includes incoming.allow:
new VoiceGrant({
  outgoingApplicationSid: TWILIO_TWIML_APP_SID,
  incomingAllow: true,
})

// renderTwiml (server.js ~line 249) — inbound branch:
if (!to) {  // no `To` param = Twilio POSTing the number's voiceUrl
  if (OPERATOR_IDENTITY) {
    const dial = response.dial({ callerId: from || TWILIO_CALLER_ID });
    dial.client(OPERATOR_IDENTITY);
    return sendTwiml(res, response);
  }
  response.say('Operator is not configured to receive inbound calls yet.');
  return sendTwiml(res, response);
}
```

`OPERATOR_IDENTITY` is a new env var (see §13). For this account it's `operator-izzy`.

**2. Twilio Console wiring (user did, verified):**

- TwiML App `AP290878306ff5250fb3d846c49cd80847` (operator-softphone) — `voice_url = https://big-glider-clean.ngrok-free.app/twiml`
- Phone number `PN265dd7eae8850ba8f7c93d7063e70a16` (+1 508 978-5987) — `voiceApplicationSid = AP290878306ff5250fb3d846c49cd80847`

**3. Renderer-side:**

`@twilio/voice-sdk`'s `Device` must register with Twilio's signaling using a JWT that grants `incoming.allow=true`. The Device emits `registered` when its registration completes; that does **not** mean the WebRTC media leg is alive. If subsequent inbound calls show `answered_by: null` in Twilio's call log, the WS is not actually open.

**Symptoms when wiring breaks:**

| Where | Symptom | Cause |
|---|---|---|
| Twilio call log | `direction: inbound`, `answered_by: null`, `errorCode: undefined`, `duration: 0` | Device leg never connects. Stale JWT, identity mismatch, or stale WS. |
| Softphone DevTools console | Nothing logged; no Network request | Renderer's `device.on('incoming')` listener never fired → WS is closed or Device isn't registered. |
| ngrok inspection | `POST /twiml 200 OK` | Backend path is fine; failure is downstream of Twilio fetching the TwiML. |
| Softphone DevTools console | `Twilio.errors.AccessTokenInvalid (20101)` | `.env` references dead API Key. See §16. |

**Failure mode commonly hit:**

After every `server/.env` or Twilio-credential change, fully quit (Cmd+Q) and re-launch the softphone — `Cmd+R` in Electron keeps the WS alive on a stale token. The Device SDK considers itself "registered" but carries the prior JWT's grant set.

If "fully quit + re-launch" doesn't fix it, rotate the API Key (§16).

## 16. API-key rotation recovery (added 2026-07-19)

The Auth Token can be used to create a new API Key via Twilio's REST API — useful when `.env` references a deleted/unknown API Key.

**Symptoms this procedure solves:**

- Twilio Logs shows `code:20404` for `/Accounts/{SID}/Keys/{KID}.json` or `/Accounts/{SID}/Applications/{APID}.json`.
- Softphone shows `Twilio was unable to validate your Access Token (20101)` even after a server restart.
- `dotenv` reports all four `TWILIO_*` env vars are populated, but the API Key SID doesn't start with `SK…` (common silent-misconfig: the Auth Token was pasted into the API Key slot).

**Procedure:**

```bash
cd server
ASID=$(awk -F= '$1=="TWILIO_ACCOUNT_SID"{print $2}' .env | tr -d '\r')
AT=$(awk -F=   '$1=="TWILIO_AUTH_TOKEN" {print $2}' .env | tr -d '\r')

# 1. Create a new API Key. Capture sid (SK…) and secret (shown ONCE).
KEY_JSON=$(curl -sS -u "${ASID}:${AT}" -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/${ASID}/Keys.json" \
  --data-urlencode "FriendlyName=operator-softphone-$(date +%s)")
echo "$KEY_JSON"   # save sid + secret

# 2. Create (or reuse) a TwiML App with voiceUrl pointing at the tunnel.
APP_JSON=$(curl -sS -u "${ASID}:${AT}" -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/${ASID}/Applications.json" \
  --data-urlencode "FriendlyName=operator-softphone-$(date +%s)" \
  --data-urlencode "VoiceUrl=https://YOUR-NGROK-URL/twiml" \
  --data-urlencode "VoiceMethod=POST")
echo "$APP_JSON"   # save sid (AP…)

# 3. Update server/.env with the new values (line 3, 5, 6 in the active block).
cp .env .env.bak-$(date +%Y%m%d-%H%M%S)
sed -i '' 's|^TWILIO_API_KEY=.*|TWILIO_API_KEY=SK_NEW|' .env
sed -i '' 's|^TWILIO_API_SECRET=.*|TWILIO_API_SECRET=NEW_SECRET|' .env
sed -i '' 's|^TWILIO_TWIML_APP_SID=.*|TWILIO_TWIML_APP_SID=AP_NEW|' .env

# 4. Restart the token server. Then Reconfigure (or fully quit + re-launch) the softphone.
pkill -f "node server/server.js"
npm run dev:all
```

**Diagnostic probe (run before rotating — confirms whether the failure is here):**

```bash
cd server
ASID=$(awk -F= '$1=="TWILIO_ACCOUNT_SID"{print $2}' .env | tr -d '\r')
AT=$(awk -F=   '$1=="TWILIO_AUTH_TOKEN" {print $2}' .env | tr -d '\r')
KID=$(awk -F= '$1=="TWILIO_API_KEY"    {print $2}' .env | tr -d '\r')
AID=$(awk -F= '$1=="TWILIO_TWIML_APP_SID"{print $2}' .env | tr -d '\r')
curl -sS -u "${ASID}:${AT}" -o /dev/null -w "API Key   %{http_code}\n" \
  "https://api.twilio.com/2010-04-01/Accounts/${ASID}/Keys/${KID}.json"
curl -sS -u "${ASID}:${AT}" -o /dev/null -w "TwiML App %{http_code}\n" \
  "https://api.twilio.com/2010-04-01/Accounts/${ASID}/Applications/${AID}.json"
```

Both should return `200`. `404` on either means that resource is dead, and rotating fixes it.

**Why a server restart alone never fixes it:** `dotenv` reads `.env` synchronously at module load (`server.js:12`). Editing the file and restarting signs with the same wrong values if those values are still wrong. Always verify with the probe first.

**Scopes gotcha:** `POST /2010-04-01/Keys.json` (unscoped) returns `404` on the OneLeg account. The scoped form `POST .../Accounts/{SID}/Keys.json` works. Same for `Applications`. Use the scoped form.

**This account's current state (2026-07-19 verification):** Run the diagnostic probe above to get current live values. Do not hard-code SIDs in documentation.

---

## 14. Contact / lineage

- Original repo: https://github.com/kwhinnery/operator (abandoned)
- Current fork: local at `/Users/izzy/Projects/WebWolf/twilio-phone`
- ngrok account: free plan with one reserved dev domain (verify by checking https://dashboard.ngrok.com/cloud-edge/domains)
- Twilio account: paid plan (per user)
