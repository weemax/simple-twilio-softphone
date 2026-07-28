# simple-twilio-softphone

A Twilio-powered desktop softphone built as an Electron + React app. Voice calling over WebRTC and an SMS chat panel, both backed by a local Node service that signs Twilio capability tokens and brokers outbound/inbound webhooks.

This project is a fork of Kevin Whinnery's abandoned [operator](https://github.com/kwhinnery/operator) (originally part of his `#100DaysOfCode` challenge, day 1/100). See `NOTICE` for full attribution.

## What's in the box

- **Voice calling** — register a Twilio `Device` (WebRTC) inside Electron, dial a number, place a call, mute, hang up, send in-call DTMF, answer/decline inbound calls
- **SMS chat** — conversation list, thread view with delivery-status badges, composer. 1:1 threads only, no MMS / group / media
- **Inbound SMS notifications** — native OS notification + bundled sound on genuinely new inbound messages, deduplicated per session by message SID
- **Local Node service** — signs Twilio capability tokens, serves TwiML for outbound voice, brokers inbound SMS webhooks, tracks delivery status via Twilio's status callback
- **Polling-based live updates** — 3s poll from the renderer picks up new inbound messages and status changes

## Status

| Feature | State |
|---|---|
| Electron app boots (dev + prod) | working |
| Voice: device registration + outbound PSTN dial | working, **requires TwiML App outbound Caller ID set in console** (see `HANDOFF.md` §8a) |
| Voice: in-call UI (mute, hangup, DTMF keypad) | working |
| Voice: inbound call routing + Answer/Decline UI | implemented, **requires `OPERATOR_IDENTITY` set in `server/.env`** (see `server/README.md`); not exercised against a real inbound number |
| Voice: Operator-to-Operator (Client-to-Client) | server-side `<Dial><Client>` path is implemented, untested end-to-end |
| SMS: outbound send (composer → Twilio) | working |
| SMS: inbound webhook (Twilio → server → UI) | working |
| SMS: inbound notification (native OS alert + sound) | working |
| SMS: delivery status badges (queued → sent → delivered / failed) | working, **requires `SMS_STATUS_CALLBACK_URL` set in `server/.env`** (see `HANDOFF.md` §3c) |
| SMS: read receipts, typing indicators, MMS, group threads, search | not implemented (out of scope) |
| Phone number management UI | not implemented (planned) |
| Inbound webhook signature verification | not implemented (v1 trusts the tunnel URL) |
| Production distribution (electron-builder installers) | not implemented |

For the full handoff doc with file map, IPC contract, call flow, environment variables, and console setup walkthroughs, see [`HANDOFF.md`](./HANDOFF.md).

## Quick start

Three processes: a local Node service, a React dev server, and the Electron app. Open three terminals at the project root.

```bash
# 1. Install
npm install
cd server && npm install && cp .env.example .env
# Edit server/.env with values from console.twilio.com — see server/README.md
cd ..

# 2. Token server (port 5050)
npm run token-server

# 3. React dev server (port 3000)
npm run dev

# 4. Electron
npm start
```

Or combine 1+2: `npm run dev:all`

For Twilio to reach your local webhook endpoints (both `/twiml` for voice and `/sms/inbound` for SMS), run an ngrok tunnel:

```bash
ngrok http --domain=YOUR-RESERVED-DOMAIN.ngrok-free.app 5050
```

Then configure the URLs in the Twilio console — full walkthroughs in `HANDOFF.md` §3 (voice) and §3b/§3c (SMS).

## Production-mode test

```bash
npm run build
ELECTRON_IS_DEV=0 npm start
```

## Architecture

```
┌────────────────────────────────────────────────────┐
│ Electron main process (main.js)                    │
│  - IPC handlers: config, secrets, token,           │
│    notification, sms                               │
│  - safeStorage-backed secret store (Keychain)      │
│  - Token broker + SMS broker (HTTP to local server)│
└─────────────────┬──────────────────────────────────┘
                  │ IPC (allowlisted channels)
┌─────────────────▼──────────────────────────────────┐
│ React renderer (src/)                              │
│  - TwilioProvider (Device singleton)               │
│  - SmsProvider (SMS service + 3s polling)         │
│  - Dialpad / CallControls / CallScreen             │
│  - SmsPanel (conversation list + thread + composer)│
│  - smsNotifications (native alert + sound on new   │
│    inbound SMS)                                    │
└─────────────────────────────────────────────────────┘
                ▲
                │ public webhook (via ngrok)
        ┌───────┴────────────────┐
        │   Twilio Voice + SMS   │
        └────────────────────────┘
                ▲
                │ WebRTC (audio)
        ┌───────┴────────────────┐
        │  Twilio Device (in app)│
        └────────────────────────┘

        ┌────────────────────────┐
        │ server/server.js       │  127.0.0.1:5050
        │  /token                │  localhost only
        │  /twiml                │  public via ngrok
        │  /sms/send             │  localhost only
        │  /sms/conversations    │  localhost only
        │  /sms/inbound          │  public via ngrok
        │  /sms/status           │  public via ngrok
        │  /health               │
        └────────────────────────┘
```

Renderer is sandboxed — Auth Token / API Secret never cross the IPC boundary, only signed JWTs and result data. The local server has a localhost guard on every endpoint except the two public webhooks (`/twiml` and `/sms/inbound` and `/sms/status`), which are reached via the unguessable ngrok URL.

## License

Apache License 2.0. See [`LICENSE`](./LICENSE) for the full text and [`NOTICE`](./NOTICE) for copyright and third-party attributions.

## Contributing

This is a single-maintainer project at the moment. If you want to contribute, open an issue describing the change first. See `HANDOFF.md` for the file map and architecture, then look at the open roadmap items in `HANDOFF.md` §10b.
