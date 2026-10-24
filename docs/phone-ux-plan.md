# Accepted phone startup and workspace plan

Source: TWP-9, “Phone plan: one-step Twilio setup and two last questions”, accepted
with **Approve and build**. This replaces the earlier TWP-4 candidate plan. Approval
covers implementation of every piece below, not permission to merge or perform
live verification operations.

## Actual submitted settings

```json
{"version":3,"startup":"command","sms":"photos","contacts":"csv","calls":"recents","queue_mode":"manual","photo_countries":"United States and Canada","photo_max_count":10,"photo_formats":["jpeg","png"],"mms_limit_mb":5,"media_link_hours":24,"twilio_setup":"in_app","twilio_numbers":1,"foreign_routing":"ask","buy_number":"no"}
```

- One command manages the local session.
- Sending and receiving photos are included, for the United States and Canada.
- Contacts include reviewed CSV import.
- Calls include persistent recent/missed calls observed by this app.
- The queue requires a new **Call next** press for each contact. The request was:
  “Add call queue feature for dialing contact at a press of a button”.
- Before replacing each selected number setting that routes to another app, show
  its current destination and ask. Never assume consent for both voice and text.
- Never buy a number. List existing numbers and explain how to add one in the
  Twilio console when none is suitable.

## Five independently mergeable outcomes

Each outcome includes its tests. The split isolates process lifecycle, live account
changes, local workspace, media exposure and paid dialing risk. List order is not a
dependency. TWP-7's private-route gate and TWP-8's signed-webhook protection are on
main; retain both at every integration.

### 1. Start with one command

Needs both safety protections before public exposure. `npm run phone` starts the
local token/SMS service, React, Electron and ngrok. Read ngrok's assigned fixed
address from local status; nobody types a reserved domain. Wait on actual readiness,
not sleeps. Explain missing installs/settings, occupied ports, stale runs and ngrok
sign-in. A second launch cannot create a second writer. Quit stops only processes
this launcher owns. Retain the existing low-level scripts.

Pass the public address to the service for signatures and delivery callbacks. Keep
local-service health, tunnel reachability, voice registration, SMS sender and Twilio
account readiness distinct. Tunnel failure leaves contacts/history usable, while
calls, inbound/status updates and photos show their limitations.

Checks: fake child processes and ngrok status, readiness/failure cases, repeated
launch and owned shutdown. No real public tunnel in automated tests.

### 2. Connect Twilio in the app

Needs piece 1 and both safety protections. This is the only outcome that changes
live Twilio account configuration; verification uses a fake Twilio server.

- An unconnected first launch opens Settings → Twilio account. Otherwise Messages
  opens first; later launches restore the last section.
- Existing `server/.env` values are reused without retyping or returning a stored
  Auth Token/API secret to the renderer. Display token presence, not its value.
- Check account makes one read-only request. Distinguish invalid credentials from
  unreachable Twilio. List number capabilities and current voice/text routing.
- Review every key/app/voice/SMS/callback/identity change before Connect. Ask
  separately before replacing each foreign route. Blank and Operator-owned routes
  can update. Explain overriding SMS applications/Messaging Services; do not modify
  them silently.
- Create or reuse one Operator-owned API key and TwiML App. Change only the chosen
  number; leave other numbers, other applications/keys, billing and A2P alone.
- Connect twice creates no duplicates. Name a failed step; Retry resumes safely.
  Each launch checks and repairs only owned resources. Replace a deleted key/app;
  delete an owned old key only after the replacement works. Changed tunnel
  addresses update only Operator-owned settings.
- Keep `server/.env` owner-only as the single credential store, including the Auth
  Token required by signature verification. Collect missing Auth Token/public URL
  configuration through setup. Preserve the unused legacy desktop token copy
  without reading, migrating or deleting it. Remove renderer secret read-back and
  replace the legacy Configure form.
- Use one identity for registration and incoming voice. Preserve an existing
  separate `TWILIO_SMS_FROM`. Never buy a number.

Screens: Account/Number/Review/Connected steps; account fields and Check account;
number capabilities/current routes and console-add instructions; review rows with
unchecked per-route Replace controls; Back/Connect; Done/Unchanged results, repair
notes and Change number. Connection tab separates local service, tunnel, account,
voice, incoming voice/SMS, delivery callback and MMS sender capability.

### 3. Workspace and contacts

Independent of the new launcher/setup/media. This is the first implementation
outcome and the current PR's scope.

- Persistent Messages/Calls/Contacts/Settings navigation. Shared contact names and
  destinations. Incoming calls remain answerable without unmounting the workspace,
  discarding drafts or changing history position. Narrow windows use list/detail
  navigation instead of compressed columns.
- Search contact names, numbers and retained message text; open the matching
  message. Compose from a contact or explicit international-format number. Display
  name and number together.
- Persist recipient-owned text drafts and local unread IDs across sections and
  restart. Mark read only when the corresponding thread is visible. Existing
  history hydration does not produce notification alerts. Notification clicks
  focus the app and open the right thread. Preserve deduplication.
