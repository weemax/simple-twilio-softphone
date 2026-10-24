# simple-twilio-softphone

A Twilio-powered desktop softphone built as an Electron + React app. Voice calling over WebRTC and an SMS chat panel, both backed by a local Node service that signs Twilio capability tokens and brokers outbound/inbound webhooks.

This project is a fork of Kevin Whinnery's abandoned [operator](https://github.com/kwhinnery/operator) (originally part of his `#100DaysOfCode` challenge, day 1/100). See `NOTICE` for full attribution.

## What's in the box

- **Voice calling** — register a Twilio `Device` (WebRTC) inside Electron, dial a number, place a call, mute, hang up, send in-call DTMF, answer/decline inbound calls
- **SMS workspace** — searchable named conversations, recipient-specific saved drafts, local unread counts, day groups, delivery badges, encoding-aware segment estimates, archive/restore and confirmed local-history clearing. One-to-one text messages; photos follow in a separate accepted piece.
- **Contacts** — local add/edit/search/remove, reviewed CSV import, Text opens the right thread, and Call confirms the named destination
- **Calls** — dialer and persistent recent/missed calls observed by this app; incoming calls stay answerable without discarding drafts
- **Inbound SMS notifications** — native OS notification + bundled sound on genuinely new inbound messages, deduplicated per session by message SID
- **Local Node service** — signs Twilio capability tokens, serves TwiML for outbound voice, brokers inbound SMS webhooks, tracks delivery status via Twilio's status callback
- **Polling-based live updates** — 3s poll from the renderer picks up new inbound messages and status changes

## Status

| Feature | State |
|---|---|
| Electron app boots (dev + prod) | working |
| Voice: device registration + outbound PSTN dial | working, **requires TwiML App outbound Caller ID set in console** (see `HANDOFF.md` §8a) |
| Voice: in-call UI (mute, hangup, DTMF keypad) | working |
| Voice: inbound call routing + Answer/Decline UI | implemented, **requires `OPERATOR_IDENTITY` set in `server/.env`** (see `server/README.md`) and the webhook signature settings below; not exercised against a real inbound number |
| Voice: Operator-to-Operator (Client-to-Client) | server-side `<Dial><Client>` path is implemented, untested end-to-end |
| SMS: outbound send (composer → Twilio) | working |
| SMS: inbound webhook (Twilio → server → UI) | working, **requires the webhook signature settings below** |
| SMS: inbound notification (native OS alert + sound) | working |
| SMS: delivery status badges (queued → sent → delivered / failed) | working, **requires `PUBLIC_BASE_URL` set in `server/.env`** (see `HANDOFF.md` §3c) |
| SMS: search, drafts, unread counts, archive/restore | implemented locally; unread counts are not remote read receipts |
| Contacts and reviewed CSV import | implemented locally; duplicate numbers never overwrite existing contacts |
| Recent/missed call history | implemented for calls this app observes, not account-wide or closed-app history |
| SMS: read receipts, typing indicators, group threads | out of scope |
| Photos (US/Canada), manual contact queue, one-command startup and reviewed Twilio setup | accepted as separate implementation pieces; see `docs/phone-ux-plan.md` |
| Phone number management UI | not implemented (planned) |
| Private routes (`/token`, `/sms/send`, `/sms/conversations`) closed to the tunnel | working — tunneled requests get 403; the app's main process uses a per-start local API key |
| Twilio webhook signature verification (`/twiml`, `/sms/inbound`, `/sms/status`) | working — requests without a valid Twilio signature over the exact public URL get 403; **requires `TWILIO_AUTH_TOKEN` and `PUBLIC_BASE_URL` in `server/.env`**, without which every webhook is refused (see `server/README.md`) |
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

Put the tunnel's address and your Auth Token in `server/.env`, then restart the token server:

```env
PUBLIC_BASE_URL=https://YOUR-RESERVED-DOMAIN.ngrok-free.app
TWILIO_AUTH_TOKEN=your_auth_token_here
```

