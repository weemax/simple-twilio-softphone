// In-app Twilio setup (accepted TWP-9 piece 2): check the account, review
// every change, connect, and repair on each launch.
//
// This runs inside the token server because that process already holds the
// credentials and owns server/.env, the single credential store. The
// renderer reaches it through authenticated private routes and the main
// process; no route ever returns the Auth Token or an API secret.
//
// What it may change in the Twilio account, and nothing else:
//   - one Operator-owned API key and one Operator-owned TwiML Application,
//     recognised by their friendly name, `Operator softphone [<install id>]`
//     (the install id lives in server/.env, so two installs on one account
//     never touch each other's resources);
//   - the voice and text routing of the one number the person chose, and
//     each route only when it is blank, already Operator's, or the person
//     agreed to replace the exact destination they were shown.
// It never buys a number and never touches other numbers, keys,
// applications, Messaging Services, billing or A2P registration.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createApi, TwilioError } = require('./twilioApi');
const { updateEnvFile } = require('./envFile');

const MARKER = 'Operator softphone';
const SID_RE = /^AC[0-9a-fA-F]{32}$/;
const IDENTITY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VOICE_PATH = '/twiml';
const SMS_PATH = '/sms/inbound';
const STATUS_PATH = '/sms/status';

const ownedName = (installId) => `${MARKER} [${installId}]`;