- Day separators, timestamps and truthful sending/sent/delivered/failed states.
  Delivery is not a read receipt. Keep failed content and offer reviewed resend
  only after confirmed failure. An uncertain transport result is unknown, never
  automatically resent. Keep its text across restart.
- GSM-7/Unicode-aware segment estimates and multi-segment warnings. Enter sends;
  Shift+Enter adds a line. Preserve the 1600-character ceiling and current
  500-message-per-thread retention. Search cannot recover older history.
- Archive/restore preserves messages. Confirm local-history clearing; never remove
  the recipient/provider's copies or the draft. Preserve follow-latest behavior
  without moving a reader who scrolled up.
- Contacts: one name and explicit international-format number, persistent
  add/edit/search/confirmed removal, normalized duplicate protection. Removal
  keeps messages. Text opens only; Call outside the queue confirms name/number.
- CSV: map name/phone columns, parse quoted rows and blanks, preview every row as
  new/duplicate/invalid. Import only reviewed valid new contacts, skipping existing
  numbers without overwrite. Invalid rows stay excluded until corrected. Cancel
  writes nothing; import never queues or calls.
- Persist app-observed recent/missed call outcomes, not account-wide or closed-app
  history. Preserve answer/decline, mute, hangup, duration and in-call DTMF.

Screens: Operator header; truthful current connection strip; persistent sidebar;
Messages New/search/archive/inbox rows, name/number/thread actions, day groups,
bubbles/statuses, recipient-labelled composer/estimate/Send; Contacts search,
add/edit/remove forms, Call/Text cards, CSV mapping/status table and Import; Calls
Dialer/Recents; Settings; outside-queue confirmation; incoming/active call panel.
Queue badges/actions, photos and reviewed setup are added by their own pieces, not
nonfunctional controls in this one. Fictional demo people, demo footers, tunnel
simulation buttons and launch simulations are not product settings/features.

Checks: deterministic model/storage/service/component tests, the real renderer
journey, an actual Electron journey with real preload/IPC/brokers and disposable
profiles, and tunnel-shaped proxy tests for the new private routes. Never access
real accounts/data or signing/keychain material.

### 4. Send and receive photos, US and Canada

Needs piece 3 and both safety protections. JPEG/PNG only, at most ten per message,
combined text/media under 5 MB. Validate actual image contents. Check recipient
country, not just `+1`, and MMS sender capability. Unsupported routes show a notice
before Send, with no silent SMS-link fallback.

Photo-only messages and captions work. Show previews, individual removal, incoming
multiple photos, larger local viewing and unavailable/unsupported placeholders.
Keep per-recipient attachment drafts and failed content through restart. Nothing
uploads merely by attaching. On explicit Send, only selected media receives
unguessable 24-hour links through the protected tunnel: no directory or private
endpoint access. Fetch incoming media backend-side only from approved Twilio
hosts/accounts, with bounded size and safe redirects. Clear removes local
references, not provider/recipient copies. Label attachments MMS, not SMS segments.

Checks: fake-provider send/receive, count/size/content, country/capability denial,
drafts/restart, failure/unknown outcomes, safe bounded downloads and expired links.

### 5. Manual one-press contact queue

Needs piece 3, not the launcher or media piece. Add individual or selected contacts,
show ordered names/numbers, move up/down, skip/remove and record outcomes. Deduplicate
pending/active normalized numbers. The named Call next button dials exactly the
visible contact with one press and no second confirmation dialog.

Serialize connecting/ringing/active calls; repeated presses cannot create another
leg. Every subsequent contact waits for another press. No automatic advancement,
redial or reopening/resume. Incoming calls and connectivity loss preserve pending
items and block new calls. Persist pending contacts across restart; changed/deleted
destinations need review before dialing. Queue actions never change message drafts.

Screens: Calls Queue/Dialer/Recents; queue badge, next name/number/readiness, named
Call button, active controls, Skip/Add contacts, numbered reorder/remove rows and
outcomes; Contacts selection/Queue selected/per-contact Add to queue; thread Add to
queue. Checks cover ordering/deduplication, single-flight calls, interruptions,
restart, stale destinations and outcomes with no paid traffic.

## Preservation and limits

Preserve all 14 adopted modifications and four new paths (`src/formatNumber.js`,
`src/smsStore.test.js`, `tests/`, `tools/`). The unrelated SMS-agent harness remains
untouched in the adopted folder; do not silently add, rewrite or drop it. Reconcile
adopted SMS features with the security gates rather than restoring the old browser
HTTP fallback. Extend metadata backward-compatibly; leave SMS history in place.

One user, desktop, account and selected number; explicit country codes; local
contacts/drafts/queue/unread/attachments; closed laptop is offline. Twilio signup,
trial upgrade, billing, A2P and Messaging Services remain manual. ngrok must be
installed and signed in once. No purchases, groups, reactions, remote read receipts,
typing indicators, edit/unsend, scheduling, voicemail, recordings, video/audio,
compression, contact sync, Mac address book, hosted service, installers, login
startup, multiple accounts or automatic dialing.
