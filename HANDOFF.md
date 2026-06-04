# Operator - Developer Handoff Document

**Project:** Twilio-powered desktop soft phone for developers  
**Location:** `/Users/izzy/Projects/WebWolf/twilio-phone`  
**Status:** Scaffold complete, softphone features not implemented  
**Original Author:** Kevin Whinnery (#100DaysOfCode - Day 1, abandoned)  
**Last Updated:** 2026-06-04

---

## Quick Start

The app has three processes to coordinate in dev: a token-signing server,
the React dev server, and the Electron shell. Easiest path:

```bash
# 1. One-time: install the local token broker
cd server && npm install && cp .env.example .env
# edit .env with TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET,
# TWILIO_TWIML_APP_SID (see server/README.md for how to get these)
cd ..

# 2. Terminal 1: token server (signs Twilio AccessTokens)
npm run token-server

# 3. Terminal 2: React dev server
npm run dev

# 4. Terminal 3: Electron
npm start
```

Or do steps 2+3 together: `npm run dev:all` (then `npm start` in a third
terminal).

### Production-mode test (no dev server)

```bash
export ELECTRON_IS_DEV=0
npm run build
npm start
```

---

## What Was Fixed

### Problem 1: Electron 7 Incompatible with Apple Silicon
**Symptom:** `npm install` failed with 404 error for `electron-v7.0.0-darwin-arm64.zip`

**Root Cause:** Electron v7 (2019) predates Apple Silicon. No ARM64 binary exists.

**Fix:** Updated to Electron v24 (see `package.json`)

```diff
- "electron": "^7.0.0"
+ "electron": "^24.0.0"
```

---

### Problem 2: Empty DOM in Electron Window
**Symptom:** Window opens but shows blank/white screen, no React content renders

**Root Cause:** Electron security settings blocked renderer execution

**Fix:** Updated `main.js` webPreferences

```javascript
// BROKEN (renderer can't execute JS)
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true
}

// FIXED
webPreferences: {
  nodeIntegration: true,
  contextIsolation: false,
  sandbox: false
}
```

**Note:** For production, implement proper IPC with preload script for security.

---

### Problem 3: React 18 Incompatibility
**Symptom:** `ReactDOM.render()` deprecated

**Fix:** Updated to React 18 API in `src/index.js`

```javascript
// Old (React 16)
ReactDOM.render(<App />, document.getElementById('root'));

// New (React 18)
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
```

---

## Current Project State

| Component | Status | Notes |
|-----------|--------|-------|
| Electron app launches | ✅ Works | v24, hardened with preload + contextIsolation |
| React dev server | ✅ Works | v18 |
| Production build | ✅ Works | `npm run build` |
| Softphone UI | ✅ Built | Dialpad, CallControls, CallScreen, status bar |
| Twilio integration | ✅ Built | @twilio/voice-sdk 2.18, Device + Call lifecycle |
| Account config (encrypted) | ✅ Built | safeStorage on macOS Keychain, plaintext fallback otherwise |
| Capability token broker | ✅ Built | `server/server.js` (localhost only), main process mints via fetch |
| SMS | ❌ Not built | Backend ready, UI not started |
| Phone number management | ❌ Not built | — |

---

## Package.json Dependencies

```json
{
  "dependencies": {
    "electron-is-dev": "^1.1.0"
  },
  "devDependencies": {
    "@electron/devtron": "^2.1.1",
    "electron": "^24.0.0",
    "electron-devtools-installer": "^4.0.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-scripts": "5.0.1"
  }
}
```

---

## Planned Features (from README)

- [ ] Manage Twilio account configuration
- [ ] Purchase and manage phone numbers
- [ ] Send / receive SMS messages per number
- [ ] Make / receive phone calls per number
- [ ] Package and distribute for major desktop app stores
- [ ] VoIP call other Operators (no PSTN)
- [ ] Chat with other Operators
- [ ] Video call other Operators

---

## Recommended Architecture

### Tech Stack Suggestions

| Layer | Recommendation |
|-------|----------------|
| **Voice** | Twilio Voice SDK (Client-side WebRTC) |
| **SMS** | Twilio SMS API + webhooks |
| **State** | React Context or Zustand |
| **Styling** | Tailwind CSS or styled-components |
| **Build** | electron-builder for distribution |

### Key Files to Create

```
src/
├── components/
│   ├── Dialpad/           # Phone keypad UI
│   ├── CallControls/      # Hangup, mute, hold buttons
│   ├── PhoneBook/         # Contact list
│   ├── SMSPanel/          # SMS conversation view
│   └── AccountConfig/     # Twilio credentials form
├── hooks/
│   ├── useTwilioClient    # Twilio device management
│   ├── useCalls           # Call state management
│   └── useMessages        # SMS state management
├── contexts/
│   └── TwilioContext      # Global Twilio state
└── services/
    └── twilioService      # Twilio API wrapper
```

### Twilio Setup Requirements

1. **Account SID & Auth Token** - User enters in app UI
2. **Twilio Client Capability Token** - Generated server-side (or Twilio Functions)
3. **Phone Numbers** - Purchased via Twilio API
4. **Webhooks** - For inbound SMS/calls

### Security Note

Current `main.js` has `nodeIntegration: true` for ease of development. For production:

1. Create `preload.js` with secure IPC
2. Move Twilio credentials to environment variables
3. Generate capability tokens server-side
4. Use contextIsolation + preload pattern

---

## Commands Reference

```bash
# Development
npm run dev           # Start React dev server (port 3000)
npm start             # Start Electron app
npm run token-server  # Start the localhost capability-token broker
npm run dev:all       # Start token-server + dev together

# Production
npm run build         # Build React app to ./build
ELECTRON_IS_DEV=0 npm start  # Run as production

# Cleanup
rm -rf ~/Library/Application\ Support/operator  # Clear Electron cache
```

---

## Architecture (after build-out)

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
        │  POST /token → JWT     │  (refuses other addrs)
        │  signs Twilio grant    │
        └────────────────────────┘
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Blank screen in Electron | Check `npm run dev` is running first |
| 404 on port 3000 | Kill process on port 3000: `lsof -ti :3000 \| xargs kill` |
| "Failed to fetch" in DevTools | DevTools extension issue, ignore (doesn't affect app) |
| Sandbox error in console | Disable with `sandbox: false` in webPreferences |

---

## Files Modified / Created

| File | Change |
|------|--------|
| `package.json` | Updated Electron, React, react-scripts; added @twilio/voice-sdk, concurrently |
| `main.js` | Added preload, contextIsolation, IPC handlers, hardened nav/openExternal |
| `preload.js` | **new** — contextBridge surface with allowlisted channels |
| `main/services/secrets.js` | **new** — safeStorage wrapper, plaintext fallback |
| `main/services/config.js` | **new** — non-secret config (SID, identity) |
| `main/services/tokenBroker.js` | **new** — talks to local token server, optional direct mint |
| `server/server.js` | **new** — localhost-only AccessToken signer |
| `server/package.json`, `server/.env.example`, `server/README.md` | **new** |
| `src/index.js` | React 18 createRoot |
| `src/App.js` | Top-level: header, status bar, AccountConfig/Dialpad/CallScreen routing |
| `src/App.css` | Softphone dark theme |
| `src/services/twilioService.js` | **new** — Device wrapper, snapshot pub/sub |
| `src/hooks/useTwilioClient.js` | **new** — singleton hook |
| `src/contexts/TwilioContext.jsx` | **new** — Context wrapper |
| `src/components/AccountConfig/AccountConfig.jsx` | **new** — SID/token form with safeStorage |
| `src/components/Dialpad/Dialpad.jsx` | **new** |
| `src/components/CallControls/CallControls.jsx` | **new** |
| `src/components/CallScreen/CallScreen.jsx` | **new** — duration timer |
| `public/index.html`, `public/manifest.json` | App title/theme |

## Still To Do

1. SMS panel — Twilio Conversations SDK or REST + webhook for inbound
2. Phone number management UI (search/buy/release)
3. Incoming call audio (ringer/notification)
4. Operator-to-Operator VoIP (no PSTN) and chat — already mentioned in README
5. Replace mock-state placeholder in `main_test.js` (file is unused, safe to delete)

---

## Next Steps for Developer

1. **Install Twilio SDK:** `npm install @twilio/voice-sdk @twilio/conversations`
2. **Design softphone UI** per features in README
3. **Implement account config panel** for SID/auth token entry
4. **Build dialpad component** for making calls
5. **Set up Twilio Functions** for capability tokens
6. **Add phone number management** via Twilio API
7. **Implement SMS panel** for messaging
8. **Consider proper IPC** with preload script for security

---

## Contact

- **Original Repo:** https://github.com/kwhinnery/operator
- **Current Fork:** Local (`/Users/izzy/Projects/WebWolf/twilio-phone`)
- **Upstream:** https://github.com/kwhinnery/operator (abandoned)
