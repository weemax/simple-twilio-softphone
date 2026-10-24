# simple-twilio-softphone

A Twilio-powered desktop softphone built as an Electron + React app. Voice calling over WebRTC and an SMS chat panel, both backed by a local Node service that signs Twilio capability tokens and brokers outbound/inbound webhooks.

This project is a fork of Kevin Whinnery's abandoned [operator](https://github.com/kwhinnery/operator) (originally part of his `#100DaysOfCode` challenge, day 1/100). See `NOTICE` for full attribution.

## What's in the box

- **Voice calling** — register a Twilio `Device` (WebRTC) inside Electron, dial a number, place a call, mute, hang up, send in-call DTMF, answer/decline inbound calls
- **SMS workspace** — searchable named conversations, recipient-specific saved drafts, local unread counts, day groups, delivery badges, encoding-aware segment estimates, archive/restore and confirmed local-history clearing. One-to-one messages, with JPEG/PNG photos to and from United States and Canadian numbers (see [Photos](#photos)).
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
| One-command startup (`npm run phone`) | working — starts the local service, React, ngrok and the desktop app, waits for each to answer, and stops only what it started; see Quick start |
| SMS: photos (MMS) to and from US and Canadian numbers | working — JPEG/PNG, up to 10, under 5 MB with the text, **needs the public tunnel** for sending (24-hour links); see Photos |
| Manual contact queue (Calls → Queue) | implemented locally; every contact needs its own **Call next** press, nothing advances, redials or resumes by itself; see Daily workspace |
| Phone number management UI | not implemented (planned) |
| Private routes (`/token`, `/sms/send`, `/sms/conversations`) closed to the tunnel | working — tunneled requests get 403; the app's main process uses a per-start local API key |
| Twilio webhook signature verification (`/twiml`, `/sms/inbound`, `/sms/status`) | working — requests without a valid Twilio signature over the exact public URL get 403; **requires `TWILIO_AUTH_TOKEN` and `PUBLIC_BASE_URL` in `server/.env`**, without which every webhook is refused (see `server/README.md`) |
| Production distribution (electron-builder installers) | not implemented |

For the full handoff doc with file map, IPC contract, call flow, environment variables, and console setup walkthroughs, see [`HANDOFF.md`](./HANDOFF.md).

## Quick start

One-time setup, at the project root:

```bash
npm install
npm install --prefix server
cp server/.env.example server/.env
# Edit server/.env with values from console.twilio.com — see server/README.md
```

Install [ngrok](https://ngrok.com/download) and sign in once with
`ngrok config add-authtoken <your authtoken>`. ngrok gives each launch a new random
address unless you fix one. Your free account has one dev domain (Gateway → Domains
in the ngrok dashboard, such as `https://abc123xyz.ngrok-free.dev`). Put it in
`server/.env` once, so the address never changes:

```env
NGROK_URL=https://abc123xyz.ngrok-free.dev
```

`npm run phone -- --ngrok-url https://abc123xyz.ngrok-free.dev` does the same for one run.
Operator then starts ngrok on that address and refuses to start if `PUBLIC_BASE_URL` in
`server/.env` names a different one. Without `NGROK_URL`, Operator updates its own TwiML
App to each launch's address once you have connected (see Connecting Twilio).

Each session:

```bash
npm run phone
```

This one command starts the local service (port 5050, or `PORT` in `server/.env`),
the React dev server (port 3000), ngrok and the Operator desktop app. It waits until
each part actually answers, not for a fixed time, then prints a summary:

```
[phone] Operator is ready.
  Local service   http://127.0.0.1:5050 (answering)
  Public tunnel   https://your-dev-domain.ngrok-free.app (reaches the local service)
  React           http://localhost:3000
  Desktop app     open
```

- It reads the address ngrok assigned from that ngrok's local status, checks that the
  address reaches this local service, and gives it to the service for Twilio's
  signatures and delivery updates, so `PUBLIC_BASE_URL` in `server/.env` is not needed.
  The URLs in the Twilio console must use that address (see below); the reviewed
  in-app Twilio setup piece will update them for you.
- With a fixed address, ngrok refuses an address that is not on your account (ERR_NGROK_320),
  and Operator never falls back to a random one: the app opens without a tunnel and says why.
- If ngrok is missing, not signed in or already running elsewhere, the app still
  opens: contacts, message history and sending texts work, and the app says why the
  tunnel is unavailable and that calls, incoming texts and delivery updates need it.
- It starts nothing when packages or required `server/.env` settings are missing,
  when a port is in use, or when an earlier run left processes behind, and names the
  fix. It never stops a program it did not start. `npm run phone -- --react-port 3001`
  and `--service-port 5051` choose other ports.
- A second `npm run phone` in the same project starts nothing, and a second Operator
  window brings the first to the front, so there is never a second writer.
- Quitting Operator, or Ctrl+C in that terminal, stops everything the command started,
  including their helper processes, and nothing else. `npm run phone -- --stop` does
  the same from another terminal, or stops what an earlier run left behind.

Settings → Connection shows the local service, the public tunnel, the Twilio account,
voice registration, incoming calls, incoming texts, the delivery callback, the Voice URL on
Operator's TwiML App (and whether it matches this session's address), message updates,
the SMS sender and photo (MMS) capability separately.

### Connecting Twilio

An unconnected first launch opens **Settings → Twilio account** (Account → Number →
Review → Connected). Enter your Account SID and Auth Token (or reuse the ones already in
`server/.env`), choose one existing number, review every change, and Connect. Operator
creates its own API key and TwiML App and points only that number at them; a route that
goes to another application is shown and replaced only if you tick Replace for it.
Operator never buys a number. See [`server/README.md`](server/README.md#in-app-setup).

### Starting the parts separately

The low-level scripts remain, one terminal each: `npm run token-server` (port 5050),
`npm run dev` (port 3000) and `npm start` (Electron), or `npm run dev:all` for the
first two. Then start ngrok yourself:

```bash
ngrok http 5050
```

Put the address it prints and your Auth Token in `server/.env`, then restart the token server:

```env
PUBLIC_BASE_URL=https://YOUR-DEV-DOMAIN.ngrok-free.app
TWILIO_AUTH_TOKEN=your_auth_token_here
```

Started this way, Settings → Connection says the tunnel was not checked.

Either way, the URLs in the Twilio console must start with exactly the tunnel's address — full walkthroughs in `HANDOFF.md` §3 (voice) and §3b/§3c (SMS). Only the webhook paths and `/health` answer through the tunnel; the private routes refuse tunneled requests, and the webhooks refuse any request Twilio did not sign.

## Photos

Messages sends and receives photos for **United States and Canadian numbers only**: JPEG or PNG,
at most 10 per message, text and photos together under 5 MB.

- **Attaching keeps a photo on this computer.** *Attach photos* copies the chosen files into
  `sms-media/` beside the message store (owner-only) and previews them in the draft. Nothing is
  uploaded and no link exists until you press **Send**. Each recipient's photos are saved with
  their draft and survive a restart; remove them one at a time with ×.
- **Checked before Send.** The destination must be in the United States or Canada by area code
  (`+1` alone also covers Jamaica, Puerto Rico and other countries, which are refused), the
  sending number must not be known to lack MMS, and Operator's public address must be set.
  Each refusal shows a notice in the composer with no fallback to an SMS link. A tunnel that is
  not ready blocks photos only; texts and history keep working.
- **What Send does.** Only the selected photos get links, `PUBLIC_BASE_URL/media/<random token>`,
  valid for 24 hours and served through the tunnel as exactly that photo (nothing lists or
  guesses them). A confirmed failure closes the links; an unknown result leaves them open and
  never offers a resend. The message is labelled **MMS**, billed by Twilio as a picture message
  rather than by SMS segments.
- **Incoming photos.** The service downloads JPEG/PNG from Twilio's own media address for your
  account only (redirects only to Twilio's media CDN, credentials never forwarded, at most
  5 MB, 20 seconds). Other types, oversized, unreadable or unapproved photos show a placeholder
  that says why. Click a photo for a larger local view.
- **Clear** removes this computer's copies and closes their links, never the provider's or the
  recipient's.

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
- **Calls → Queue** is a manual call list. Add contacts one at a time or select several in
  Contacts (**Queue selected**), or add a conversation's number from its thread; the same
  number is queued once. The next contact shows its name and number; **Call next** dials
  exactly that contact with one press and no second dialog. When the call ends the outcome is
  recorded and the following contact simply waits for another press: nothing advances,
  redials or resumes on its own, including after hangup, a restart or an import. Reorder with
  Move up/Move down, or Skip/Remove. An incoming call, a call in progress or a lost voice
  connection blocks dialing and keeps every pending contact. Pending contacts are saved; a
  call that was in progress when the app closed is recorded as interrupted. A contact that was
  edited or removed after it was queued must be reviewed (**Use current details**, **Keep this
  number** or **Remove from queue**) before it can be dialed. Queue changes never touch message drafts.
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

`src/launcher.test.js` runs `npm run phone`'s launcher against the real local service
and stand-in React, Electron and ngrok processes (`launcher/test-fakes/`); it never
opens a real tunnel or contacts ngrok or Twilio.

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
│  - IPC handlers: config, token, notification, sms, │
│    session, setup (no secret read-back)            │
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
