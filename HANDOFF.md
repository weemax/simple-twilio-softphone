# Operator — Developer Handoff

**Project:** Twilio-powered desktop soft phone (Electron + React)
**Location:** `/Users/izzy/Projects/WebWolf/twilio-phone`
**Status:** Soft phone UI + Twilio Voice integration built end-to-end. Outbound PSTN calls reach Twilio and return valid TwiML, but a 31005 hangup is currently observed after the dial — caller ID / geography work pending.
**Original Author:** Kevin Whinnery (forked from kwhinnery/operator, abandoned)
**Last Updated:** 2026-06-05

---

## 1. What is this app?

Operator is a Twilio Voice soft phone that runs as a desktop Electron app. The user enters their Twilio credentials once; the app then:

- stores the Auth Token in macOS Keychain (via Electron `safeStorage`)
- fetches a signed capability JWT from a local Node service
- uses the JWT to register a Twilio `Device` (WebRTC) inside the renderer
- lets the user dial a number, place a call, mute, hang up, send DTMF

It does **not** include SMS, phone-number purchasing, Operator-to-Operator VoIP, or Operator-to-Operator chat yet. Those are tracked in §10.

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

If you get NXDOMAIN from your own terminal, your local DNS is broken — Twilio uses its own DNS, so this doesn't block the test. Use 1.1.1.1 to confirm globally:
```bash
nslookup YOUR-DOMAIN.ngrok-free.app 1.1.1.1
```

---

## 4. Architecture

```
┌────────────────────────────────────────────────────┐
│ Electron main process (main.js)                    │
│  - BrowserWindow with contextIsolation + preload   │
│  - IPC handlers: config, secrets, token, app       │
│  - safeStorage-backed secret store (Keychain)     │
│  - Token broker (talks to local server)            │
└─────────────────┬──────────────────────────────────┘
                  │ IPC (allowlisted channels)
┌─────────────────▼──────────────────────────────────┐
│ Preload (preload.js)                               │
│  - Exposes window.operator.{config,token,secrets,  │
│    app,on} to renderer via contextBridge           │
└─────────────────┬──────────────────────────────────┘
                  │ bridged API
┌─────────────────▼──────────────────────────────────┐
│ React renderer (src/)                              │
│  - TwilioProvider context (Device singleton)       │
│  - AccountConfig → encrypts Auth Token             │
│  - Dialpad / CallControls / CallScreen             │
│  - twilioService.js wraps @twilio/voice-sdk Device │
└────────────────────────────────────────────────────┘

        ┌────────────────────────┐
        │ server/server.js       │  127.0.0.1:5050
        │  POST /token → JWT     │  (token: localhost only)
        │  GET|POST /twiml → XML │  (twiml: public via ngrok)
        │  GET /health           │
        └────────────────────────┘
                ▲
                │ public webhook
        ┌───────┴────────────────┐
        │   Twilio Voice edge    │
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
1. **Default:** POST to `TOKEN_BACKEND_URL` (defaults to `http://127.0.0.1:5050/token`) and return the JWT. Used in dev with our Node server.
2. **Direct mint:** if `TWILIO_ACCOUNT_SID` + `TWILIO_API_KEY` + `TWILIO_API_SECRET` + `TWILIO_TWIML_APP_SID` are set in the **main-process** env, sign the JWT in-process using `@twilio/voice-sdk` (lazy-loaded). Skips the network round-trip.

---

## 5. File map

| File | Purpose |
|------|---------|
| `package.json` | Root project. Scripts: `dev`, `start`, `build`, `test`, `token-server`, `dev:all`. |
| `main.js` | Electron main. Creates window with `contextIsolation: true`, registers all IPC handlers, blocks in-app navigation to external URLs. |
| `preload.js` | Context-isolated bridge. Exposes `window.operator.{config, token, secrets, app, on}`. Channel allowlists. |
| `main/services/secrets.js` | safeStorage wrapper, plaintext fallback. |
| `main/services/config.js` | Plaintext non-secret config (SID, identity). |
| `main/services/tokenBroker.js` | Fetches/mints capability tokens. |
| `server/server.js` | Local Node service. `POST /token` (localhost), `GET\|POST /twiml` (public via ngrok), `GET /health`. |
| `server/.env.example` | Documents the four required env vars. |
| `server/README.md` | Server-specific setup, security notes. |
| `src/App.js` | Top-level: header, status bar, routing between AccountConfig / dialer / CallScreen. |
| `src/App.css` | Dark softphone theme. |
| `src/services/twilioService.js` | Device wrapper, snapshot pub/sub, token-refresh, mute, DTMF, call placement. |
| `src/hooks/useTwilioClient.js` | Singleton hook that owns the TwilioService lifecycle. |
| `src/contexts/TwilioContext.jsx` | React Context wrapper for the hook. |
| `src/components/AccountConfig/AccountConfig.jsx` | SID + Auth Token form. Auth Token goes into safeStorage. |
| `src/components/Dialpad/Dialpad.jsx` | 12-key keypad, backspace, in-call DTMF. |
| `src/components/CallControls/CallControls.jsx` | Call / hangup / mute / accept / reject buttons. |
| `src/components/CallScreen/CallScreen.jsx` | Live call UI with duration timer. |
| `public/index.html`, `public/manifest.json` | App shell metadata. |
| `HANDOFF.md` | This file. |