Then configure the URLs in the Twilio console, starting with exactly that address — full walkthroughs in `HANDOFF.md` §3 (voice) and §3b/§3c (SMS). Only the webhook paths and `/health` answer through the tunnel; the private routes refuse tunneled requests, and the webhooks refuse any request Twilio did not sign.

## Daily workspace

Messages, Calls, Contacts and Settings keep the last selected section. Contacts, drafts,
archive state, local unread IDs, reading positions and app-observed call history are
saved through the isolated desktop bridge in the existing app data folder's
`config.json`, under `workspace`. Writes are atomic and owner-only. SMS history stays
in its existing server store; no history or secret migration runs.

- Contacts require `+` and an explicit country code. Removing one removes its name,
  not its message history. Text opens a draft without sending. Call first shows the
  name and number for confirmation.
- CSV import accepts a header row, quoted fields and blank rows. Map name/phone
  columns, review every result, then import valid new rows. Existing numbers are
  skipped without overwriting; Cancel writes nothing. Import never queues or calls.
- Message search covers retained inbox or archived history (up to the existing
  500 messages per thread). Select a result to jump to that message.
- Drafts belong to their recipient and survive section changes, calls and restart.
  Enter sends; Shift+Enter inserts a newline. Segment estimates distinguish GSM-7
  and Unicode; actual billing and sender-specific limits remain Twilio's.
- Archive preserves history. Clear asks first and removes only the local thread's
  history, not provider/recipient copies or your draft.
- A confirmed failed message offers **Review resend**. A transport timeout is
  **unknown**, not proof of failure; that text stays blocked while its result is
  unknown and is never resent automatically. Check the Twilio message log.
- Native SMS notification clicks focus this app and open the corresponding thread.
  History hydration does not alert; each newly observed inbound message alerts once.
- Recents include calls this running app observed. A closed app cannot record missed
  calls. Existing answer/decline, mute, hangup, duration and in-call DTMF remain.

Local metadata and drafts are plaintext within your owner-only app data file; this
piece adds no cloud sync. If a save fails, keep the window open and resolve the
reported disk-access problem before restarting.

### Verification

```bash
npm ci
npm ci --prefix server
CI=true npm test -- --watchAll=false --runInBand
CI=true npm run build
```

The workspace's isolated browser and actual Electron journeys use fictional data,
a fake provider boundary and disposable profiles, never a live account. See
[`tools/workspace-ui/README.md`](tools/workspace-ui/README.md).

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
        │  /token                │  private (local API key)
        │  /twiml                │  public, Twilio-signed
        │  /sms/send             │  private (local API key)
        │  /sms/conversations    │  private (local API key)
        │  /sms/inbound          │  public, Twilio-signed
        │  /sms/status           │  public, Twilio-signed
        │  /health               │  public
        └────────────────────────┘
```

The token and SMS network paths keep the API secret backend-side. The existing account form still reads its unused saved Auth Token copy; the separately accepted Twilio setup piece removes that legacy read-back. Do not treat the renderer as a secret boundary until that piece ships. The local server answers only its public routes — the webhooks `/twiml` (and `/`), `/sms/inbound` and `/sms/status`, plus `/health` — through the ngrok URL, and the webhooks only for requests carrying Twilio's signature, which the server checks with the account's Auth Token against `PUBLIC_BASE_URL` and every request parameter. Because the tunnel itself connects from 127.0.0.1, every other route is private: it refuses requests that carry tunnel/proxy forwarding headers or a public `Host`, and requires the local API key the server writes to `server/.local-api-key` on each start, which only the Electron main process reads. That key also stops a web page in your browser from posting to `127.0.0.1:5050`.

## License

Apache License 2.0. See [`LICENSE`](./LICENSE) for the full text and [`NOTICE`](./NOTICE) for copyright and third-party attributions.

## Contributing

This is a single-maintainer project at the moment. If you want to contribute, open an issue describing the change first. See `HANDOFF.md` for the file map and architecture, then look at the open roadmap items in `HANDOFF.md` §10b.
