# Isolated workspace verification

These launchers exercise accepted TWP-9 **pieces 3 and 5** without real credentials,
provider requests, OS notifications, public tunnels or keychain access. Never run
an automated journey against the installed app or a real data profile.

The regular gate remains:

```sh
npm ci
npm ci --prefix server
CI=true npm test -- --watchAll=false --runInBand
CI=true npm run build
```

## Disposable tools and renderer

Run from the project root. Install verification tools outside the project; they are
not runtime dependencies. Choose an evidence folder outside the project as well.
The browser journey uses installed Chrome on macOS by default; set `CHROME_PATH`
for another installed Chrome/Chromium executable.

```sh
scratch=$(mktemp -d)
ui="$scratch/ui-tools"
npm install --prefix "$ui" --no-audit --no-fund esbuild playwright
export NODE_PATH="$ui/node_modules"
export OPERATOR_EVIDENCE_DIR="/absolute/path/outside/the/project/evidence"
export OPERATOR_TEST_ROOT="$scratch"
export OPERATOR_FIXTURE_DIR="$scratch/renderer"
node tools/workspace-ui/fixture.cjs "$PWD" 8089
```

The launcher stays in this terminal. In another terminal, with the same environment:

```sh
node tools/workspace-ui/journey.cjs http://127.0.0.1:8089
```

It drives the actual App, workspace/SMS providers and voice service. Only the IPC
and Voice SDK boundaries are fake. The fixture contains fictional phone numbers,
messages and predictable provider error shapes. It writes metadata into that
browser's isolated local storage, not the app's real files. Generated bundles,
screenshots and transcripts never enter the project. Failures close the test
browser instead of leaving an unbounded job.

Checks include contact validation and call confirmation, reviewed CSV and Cancel,
two recipient drafts across navigation/restart, incoming call interruption,
search-to-message, archive/restore, unread/notification deduplication and routing,
failed/unknown outcomes, keyboard sending, mute/DTMF/hangup/recents, reading position,
narrow list/detail, confirmed local clearing and contact removal preserving history.

The last group covers the manual contact queue (piece 5): selecting and adding contacts and
a thread, deduplication, ordering and restart persistence, a stale destination needing review,
one press dialing exactly the visible contact (a double press makes one call), an incoming call
blocking dialing, the far end or the person ending a call without anyone else being dialed, and
a restart during a call recording it as interrupted without redialing. The fictional Voice SDK
records every dial in `window.__fixture.calls`; no real call is possible.

## Actual Electron with real IPC and persistence

With the fixture still running:

```sh
export OPERATOR_FIXTURE_URL=http://127.0.0.1:8089
node tools/workspace-ui/desktop-journey.cjs
```

This uses the project's installed Electron executable. If necessary,
`ELECTRON_EXECUTABLE` may name an already installed, matching Electron version.
It does not launch that installation's project or data profile.

The launcher creates a disposable HOME and app profile beneath
`OPERATOR_TEST_ROOT`. It runs the real project main process, preload, authenticated
brokers, server, store and config-file writer. It stubs only Twilio REST, Voice SDK,
native notifications and safeStorage; every keychain operation is refused. All
credentials and numbers are fictional. It never reads `server/.env`.

The test waits for an acknowledged real IPC metadata write, terminates **only its
own test process**, and relaunches it to prove even an abrupt full restart preserves
the two drafts. It then checks that the real private API persists failed and unknown
outcomes and that the real bridge surfaces them. This is deliberately not a test
of `npm run phone`'s graceful process shutdown; `src/launcher.test.js` covers that. It removes its disposable
profile/database after reading the results, on success or failure.

## Photo messages through actual Electron

With the renderer fixture still running:

```sh
node tools/workspace-ui/desktop-photos-journey.cjs
```

It starts the fictional Twilio (`tools/fake-twilio`, which can also serve incoming media) and
launches the isolated Electron profile with the real preload, IPC, brokers, private service,
media store and workspace file. The Twilio SDK's send is stubbed by `desktop.cjs`, which records
the parameters it was handed (photo links included) in the disposable profile. The journey
attaches, previews, restarts abruptly, removes one photo, sends with a caption, receives a
signed webhook with three photos (one served through a CDN redirect, one GIF, one from an
unapproved address), opens the larger view, checks a Jamaican number's notice, a confirmed
failure, an unknown result and clearing, reading the link routes and the photo folder directly.
Nothing reaches a real provider, tunnel or Keychain.

## Real-speed draft demonstration

For video capture only, install Playwright's recording helper into the scratch
folder; no browser download is necessary when using installed Chrome:

```sh
export PLAYWRIGHT_BROWSERS_PATH="$scratch/browsers"
node "$ui/node_modules/playwright/cli.js" install ffmpeg
node tools/workspace-ui/demo.cjs http://127.0.0.1:8089
```

Viewer pauses are intentional, not retries or timing-based test assertions. Convert
the resulting WebM to silent H.264/yuv420p with fast-start when preparing a demo.
Keep the evidence outside the project and stop the fixture after verification.

## Twilio setup against a fictional Twilio

`tools/fake-twilio` is an in-memory Twilio account on 127.0.0.1 (numbers, API keys,
TwiML Apps, Messaging Services, failure injection, a request log with credentials
removed). `src/setup.test.js` and `src/serverSetupRoutes.test.js` use it directly. For
the actual Electron journey, with the renderer fixture from above still running:

```sh
node tools/workspace-ui/desktop-setup-journey.cjs
```

It starts the fake Twilio in its own process, launches the isolated Electron profile in
`OPERATOR_DESKTOP_SETUP=fresh` mode (no Twilio settings at all, so the app opens on
Settings → Twilio account) and drives Account → Number → Review → Connected through the
real preload, IPC, setup broker, private service and `server/.env`. It then checks what
the fake account received, that connecting twice writes nothing, that a restart repairs a
deleted application, and that nothing secret reached the page. No real provider, public
tunnel or Keychain is involved.