---

## 6. How a call flows (outbound)

1. User types a number into the dialpad, clicks **Call**
2. `App.js` calls `placeCall(number)` from `useTwilioClient`
3. `twilioService.placeCall` calls `device.connect({ params: { To: number } })`
4. Twilio Voice SDK establishes WebRTC, Twilio creates an outbound call
5. Twilio POSTs to the TwiML App's Voice URL (our ngrok `/twiml`)
6. `server.js` `handleTwiml` reads `To` from POST body or query string, emits:
   - `<Dial><Client>{to}</Client></Dial>` if `to` matches the safe-identifier regex (Operator→Operator, not yet implemented)
   - `<Dial><Number>{to}</Number></Dial>` if `to` looks like a phone number
7. Twilio dials the number, connects the WebRTC call
8. Renderer sees `Call.status === 'connected'`, duration timer starts

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

The `incomingCall` state in `twilioService.js` is wired up and the `incoming` prop flows to `CallControls` (which shows Accept/Reject), but this has not been tested end-to-end because no inbound number has been configured.

---

## 9. Recent changes (what the next dev should know about)

These bugs were hit and fixed during the build-out. If you see these symptoms, the fix is already in:

- **`config.set/get` IPC signature mismatch.** Renderer called `set(cfg)` (one arg), main expected `set(key, value)` (two args). Result: state held raw objects, identity shown as `[object Object]`. **Fix:** `preload.js` now passes `(key, value)`; App.js and AccountConfig both read whole config object and coerce to string defensively.
- **"Configure → save → reconfigure → no Cancel button".** Clicking Reconfigure showed the form with no way back to the dialer without re-saving. **Fix:** Cancel button added to AccountConfig; only shown when there's already a saved config.
- **`/twiml` not matching the TwiML App's URL.** User pasted the bare ngrok URL (no path); server returned 404; Twilio played "We are sorry" generic error. **Fix:** server now serves TwiML at both `/` and `/twiml`. Use `/twiml` for the production URL.
- **`.env` not loaded by Node.** `node server/server.js` doesn't read `.env` automatically. **Fix:** `dotenv` added as a server dep, `require('dotenv').config(...)` at the top of `server.js`.

---

## 10. Roadmap (planned but not started)

In rough priority order, from the original README:

1. **SMS panel** — Twilio Conversations SDK or REST + inbound webhook. AccountConfig already has the structure to store more creds.
2. **Phone number management UI** — search/buy/release via Twilio's IncomingPhoneNumbers API. Will need a new IPC channel + main-side service.
3. **Inbound call audio** — ringer/notification on the OS when `incoming` fires. Electron's `Notification` API or a custom audio element.
4. **Operator-to-Operator VoIP** — `<Dial><Client>` path is wired in server.js, just untested. Needs a way to know which identities are online.
5. **Operator-to-Operator chat & video** — would need Twilio Conversations + Video SDKs, both new deps.
6. **Distribution** — `electron-builder` for macOS/Windows/Linux installers. Not in package.json yet.
7. **TwiML App caller ID** — must be set in console for outbound calls to work (see §8a).

---

## 11. Useful console links

- Voice → TwiML Apps: https://console.twilio.com/us1/voice/twiml/apps
- Monitor → Calls: https://console.twilio.com/us1/monitor/logs/calls
- Monitor → TwiML: https://console.twilio.com/us1/monitor/logs/twiml
- Account → API keys: https://console.twilio.com/us1/account/keys-credentials/api-keys
- Phone Numbers → Verified: https://console.twilio.com/us1/develop/phone-numbers/verified
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
| main process | `TOKEN_BACKEND_URL` | override default `http://127.0.0.1:5050/token` |
| main process | `TWILIO_*` (4 vars) | enable direct-mint mode in `tokenBroker.js` (currently broken — see §8d) |

---

## 14. Contact / lineage

- Original repo: https://github.com/kwhinnery/operator (abandoned)
- Current fork: local at `/Users/izzy/Projects/WebWolf/twilio-phone`
- ngrok account: free plan with one reserved dev domain (verify by checking https://dashboard.ngrok.com/cloud-edge/domains)
- Twilio account: paid plan (per user)