class SetupError extends Error {
  constructor(message, { status = 400, kind = 'invalid' } = {}) {
    super(message);
    this.name = 'SetupError';
    this.status = status;
    this.kind = kind;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The public address Twilio will call, from the person's entry, or null.
// https only (Twilio's webhooks are signed over this exact URL), except a
// loopback address, which a test uses; no path, query or credentials.
function normalizePublicUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch (_) {
    return null;
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    return null;
  }
  return u.origin;
}

function fingerprint(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

function createSetup({ config, statePath, env = process.env, now = Date.now, retryDelayMs = 700, log = () => {} }) {
  let busy = false;

  // --- the non-secret connection record -------------------------------

  function readState() {
    if (!statePath) return {};
    try {
      const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch (_) {
      return {};
    }
  }

  function writeState(patch) {
    if (!statePath) return;
    const next = { ...readState(), ...patch };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, statePath);
  }

  function recordCheck(result, detail) {
    const state = readState();
    writeState({
      connection: { ...(state.connection || {}), checkedAt: now(), account: { state: result, detail: detail || null } },
    });
  }

  const available = () => Boolean(config.envFile && statePath);

  function requireAvailable() {
    if (!available()) {
      throw new SetupError('Setup is not available: this service has no server/.env to save to.', {
        status: 503,
        kind: 'unavailable',
      });
    }
  }

  // --- credentials and public address ---------------------------------

  // The account the request is about: what the person typed, else what
  // server/.env already holds. Neither is ever returned.
  function credentialsFor(input = {}) {
    const cfg = config.get();
    const accountSid = String(input.accountSid || '').trim() || cfg.accountSid;
    const authToken = String(input.authToken || '').trim() || cfg.authToken;
    if (!SID_RE.test(accountSid || '')) {
      throw new SetupError('Enter your Account SID (it starts with AC and has 34 characters).', { kind: 'missing-sid' });
    }
    if (!authToken) {
      throw new SetupError('Enter your Auth Token. Setup needs it to create the API key and check Twilio\'s signatures.', {
        kind: 'missing-token',
      });
    }
    if (/\s/.test(authToken) || authToken.length > 128) {
      throw new SetupError('The Auth Token should be one string without spaces.', { kind: 'missing-token' });
    }
    return { accountSid, authToken };
  }

  // The tunnel's address when `npm run phone` supplied one (the environment
  // wins), else the person's entry, else the saved one.
  function publicUrlFor(input = {}) {
    const cfg = config.get();
    if (cfg.publicBaseUrl && cfg.publicBaseUrlSource === 'environment') {
      return { url: cfg.publicBaseUrl, source: 'environment' };
    }
    const typed = String(input.publicBaseUrl || '').trim();
    if (typed) {
      const url = normalizePublicUrl(typed);
      if (!url) {
        throw new SetupError(
          'The public address must be an https address with no path, such as https://your-name.ngrok-free.app.',
          { kind: 'bad-public-url' }
        );
      }
      return { url, source: 'input' };
    }
    if (cfg.publicBaseUrl) return { url: cfg.publicBaseUrl, source: 'file' };
    return null;
  }

  function requirePublicUrl(input) {
    const found = publicUrlFor(input);
    if (!found) {
      throw new SetupError(
        'Twilio needs a public address to call. Start with npm run phone, or enter the https address of your tunnel.',
        { kind: 'missing-public-url' }
      );
    }
    return found;
  }

  function identityFor(input = {}) {
    const identity = String(input.identity || '').trim() || config.get().identity;
    if (!IDENTITY_RE.test(identity || '')) {
      throw new SetupError('Choose an identity of letters, numbers, - or _ (up to 64 characters).', { kind: 'bad-identity' });
    }
    return identity;
  }

  const apiWith = ({ accountSid, authToken }) => createApi({ accountSid, authToken, env });

  // --- routes ---------------------------------------------------------

  // How a number's voice or text route currently reads. `ownedSids` are the
  // applications that are Operator's; `pub` is the address Operator would
  // set. A route is Operator's when it points at an owned application, or
  // at exactly this address's webhook (an older manual setup that already
  // reaches this service). `staleSids` are Operator applications that no
  // longer exist: such a route is Operator's to repoint.
  function describeRoute(number, kind, ownedSids, pub, staleSids = new Set()) {
    const voice = kind === 'voice';
    const url = voice ? number.voiceUrl : number.smsUrl;
    const applicationSid = voice ? number.voiceApplicationSid : number.smsApplicationSid;
    const trunkSid = voice ? number.trunkSid : '';
    const fp = fingerprint({ kind, url, applicationSid, trunkSid });
    const base = { url, applicationSid, trunkSid, fingerprint: fp };
    if (trunkSid) {
      return { ...base, state: 'foreign', description: `SIP trunk ${trunkSid}` };
    }
    if (applicationSid) {
      if (ownedSids.has(applicationSid)) return { ...base, state: 'operator', description: 'Operator' };
      // An Operator application that has since been deleted and replaced.
      if (staleSids.has(applicationSid)) {
        return { ...base, state: 'stale', description: 'an Operator application that no longer exists' };
      }
      return { ...base, state: 'foreign', description: `application ${applicationSid}` };
    }
    if (url) {
      const wanted = pub ? pub + (voice ? VOICE_PATH : SMS_PATH) : null;
      return url === wanted
        ? { ...base, state: 'operator', description: `${url} (Operator, this address)` }
        : { ...base, state: 'foreign', description: url };
    }
    return { ...base, state: 'blank', description: 'not set' };
  }

  // The number list Check account returns, with routes as Twilio reports
  // them. One read-only request.
  async function check(input = {}) {
    requireAvailable();
    const creds = credentialsFor(input);
    const pub = publicUrlFor(input);
    const state = readState();
    const ownedSids = new Set([state.appSid].filter(Boolean));
    const staleSids = new Set((state.appSidHistory || []).filter((s) => s !== state.appSid));
    let listed;
    try {
      listed = await apiWith(creds).listNumbers();
    } catch (err) {
      return failedCheck(err);
    }
    recordCheck('ok');
    const cfg = config.get();
    return {
      ok: true,
      account: { sid: creds.accountSid },
      more: listed.more,
      numbers: listed.numbers.map((n) => ({
        sid: n.sid,
        e164: n.e164,
        friendlyName: n.friendlyName,
        capabilities: n.capabilities,
        current: n.e164 === cfg.callerId,
        voice: describeRoute(n, 'voice', ownedSids, pub && pub.url, staleSids),
        sms: describeRoute(n, 'sms', ownedSids, pub && pub.url, staleSids),
      })),
    };
  }

  function failedCheck(err) {
    if (!(err instanceof TwilioError)) throw err;
    const messages = {
      'invalid-credentials': 'Twilio did not accept this Account SID and Auth Token. Check them in the Twilio console.',
      forbidden: `Twilio accepted the sign-in but refused the request: ${err.message}`,
      unreachable: 'Could not reach Twilio. Check your internet connection; your Twilio settings were not changed.',
      'not-found': 'Twilio could not find this account.',
      rejected: `Twilio refused the request: ${err.message}`,
    };
    return { ok: false, kind: err.kind, error: messages[err.kind] || err.message };
  }

  // --- the pieces both Connect and the launch repair need -------------

  // Whether the stored API key and secret sign in. 'unknown' means Twilio
  // could not be asked, which is never a reason to replace the key.
  async function keyState(creds) {
    const cfg = config.get();
    if (!cfg.apiKey || !cfg.apiSecret) return 'missing';
    try {
      await createApi({ accountSid: creds.accountSid, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret, env }).getAccount();
      return 'valid';
    } catch (err) {
      if (err instanceof TwilioError && err.kind === 'invalid-credentials') return 'invalid';
      if (err instanceof TwilioError && err.kind === 'not-found') return 'invalid';
      throw err;
    }
  }

  function installIdFor() {
    return config.get().installId || crypto.randomBytes(4).toString('hex');
  }

  function writeEnv(updates, warnings) {
    const clash = config.shadowed(Object.keys(updates).filter((k) => updates[k] !== null));
    const { tightened } = updateEnvFile(config.envFile, updates);
    config.reload();
    if (clash.length) {
      warnings.push(
        `${clash.join(', ')} ${clash.length === 1 ? 'is' : 'are'} also set in the environment this app was started with, which wins over server/.env; remove ${clash.length === 1 ? 'it' : 'them'} there for the saved value to apply.`
      );
    }
    if (tightened) warnings.push('server/.env was readable by other users; it is now owner-only.');
  }

  // Creates a replacement key when the stored one is missing or rejected.
  // The secret is written to server/.env before anything else can fail, and
  // the old key is deleted only after the new one works, and only if it is
  // Operator's own.
  async function ensureKey(creds, installId, warnings) {
    const state = await keyState(creds);
    if (state === 'valid') return { action: 'unchanged', detail: 'The saved API key works.' };
    const api = apiWith(creds);
    const cfg = config.get();
    const oldKey = cfg.apiKey;
    const created = await api.createKey(ownedName(installId));
    try {
      writeEnv(
        {
          TWILIO_ACCOUNT_SID: creds.accountSid,
          TWILIO_AUTH_TOKEN: creds.authToken,
          OPERATOR_INSTALL_ID: installId,
          TWILIO_API_KEY: created.sid,
          TWILIO_API_SECRET: created.secret,
        },
        warnings
      );
    } catch (err) {
      // The secret exists only in memory: nothing could use this key.
      await api.deleteKey(created.sid).catch(() => {});
      throw new SetupError(`The new API key could not be saved to server/.env (${err.message}), so it was removed again.`, {
        status: 500,
        kind: 'save-failed',
      });
    }
    let verified = false;
    let lastError = null;
    for (let attempt = 0; attempt < 3 && !verified; attempt++) {
      if (attempt) await sleep(retryDelayMs);
      try {
        await createApi({ accountSid: creds.accountSid, apiKey: created.sid, apiSecret: created.secret, env }).getAccount();
        verified = true;
      } catch (err) {
        lastError = err;
        if (!(err instanceof TwilioError) || err.kind === 'rejected') break;
      }
    }
    if (!verified) {
      throw new SetupError(
        `The new API key does not sign in yet (${lastError ? lastError.message : 'unknown reason'}). It is saved; Retry checks it again.`,
        { status: 502, kind: 'key-unverified' }
      );
    }
    let removed = 0;
    try {
      for (const k of await api.listKeys()) {
        if (k.sid !== created.sid && k.friendlyName === ownedName(installId)) {
          await api.deleteKey(k.sid);
          removed += 1;
        }
      }
    } catch (err) {
      warnings.push(`An old Operator API key could not be removed yet (${err.message}); the next check will retry.`);
    }
    return {
      action: oldKey ? 'replaced' : 'created',
      detail:
        `Created API key ${created.sid} and saved it to server/.env.` +
        (removed ? ` Removed ${removed} old Operator key${removed === 1 ? '' : 's'} after the new one worked.` : ''),
    };
  }

  function desiredAppFields(installId, pub) {
    return {
      FriendlyName: ownedName(installId),
      VoiceUrl: pub + VOICE_PATH,
      VoiceMethod: 'POST',
      SmsUrl: pub + SMS_PATH,
      SmsMethod: 'POST',
      SmsStatusCallback: pub + STATUS_PATH,
    };
  }

  function appDifferences(app, want) {
    const diffs = [];
    if (app.voiceUrl !== want.VoiceUrl) diffs.push({ field: 'Voice URL', from: app.voiceUrl || 'not set', to: want.VoiceUrl });
    if (app.smsUrl !== want.SmsUrl) diffs.push({ field: 'Message URL', from: app.smsUrl || 'not set', to: want.SmsUrl });
    if (app.smsStatusCallback !== want.SmsStatusCallback) {
      diffs.push({ field: 'Delivery callback', from: app.smsStatusCallback || 'not set', to: want.SmsStatusCallback });
    }
    return diffs;
  }

  // The Operator-owned application: the one server/.env names if it is
  // ours, else any with our name. Applications that are not ours are never
  // returned, however they are named in server/.env.
  async function findOwnedApp(api, installId) {
    const cfg = config.get();
    if (cfg.twimlAppSid) {
      try {
        const app = await api.getApp(cfg.twimlAppSid);
        if (app.friendlyName === ownedName(installId)) return { app, from: 'env' };
      } catch (err) {
        if (!(err instanceof TwilioError && err.kind === 'not-found')) throw err;
      }
    }
    const apps = await api.listApps();
    const app = apps.find((a) => a.friendlyName === ownedName(installId));
    return app ? { app, from: 'search' } : { app: null };
  }

  async function ensureApp(creds, installId, pub, warnings) {
    const api = apiWith(creds);
    const want = desiredAppFields(installId, pub);
    const { app: found } = await findOwnedApp(api, installId);
    let app = found;
    let action;
    let detail;
    if (!app) {
      app = await api.createApp(want);
      action = 'created';
      detail = `Created the TwiML App ${app.sid}.`;
    } else {
      const diffs = appDifferences(app, want);
      if (diffs.length) {
        app = await api.updateApp(app.sid, want);
        action = 'updated';
        detail = `Updated ${diffs.map((d) => d.field).join(', ')} on the TwiML App ${app.sid}.`;
      } else {
        action = 'unchanged';
        detail = `The TwiML App ${app.sid} already points at this address.`;
      }
    }
    const state = readState();
    const history = new Set([...(state.appSidHistory || []), app.sid]);
    writeState({ appSid: app.sid, appSidHistory: [...history] });
    if (config.get().twimlAppSid !== app.sid) {
      writeEnv({ TWILIO_TWIML_APP_SID: app.sid }, warnings);
    }
    return { app, action, detail };
  }

  // --- review ---------------------------------------------------------

  // Everything Connect would change, from read-only requests. Foreign
  // routes carry the fingerprint the person's agreement must quote.
  async function review(input = {}) {
    requireAvailable();
    const creds = credentialsFor(input);
    const pub = requirePublicUrl(input);
    const identity = identityFor(input);
    const numberSid = String(input.numberSid || '');
    if (!/^PN[0-9a-fA-F]{32}$/.test(numberSid)) {
      throw new SetupError('Choose one of your existing numbers.', { kind: 'no-number' });
    }
    const cfg = config.get();
    const api = apiWith(creds);
    let number;
    let keyNow;
    let owned;
    let messaging;
    try {
      number = await api.getNumber(numberSid);
      keyNow = await keyState(creds);
      const installId = cfg.installId;
      owned = installId ? (await findOwnedApp(api, installId)).app : null;
      messaging = await api.messagingServiceFor(numberSid);
    } catch (err) {
      if (err instanceof TwilioError && err.kind === 'not-found') {
        return { ok: false, kind: 'number-gone', error: 'That number is no longer on this account. Check the account again.' };
      }
      if (err instanceof TwilioError) return failedCheck(err);
      throw err;
    }
    const state = readState();
    const ownedSids = new Set([owned && owned.sid].filter(Boolean));
    const staleSids = new Set((state.appSidHistory || []).filter((s) => !ownedSids.has(s)));
    const voice = describeRoute(number, 'voice', ownedSids, pub.url, staleSids);
    const sms = describeRoute(number, 'sms', ownedSids, pub.url, staleSids);
    const want = desiredAppFields(cfg.installId || '<new>', pub.url);
    const rows = [];

    rows.push({
      id: 'key',
      label: 'API key',
      action: keyNow === 'valid' ? 'unchanged' : cfg.apiKey ? 'replace' : 'create',
      detail:
        keyNow === 'valid'
          ? `Keep the API key ${cfg.apiKey} already in server/.env; it works.`
          : cfg.apiKey
            ? `The API key ${cfg.apiKey} in server/.env was rejected. Create a new Operator key; the old one is removed afterwards only if Operator made it.`
            : 'Create one API key named for Operator. Its secret is saved to server/.env and not shown.',
    });

    const appNote =
      cfg.twimlAppSid && (!owned || owned.sid !== cfg.twimlAppSid)
        ? ` The application ${cfg.twimlAppSid} in server/.env is not Operator's and is left alone.`
        : '';
    if (!owned) {
      rows.push({
        id: 'app',
        label: 'TwiML App',
        action: 'create',
        detail: `Create one TwiML App for Operator with voice, message and delivery addresses on ${pub.url}.${appNote}`,
        changes: [
          { field: 'Voice URL', from: 'not set', to: want.VoiceUrl },
          { field: 'Message URL', from: 'not set', to: want.SmsUrl },
          { field: 'Delivery callback', from: 'not set', to: want.SmsStatusCallback },
        ],
      });
    } else {
      const diffs = appDifferences(owned, desiredAppFields(cfg.installId, pub.url));
      rows.push({
        id: 'app',
        label: 'TwiML App',
        action: diffs.length ? 'update' : 'unchanged',
        detail: diffs.length
          ? `Update Operator's TwiML App ${owned.sid} to ${pub.url}.${appNote}`
          : `Operator's TwiML App ${owned.sid} already points at ${pub.url}.${appNote}`,
        changes: diffs,
      });
    }

    const routeRow = (id, label, route, capable, fieldLabel) => {
      const base = { id, label, current: route.description, fingerprint: route.fingerprint };
      if (!capable) {
        return { ...base, action: 'unavailable', detail: `${number.e164} cannot ${id === 'voice' ? 'take voice calls' : 'send or receive texts'}, so this is left alone.` };
      }
      if (route.state === 'operator') {
        return { ...base, action: 'unchanged', detail: `${fieldLabel} already goes to Operator.` };
      }
      if (route.state === 'blank' || route.state === 'stale') {
        return {
          ...base,
          action: 'update',
          detail:
            route.state === 'blank'
              ? `${fieldLabel} is not set. Set it to Operator.`
              : `${fieldLabel} points at an Operator application that no longer exists. Point it at the new one.`,
        };
      }
      return {
        ...base,
        action: 'replace',
        foreign: true,
        detail: `${fieldLabel} currently goes to ${route.description}, which is not Operator. Replacing it stops that destination from receiving ${id === 'voice' ? 'calls' : 'texts'} to ${number.e164}.`,
      };
    };
    rows.push(routeRow('voice', 'Incoming calls', voice, number.capabilities.voice, 'The number\'s voice route'));
    const smsRow = routeRow('sms', 'Incoming texts', sms, number.capabilities.sms, 'The number\'s text route');
    smsRow.notes = [];
    if (messaging.service) {
      smsRow.notes.push(
        `${number.e164} belongs to the Messaging Service "${messaging.service.friendlyName || messaging.service.sid}". A Messaging Service's own incoming-message setting takes precedence over the number's, and Operator never edits Messaging Services. Remove the number from the service in the Twilio console for texts to reach this app.`
      );
    } else if (messaging.unknown) {
      smsRow.notes.push(
        'Operator could not check whether this number is in a Messaging Service. If it is, that service\'s own setting overrides the number\'s, and Operator does not edit Messaging Services.'
      );
    } else {
      smsRow.notes.push(
        'If you later add this number to a Messaging Service, that service\'s own setting overrides the number\'s; Operator does not edit Messaging Services.'
      );
    }
    rows.push(smsRow);

    rows.push({
      id: 'callback',
      label: 'Delivery callback',
      action: 'info',
      detail: `Delivery updates for texts you send go to ${pub.url}${STATUS_PATH}.`,
    });
    rows.push({
      id: 'identity',
      label: 'Identity',
      action: cfg.identity === identity ? 'unchanged' : 'update',
      detail: `This app registers as "${identity}" and incoming calls ring the same identity${cfg.identity && cfg.identity !== identity ? ` (now "${cfg.identity}")` : ''}.`,
    });
    const keepsSmsFrom = cfg.smsFrom && cfg.smsFrom !== number.e164;
    rows.push({
      id: 'sender',
      label: 'Number',
      action: cfg.callerId === number.e164 ? 'unchanged' : 'update',
      detail:
        `Calls and texts use ${number.e164}.` +
        (keepsSmsFrom ? ` Texts keep sending from ${cfg.smsFrom}, set separately in server/.env, which Operator leaves as it is.` : '') +
        (number.capabilities.mms ? ' This number can send photos (MMS).' : ' This number cannot send photos (MMS).'),
    });
    rows.push({
      id: 'settings',
      label: 'Saved to server/.env',
      action: 'info',
      detail: `Account SID, Auth Token (not shown), ${pub.source === 'environment' ? 'public address supplied by this session (not saved)' : 'public address'}, number and identity. Other settings stay as they are.`,
    });
    return {
      ok: true,
      number: { sid: number.sid, e164: number.e164, capabilities: number.capabilities },
      publicBaseUrl: pub.url,
      rows,
    };
  }

  // --- connect --------------------------------------------------------

  // Applies the reviewed changes, stopping at the first step that fails.
  // Every step is safe to run again, so Retry is the same call.
  async function connect(input = {}) {
    requireAvailable();
    if (busy) throw new SetupError('Another setup is already running.', { status: 409, kind: 'busy' });
    busy = true;
    try {
      return await runConnect(input);
    } finally {
      busy = false;
    }
  }

  async function runConnect(input) {
    const creds = credentialsFor(input);
    const pub = requirePublicUrl(input);
    const identity = identityFor(input);
    const numberSid = String(input.numberSid || '');
    if (!/^PN[0-9a-fA-F]{32}$/.test(numberSid)) {
      throw new SetupError('Choose one of your existing numbers.', { kind: 'no-number' });
    }
    const agreed = input.replace && typeof input.replace === 'object' ? input.replace : {};
    const installId = installIdFor();
    const warnings = [];
    const steps = [
      { id: 'key', label: 'API key', status: 'pending' },
      { id: 'app', label: 'TwiML App', status: 'pending' },
      { id: 'voice', label: 'Incoming calls', status: 'pending' },
      { id: 'sms', label: 'Incoming texts', status: 'pending' },
      { id: 'settings', label: 'Save to server/.env', status: 'pending' },
    ];
    const step = (id) => steps.find((s) => s.id === id);
    const done = (id, status, detail) => Object.assign(step(id), { status, detail });
    const fail = (id, err) => {
      const message = err instanceof TwilioError ? failedCheck(err).error : err.message;
      Object.assign(step(id), { status: 'failed', detail: message });
      return { ok: false, failedStep: id, error: message, steps, warnings };
    };

    const api = apiWith(creds);
    let number;
    try {
      number = await api.getNumber(numberSid);
    } catch (err) {
      return fail('key', err);
    }

    // The install id names everything created below, so it is saved before
    // anything is: a Retry after any failure must find the same names.
    if (!config.get().installId) {
      try {
        writeEnv({ OPERATOR_INSTALL_ID: installId }, warnings);
      } catch (err) {
        return fail('key', new SetupError(`server/.env could not be written (${err.message}).`, { status: 500, kind: 'save-failed' }));
      }
    }

    try {
      const k = await ensureKey(creds, installId, warnings);
      done('key', k.action === 'unchanged' ? 'unchanged' : 'done', k.detail);
    } catch (err) {
      return fail('key', err);
    }

    let app;
    try {
      const a = await ensureApp(creds, installId, pub.url, warnings);
      app = a.app;
      done('app', a.action === 'unchanged' ? 'unchanged' : 'done', a.detail);
    } catch (err) {
      return fail('app', err);
    }

    const ownedSids = new Set([app.sid]);
    const staleSids = new Set((readState().appSidHistory || []).filter((s) => s !== app.sid));
    const routes = {};
    for (const [id, capable, field, noun] of [
      ['voice', number.capabilities.voice, 'VoiceApplicationSid', 'calls'],
      ['sms', number.capabilities.sms, 'SmsApplicationSid', 'texts'],
    ]) {
      try {
        // Read again: the route may have changed since it was reviewed.
        const fresh = await api.getNumber(numberSid);
        const route = describeRoute(fresh, id, ownedSids, pub.url, staleSids);
        if (!capable) {
          routes[id] = { state: 'unavailable', description: 'not available on this number' };
          done(id, 'skipped', `${number.e164} cannot ${id === 'voice' ? 'take voice calls' : 'send or receive texts'}.`);
        } else if (route.state === 'operator') {
          routes[id] = { state: 'operator', description: 'Operator' };
          done(id, 'unchanged', `Incoming ${noun} already go to Operator.`);
        } else if (route.state === 'blank' || route.state === 'stale' || agreed[id] === route.fingerprint) {
          await api.updateNumber(numberSid, { [field]: app.sid });
          routes[id] = { state: 'operator', description: 'Operator' };
          done(
            id,
            'done',
            route.state === 'blank' || route.state === 'stale'
              ? `Set incoming ${noun} to Operator.`
              : `Replaced ${route.description} with Operator for incoming ${noun}, as you agreed.`
          );
        } else {
          routes[id] = { state: 'foreign', description: route.description };
          const changed = agreed[id] && agreed[id] !== route.fingerprint;
          done(
            id,
            'skipped',
            changed
              ? `Left on ${route.description}: it changed since you reviewed it, so your agreement no longer applies. Review again.`
              : `Left on ${route.description}, as you chose. Incoming ${noun} will not reach this app.`
          );
        }
      } catch (err) {
        return fail(id, err);
      }
    }

    try {
      const updates = {
        TWILIO_ACCOUNT_SID: creds.accountSid,
        TWILIO_AUTH_TOKEN: creds.authToken,
        OPERATOR_INSTALL_ID: installId,
        TWILIO_CALLER_ID: number.e164,
        OPERATOR_IDENTITY: identity,
      };
      if (pub.source === 'input') updates.PUBLIC_BASE_URL = pub.url;
      writeEnv(updates, warnings);
      writeState({
        number: { sid: number.sid, e164: number.e164, capabilities: number.capabilities },
        connection: {
          checkedAt: now(),
          account: { state: 'ok', detail: null },
          voice: routes.voice,
          sms: routes.sms,
          callback: { state: 'ready', url: pub.url + STATUS_PATH },
        },
      });
      done('settings', 'done', 'Saved the account, number and identity to server/.env.');
    } catch (err) {
      return fail('settings', err);
    }
    return { ok: true, steps, warnings, status: status() };
  }

  // --- repair on launch -----------------------------------------------

  // Checks only what Operator owns, and puts it right: a deleted or
  // rejected API key is replaced, a deleted application is recreated, an
  // application whose addresses no longer match this session's tunnel is
  // updated, and a route that still pointed at a deleted Operator
  // application is pointed at the new one. A route to anything else, or
  // one that was cleared, is only reported. Does nothing until the person
  // has connected through setup, and never writes to the account then.
  async function repair() {
    if (!available()) return { ok: true, result: 'unavailable' };
    const state = readState();
    const cfg = config.get();
    if (!state.number || !state.appSid || !cfg.installId || !SID_RE.test(cfg.accountSid || '') || !cfg.authToken) {
      return { ok: true, result: 'not-set-up' };
    }
    if (busy) return { ok: true, result: 'busy' };
    busy = true;
    try {
      return await runRepair(state);
    } finally {
      busy = false;
    }
  }

  async function runRepair(state) {
    const cfg = config.get();
    const creds = { accountSid: cfg.accountSid, authToken: cfg.authToken };
    const api = apiWith(creds);
    const warnings = [];
    const changes = [];
    const connection = { ...(state.connection || {}) };
    try {
      const k = await ensureKey(creds, cfg.installId, warnings);
      if (k.action !== 'unchanged') changes.push(k.detail);
      const pub = config.get().publicBaseUrl;
      let app;
      if (pub) {
        const a = await ensureApp(creds, cfg.installId, pub, warnings);
        app = a.app;
        if (a.action !== 'unchanged') changes.push(a.detail);
        connection.callback = { state: 'ready', url: pub + STATUS_PATH };
      } else {
        const found = await findOwnedApp(api, cfg.installId);
        app = found.app;
        connection.callback = { state: 'no-public-address', url: null };
      }
      let number = null;
      try {
        number = await api.getNumber(state.number.sid);
      } catch (err) {
        if (!(err instanceof TwilioError && err.kind === 'not-found')) throw err;
        warnings.push(`${state.number.e164} is no longer on this account; choose a number in Settings → Twilio account.`);
      }
      if (number) {
        const current = new Set(app ? [app.sid] : []);
        const stale = new Set((readState().appSidHistory || []).filter((x) => !current.has(x)));
        for (const [id, field] of [
          ['voice', 'VoiceApplicationSid'],
          ['sms', 'SmsApplicationSid'],
        ]) {
          const route = describeRoute(number, id, current, pub, stale);
          if (route.state === 'stale' && app && state.number.capabilities[id]) {
            await api.updateNumber(number.sid, { [field]: app.sid });
            connection[id] = { state: 'operator', description: 'Operator' };
            changes.push(`Pointed incoming ${id === 'voice' ? 'calls' : 'texts'} at the new Operator application.`);
          } else {
            connection[id] = { state: route.state, description: route.description };
          }
        }
        connection.capabilities = number.capabilities;
        writeState({ number: { ...state.number, capabilities: number.capabilities } });
      }
      connection.checkedAt = now();
      connection.account = { state: 'ok', detail: null };
      writeState({ connection });
      return { ok: true, result: 'ok', changes, warnings };
    } catch (err) {
      const kind = err instanceof TwilioError || err instanceof SetupError ? err.kind : 'error';
      const result = kind === 'invalid-credentials' ? 'invalid-credentials' : kind === 'unreachable' ? 'unreachable' : 'error';
      connection.checkedAt = now();
      connection.account = {
        state: result,
        detail:
          result === 'unreachable'
            ? 'Twilio could not be reached; nothing was changed.'
            : result === 'invalid-credentials'
              ? 'Twilio did not accept the saved Account SID and Auth Token.'
              : err.message,
      };
      writeState({ connection });
      return { ok: false, result, error: connection.account.detail, changes, warnings };
    }
  }

  // --- status ---------------------------------------------------------

  // What the renderer may know: presence, never a secret's value.
  function status() {
    const cfg = config.get();
    const state = readState();
    const connection = state.connection || {};
    const mms = state.number
      ? state.number.capabilities.mms
        ? 'yes'
        : 'no'
      : 'unknown';
    return {
      available: available(),
      credentials: Boolean(cfg.accountSid && cfg.apiKey && cfg.apiSecret && cfg.twimlAppSid),
      accountSid: cfg.accountSid || null,
      hasAuthToken: Boolean(cfg.authToken),
      hasApiKey: Boolean(cfg.apiKey && cfg.apiSecret),
      apiKeySid: cfg.apiKey || null,
      twimlAppSid: cfg.twimlAppSid || null,
      number: cfg.callerId || null,
      smsFrom: cfg.smsFrom || null,
      identity: cfg.identity || null,
      publicBaseUrl: cfg.publicBaseUrl,
      publicBaseUrlSource: cfg.publicBaseUrlSource,
      connected: Boolean(state.number),
      connection: {
        checkedAt: connection.checkedAt || null,
        account: connection.account || { state: 'unchecked', detail: null },
        voice: connection.voice || null,
        sms: connection.sms || null,
        callback:
          connection.callback ||
          (cfg.publicBaseUrl
            ? { state: 'ready', url: (cfg.statusCallbackUrl || cfg.publicBaseUrl + STATUS_PATH) }
            : { state: 'no-public-address', url: null }),
        mms,
      },
    };
  }

  return { status, check, review, connect, repair, available, SetupError };
}

module.exports = { createSetup, SetupError, normalizePublicUrl, ownedName, MARKER };
