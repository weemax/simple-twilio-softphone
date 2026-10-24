/**
 * @jest-environment node
 */
// TWP-9 piece 2 (accepted "Connect Twilio in the app"): check the account
// with one read-only request, review every change, then create or reuse one
// Operator-owned API key and TwiML App and change only the chosen number,
// asking separately before each foreign route is replaced; connecting twice
// creates no duplicates; a failed step is named and Retry resumes; each
// launch repairs only what Operator owns; server/.env stays the single,
// owner-only credential store and no answer carries a secret.
//
// Everything runs against tools/fake-twilio, a fictional account on
// 127.0.0.1: no real provider, number, credential or tunnel is involved.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakeTwilio } = require('../tools/fake-twilio');
const { createConfig } = require('../server/config');
const { createSetup, ownedName } = require('../server/setup');
const { readEnvFile } = require('../server/envFile');

const PUBLIC = 'https://fictional-softphone.ngrok-free.app';
const NEXT_PUBLIC = 'https://second-address.ngrok-free.app';
const IDENTITY = 'operator-fictional';

let fake;
const dirs = [];
beforeEach(async () => {
  fake = await startFakeTwilio();
});
afterEach(async () => {
  await fake.close();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

// A setup service over a fresh server/.env (envText) and the fake account.
function makeSetup({ envText = '', launchEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-setup-'));
  dirs.push(dir);
  const envFile = path.join(dir, '.env');
  if (envText !== null) fs.writeFileSync(envFile, envText, { mode: 0o600 });
  const statePath = path.join(dir, '.operator-setup.json');
  const config = createConfig({ launchEnv, envFile });
  const setup = createSetup({
    config,
    statePath,
    env: { OPERATOR_TWILIO_API_BASE: fake.base },
    retryDelayMs: 1,
  });
  const reopen = (extraLaunchEnv = launchEnv) =>
    createSetup({
      config: createConfig({ launchEnv: extraLaunchEnv, envFile }),
      statePath,
      env: { OPERATOR_TWILIO_API_BASE: fake.base },
      retryDelayMs: 1,
    });
  return { setup, config, envFile, statePath, dir, reopen, env: () => readEnvFile(envFile).values };
}

const account = () => ({ accountSid: fake.accountSid, authToken: fake.authToken });
const connectInput = (numberSid, extra = {}) => ({
  ...account(),
  numberSid,
  publicBaseUrl: PUBLIC,
  identity: IDENTITY,
  ...extra,
});
const operatorKeys = () => fake.state.keys.filter((k) => k.friendly_name.startsWith('Operator softphone'));
const operatorApps = () => fake.state.apps.filter((a) => a.friendly_name.startsWith('Operator softphone'));
const paths = (requests) => requests.map((r) => `${r.method} ${r.path.replace(/AC[0-9a-f]{32}/, 'AC…')}`);

describe('Check account', () => {
  test('makes one read-only request and lists each number with its capabilities and current routes', async () => {
    const own = fake.addNumber({ phone_number: '+15555550101', voice_url: 'https://elsewhere.example/voice', sms_application_sid: 'AP' + 'a'.repeat(32) });
    fake.addNumber({ phone_number: '+15555550102', capabilities: { voice: true, sms: false, mms: false } });
    const { setup } = makeSetup();
    const result = await setup.check(account());
    expect(result.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].method).toBe('GET');
    expect(result.numbers.map((n) => [n.e164, n.capabilities.sms])).toEqual([
      ['+15555550101', true],
      ['+15555550102', false],
    ]);
    const first = result.numbers.find((n) => n.sid === own.sid);
    expect(first.voice).toMatchObject({ state: 'foreign', description: 'https://elsewhere.example/voice' });
    expect(first.sms).toMatchObject({ state: 'foreign', description: `application AP${'a'.repeat(32)}` });
    expect(result.numbers[1].voice.state).toBe('blank');
  });

  test('tells a wrong sign-in apart from an unreachable Twilio, and changes nothing either way', async () => {
    fake.addNumber();
    const { setup } = makeSetup();
    const wrong = await setup.check({ ...account(), authToken: 'not-the-token' });
    expect(wrong).toMatchObject({ ok: false, kind: 'invalid-credentials' });
    expect(wrong.error).toMatch(/did not accept/);

    fake.setUnreachable(true);
    const down = await setup.check(account());
    expect(down).toMatchObject({ ok: false, kind: 'unreachable' });
    expect(down.error).toMatch(/Could not reach Twilio/);
    expect(fake.writes()).toEqual([]);
  });

  test('reuses the Account SID and Auth Token already in server/.env without retyping them', async () => {
    fake.addNumber();
    const { setup } = makeSetup({
      envText: `TWILIO_ACCOUNT_SID=${fake.accountSid}\nTWILIO_AUTH_TOKEN=${fake.authToken}\n`,
    });
    expect(setup.status()).toMatchObject({ accountSid: fake.accountSid, hasAuthToken: true });
    const result = await setup.check({});
    expect(result.ok).toBe(true);
  });

  test('asks for what is missing in plain words before contacting Twilio', async () => {
    const { setup } = makeSetup();
    await expect(setup.check({ accountSid: 'nope', authToken: 'x' })).rejects.toThrow(/Account SID/);
    await expect(setup.check({ accountSid: fake.accountSid })).rejects.toThrow(/Auth Token/);
    expect(fake.requests).toEqual([]);
  });

  test('never returns the Auth Token or an API secret, in any answer', async () => {
    const number = fake.addNumber();
    const { setup } = makeSetup();
    const answers = [
      await setup.check(account()),
      await setup.review(connectInput(number.sid)),
      await setup.connect(connectInput(number.sid)),
      setup.status(),
    ];
    const text = JSON.stringify(answers);
    expect(text).not.toContain(fake.authToken);
    for (const k of fake.state.keys) expect(text).not.toContain(k.secret);
  });
});

describe('Review', () => {
  test('lists each change from reads only, and offers Replace only for a route that goes elsewhere', async () => {
    const number = fake.addNumber({ voice_url: 'https://elsewhere.example/voice' });
    const { setup } = makeSetup();
    fake.clearRequests();
    const review = await setup.review(connectInput(number.sid));
    expect(review.ok).toBe(true);
    expect(fake.writes()).toEqual([]);
    const row = Object.fromEntries(review.rows.map((r) => [r.id, r]));
    expect(row.key.action).toBe('create');
    expect(row.app.action).toBe('create');
    expect(row.app.changes.map((c) => c.to)).toEqual([`${PUBLIC}/twiml`, `${PUBLIC}/sms/inbound`, `${PUBLIC}/sms/status`]);
    expect(row.voice).toMatchObject({ action: 'replace', foreign: true, current: 'https://elsewhere.example/voice' });
    expect(row.voice.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(row.voice.detail).toContain('https://elsewhere.example/voice');
    expect(row.sms).toMatchObject({ action: 'update' });
    expect(row.sms.foreign).toBeUndefined();
    expect(row.identity.detail).toContain(IDENTITY);
  });

  test('treats a route that already reaches this address as Operator’s own', async () => {
    const number = fake.addNumber({ voice_url: `${PUBLIC}/twiml`, sms_url: `${PUBLIC}/sms/inbound` });
    const { setup } = makeSetup();
    const review = await setup.review(connectInput(number.sid));
    const row = Object.fromEntries(review.rows.map((r) => [r.id, r]));
    expect(row.voice.action).toBe('unchanged');
    expect(row.sms.action).toBe('unchanged');
  });

  test('explains that a Messaging Service overrides the number’s text route and is never edited', async () => {
    const number = fake.addNumber();
    fake.addService('Fictional campaign', [number.sid]);
    const { setup } = makeSetup();
    const review = await setup.review(connectInput(number.sid));
    const sms = review.rows.find((r) => r.id === 'sms');
    expect(sms.notes.join(' ')).toMatch(/Messaging Service "Fictional campaign"/);
    expect(sms.notes.join(' ')).toMatch(/never edits Messaging Services/);
    expect(fake.writes()).toEqual([]);
  });

  test('requires a public address, an identity and an existing number', async () => {
    const number = fake.addNumber();
    const { setup } = makeSetup();
    await expect(setup.review({ ...connectInput(number.sid), publicBaseUrl: '' })).rejects.toThrow(/public address/);
    await expect(setup.review({ ...connectInput(number.sid), publicBaseUrl: 'http://example.com' })).rejects.toThrow(/https address/);
    await expect(setup.review({ ...connectInput(number.sid), identity: 'two words' })).rejects.toThrow(/identity/);
    await expect(setup.review({ ...connectInput('nope') })).rejects.toThrow(/existing numbers/);
    const gone = await setup.review(connectInput('PN' + 'f'.repeat(32)));
    expect(gone).toMatchObject({ ok: false, kind: 'number-gone' });
  });
});

describe('Connect', () => {
  test('creates one key and one TwiML App, sets blank routes on the chosen number only, and saves server/.env owner-only', async () => {
    const chosen = fake.addNumber({ phone_number: '+15555550101' });
    const other = fake.addNumber({ phone_number: '+15555550102', voice_url: 'https://keep.example/voice' });
    const { setup, env, envFile } = makeSetup({
      envText: '# my notes\nPORT=5050\nTWILIO_SMS_FROM=+15555550199\n',
    });
    fs.chmodSync(envFile, 0o644);
    const result = await setup.connect(connectInput(chosen.sid));
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => [s.id, s.status])).toEqual([
      ['key', 'done'],
      ['app', 'done'],
      ['voice', 'done'],
      ['sms', 'done'],
      ['settings', 'done'],
    ]);

    expect(operatorKeys()).toHaveLength(1);
    expect(operatorApps()).toHaveLength(1);
    const app = operatorApps()[0];
    expect(app).toMatchObject({ voice_url: `${PUBLIC}/twiml`, sms_url: `${PUBLIC}/sms/inbound`, sms_status_callback: `${PUBLIC}/sms/status` });
    expect(chosen).toMatchObject({ voice_application_sid: app.sid, sms_application_sid: app.sid });
    expect(other).toMatchObject({ voice_url: 'https://keep.example/voice', voice_application_sid: '', sms_application_sid: '' });

    expect(env()).toMatchObject({
      TWILIO_ACCOUNT_SID: fake.accountSid,
      TWILIO_AUTH_TOKEN: fake.authToken,
      TWILIO_API_KEY: operatorKeys()[0].sid,
      TWILIO_API_SECRET: operatorKeys()[0].secret,
      TWILIO_TWIML_APP_SID: app.sid,
      TWILIO_CALLER_ID: '+15555550101',
      OPERATOR_IDENTITY: IDENTITY,
      PUBLIC_BASE_URL: PUBLIC,
      PORT: '5050',
      TWILIO_SMS_FROM: '+15555550199', // an existing separate sender is preserved
    });
    expect(env().OPERATOR_INSTALL_ID).toMatch(/^[0-9a-f]{8}$/);
    expect(operatorKeys()[0].friendly_name).toBe(ownedName(env().OPERATOR_INSTALL_ID));
    expect(fs.readFileSync(envFile, 'utf8')).toContain('# my notes');
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    expect(result.warnings.join(' ')).toMatch(/owner-only/);
  });

  test('never buys or creates a number, and touches nothing but its own key, app and the chosen number', async () => {
    const chosen = fake.addNumber();
    const stranger = fake.addApp({ friendly_name: 'Someone else', voice_url: 'https://other.example/x' });
    const strangerKey = fake.addKey('Someone else');
    const { setup } = makeSetup();
    fake.clearRequests();
    await setup.connect(connectInput(chosen.sid));
    const written = paths(fake.writes());
    expect(written.filter((w) => /IncomingPhoneNumbers\.json/.test(w))).toEqual([]);
    expect(written.some((w) => /AvailablePhoneNumbers/.test(w))).toBe(false);
    expect(written.every((w) => /Keys\.json|Applications\.json|Applications\/AP|IncomingPhoneNumbers\/PN/.test(w))).toBe(true);
    expect(written.filter((w) => /IncomingPhoneNumbers\/PN/.test(w))).toHaveLength(2); // voice and sms only
    expect(fake.state.apps.find((a) => a.sid === stranger.sid)).toMatchObject({ voice_url: 'https://other.example/x' });
    expect(fake.state.keys.map((k) => k.sid)).toContain(strangerKey.sid);
  });

  test('connecting twice changes nothing the second time and creates no duplicates', async () => {
    const chosen = fake.addNumber();
    const { setup } = makeSetup();
    await setup.connect(connectInput(chosen.sid));
    fake.clearRequests();
    const again = await setup.connect(connectInput(chosen.sid));
    expect(again.ok).toBe(true);
    expect(again.steps.map((s) => s.status)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged', 'done']);
    expect(fake.writes()).toEqual([]);
    expect(operatorKeys()).toHaveLength(1);
    expect(operatorApps()).toHaveLength(1);
    const review = await setup.review(connectInput(chosen.sid));
    expect(review.rows.filter((r) => ['key', 'app', 'voice', 'sms'].includes(r.id)).map((r) => r.action)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
  });

  test('reuses a working API key already in server/.env instead of creating another', async () => {
    const chosen = fake.addNumber();
    const key = fake.addKey('My own key');
    const { setup, env } = makeSetup({
      envText: `TWILIO_ACCOUNT_SID=${fake.accountSid}\nTWILIO_AUTH_TOKEN=${fake.authToken}\nTWILIO_API_KEY=${key.sid}\nTWILIO_API_SECRET=${key.secret}\n`,
    });
    const result = await setup.connect(connectInput(chosen.sid));
    expect(result.steps[0]).toMatchObject({ id: 'key', status: 'unchanged' });
    expect(fake.state.keys).toHaveLength(1);
    expect(env().TWILIO_API_KEY).toBe(key.sid);
  });

  test('leaves a route that goes elsewhere alone unless that exact destination was agreed to, one route at a time', async () => {
    const chosen = fake.addNumber({ voice_url: 'https://elsewhere.example/voice', sms_application_sid: 'AP' + 'b'.repeat(32) });
    const { setup } = makeSetup();
    const review = await setup.review(connectInput(chosen.sid));
    const voice = review.rows.find((r) => r.id === 'voice');
    const sms = review.rows.find((r) => r.id === 'sms');

    const declined = await setup.connect(connectInput(chosen.sid));
    expect(declined.ok).toBe(true);
    expect(declined.steps.find((s) => s.id === 'voice')).toMatchObject({ status: 'skipped' });
    expect(declined.steps.find((s) => s.id === 'voice').detail).toContain('https://elsewhere.example/voice');
    expect(declined.steps.find((s) => s.id === 'sms').status).toBe('skipped');
    expect(chosen).toMatchObject({ voice_url: 'https://elsewhere.example/voice', sms_application_sid: 'AP' + 'b'.repeat(32) });

    // Agreeing to the voice route says nothing about texts.
    const voiceOnly = await setup.connect(connectInput(chosen.sid, { replace: { voice: voice.fingerprint } }));
    expect(voiceOnly.steps.find((s) => s.id === 'voice')).toMatchObject({ status: 'done' });
    expect(voiceOnly.steps.find((s) => s.id === 'voice').detail).toContain('as you agreed');
    expect(voiceOnly.steps.find((s) => s.id === 'sms').status).toBe('skipped');
    expect(chosen.voice_application_sid).toBe(operatorApps()[0].sid);
    expect(chosen.sms_application_sid).toBe('AP' + 'b'.repeat(32));

    const both = await setup.connect(connectInput(chosen.sid, { replace: { sms: sms.fingerprint } }));
    expect(both.steps.find((s) => s.id === 'sms').status).toBe('done');
  });

  test('an agreement does not carry over when the route changed after it was reviewed', async () => {
    const chosen = fake.addNumber({ voice_url: 'https://elsewhere.example/voice' });
    const { setup } = makeSetup();
    const review = await setup.review(connectInput(chosen.sid));
    const agreed = review.rows.find((r) => r.id === 'voice').fingerprint;
    chosen.voice_url = 'https://a-different-place.example/voice';
    const result = await setup.connect(connectInput(chosen.sid, { replace: { voice: agreed } }));
    const voice = result.steps.find((s) => s.id === 'voice');
    expect(voice.status).toBe('skipped');
    expect(voice.detail).toMatch(/changed since you reviewed it/);
    expect(chosen.voice_url).toBe('https://a-different-place.example/voice');
  });

  test('names the step that failed and Retry resumes without creating a second key or app', async () => {
    const chosen = fake.addNumber();
    const { setup, env } = makeSetup();
    fake.failNext('POST', /Applications\.json$/, { status: 500 });
    const failed = await setup.connect(connectInput(chosen.sid));
    expect(failed).toMatchObject({ ok: false, failedStep: 'app' });
    expect(failed.steps.map((s) => s.status)).toEqual(['done', 'failed', 'pending', 'pending', 'pending']);
    expect(failed.error).toMatch(/Could not reach Twilio|answered HTTP 500|Injected failure/);
    // The key was saved the moment it was created, so nothing is lost.
    expect(env().TWILIO_API_KEY).toBe(operatorKeys()[0].sid);

    const retried = await setup.connect(connectInput(chosen.sid));
    expect(retried.ok).toBe(true);
    expect(retried.steps[0].status).toBe('unchanged');
    expect(operatorKeys()).toHaveLength(1);
    expect(operatorApps()).toHaveLength(1);
  });

  test('a Retry after a later step failed finds the same names, even when the key was reused and nothing else was saved', async () => {
    const chosen = fake.addNumber();
    const key = fake.addKey('My own key');
    const { setup, env } = makeSetup({
      envText: `TWILIO_ACCOUNT_SID=${fake.accountSid}\nTWILIO_AUTH_TOKEN=${fake.authToken}\nTWILIO_API_KEY=${key.sid}\nTWILIO_API_SECRET=${key.secret}\n`,
    });
    fake.failNext('POST', /IncomingPhoneNumbers\/PN[0-9a-f]+\.json$/, { status: 500 });
    const failed = await setup.connect(connectInput(chosen.sid));
    expect(failed).toMatchObject({ ok: false, failedStep: 'voice' });
    expect(operatorApps()).toHaveLength(1);
    const retried = await setup.connect(connectInput(chosen.sid));
    expect(retried.ok).toBe(true);
    expect(operatorApps()).toHaveLength(1);
    expect(operatorApps()[0].friendly_name).toBe(ownedName(env().OPERATOR_INSTALL_ID));
  });

  test('a new key that cannot be saved is removed again so no unusable key is left behind', async () => {
    const chosen = fake.addNumber();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-setup-'));
    dirs.push(dir);
    const config = createConfig({ launchEnv: { OPERATOR_INSTALL_ID: '0123abcd' }, envFile: path.join(dir, 'folder', '.env') });
    // The folder server/.env lives in turns into a plain file, so nothing can be written there.
    fs.writeFileSync(path.join(dir, 'folder'), '');
    const unwritable = createSetup({
      config,
      statePath: path.join(dir, 'state.json'),
      env: { OPERATOR_TWILIO_API_BASE: fake.base },
      retryDelayMs: 1,
    });
    const result = await unwritable.connect(connectInput(chosen.sid));
    expect(result).toMatchObject({ ok: false, failedStep: 'key' });
    expect(result.error).toMatch(/could not be saved to server\/\.env/);
    expect(fake.state.keys).toEqual([]);
  });

  test('replaces a rejected API key, removing the old Operator one only after the new one works', async () => {
    const chosen = fake.addNumber();
    const { setup, env } = makeSetup();
    await setup.connect(connectInput(chosen.sid));
    const oldKey = operatorKeys()[0];
    // The secret in server/.env stops working (it was rotated elsewhere).
    oldKey.secret = 'rotated-elsewhere';
    const again = await setup.connect(connectInput(chosen.sid));
    expect(again.steps[0]).toMatchObject({ id: 'key', status: 'done' });
    expect(again.steps[0].detail).toMatch(/Removed 1 old Operator key/);
    expect(operatorKeys()).toHaveLength(1);
    expect(operatorKeys()[0].sid).not.toBe(oldKey.sid);
    expect(env().TWILIO_API_KEY).toBe(operatorKeys()[0].sid);
  });

  test('does not delete a rejected key it did not create', async () => {
    const chosen = fake.addNumber();
    const foreign = fake.addKey('Made by hand');
    const { setup, env } = makeSetup({
      envText: `TWILIO_ACCOUNT_SID=${fake.accountSid}\nTWILIO_AUTH_TOKEN=${fake.authToken}\nTWILIO_API_KEY=${foreign.sid}\nTWILIO_API_SECRET=wrong\n`,
    });
    const result = await setup.connect(connectInput(chosen.sid));
    expect(result.ok).toBe(true);
    expect(fake.state.keys.map((k) => k.sid)).toContain(foreign.sid);
    expect(env().TWILIO_API_KEY).not.toBe(foreign.sid);
  });

  test('leaves an existing application named in server/.env alone and uses its own', async () => {
    const chosen = fake.addNumber();
    const theirs = fake.addApp({ friendly_name: 'Hand-made', voice_url: 'https://old.example/twiml' });
    const { setup, env } = makeSetup({ envText: `TWILIO_TWIML_APP_SID=${theirs.sid}\n` });
    const review = await setup.review(connectInput(chosen.sid));
    expect(review.rows.find((r) => r.id === 'app').detail).toContain(`${theirs.sid} in server/.env is not Operator's and is left alone`);
    await setup.connect(connectInput(chosen.sid));
    expect(theirs.voice_url).toBe('https://old.example/twiml');
    expect(env().TWILIO_TWIML_APP_SID).toBe(operatorApps()[0].sid);
  });

  test('does not save a tunnel address the session supplied, and says when the environment overrides a saved value', async () => {
    const chosen = fake.addNumber();
    const { setup, env } = makeSetup({ launchEnv: { PUBLIC_BASE_URL: NEXT_PUBLIC, OPERATOR_IDENTITY: 'from-environment' } });
    const result = await setup.connect({ ...connectInput(chosen.sid), publicBaseUrl: '' });
    expect(result.ok).toBe(true);
    expect(operatorApps()[0].voice_url).toBe(`${NEXT_PUBLIC}/twiml`);
    expect(env().PUBLIC_BASE_URL).toBeUndefined();
    expect(result.warnings.join(' ')).toMatch(/OPERATOR_IDENTITY is also set in the environment/);
  });

  test('refuses a second Connect while one is running', async () => {
    const chosen = fake.addNumber();
    const { setup } = makeSetup();
    const first = setup.connect(connectInput(chosen.sid));
    await expect(setup.connect(connectInput(chosen.sid))).rejects.toThrow(/already running/);
    expect((await first).ok).toBe(true);
  });
});

describe('repair on launch', () => {
  async function connected(extra = {}) {
    const chosen = fake.addNumber(extra.number || {});
    const made = makeSetup(extra.setup || {});
    const result = await made.setup.connect(connectInput(chosen.sid));
    expect(result.ok).toBe(true);
    return { ...made, chosen };
  }

  test('does nothing, and asks Twilio nothing, until the person has connected through setup', async () => {
    fake.addNumber();
    const { setup } = makeSetup({
      envText: `TWILIO_ACCOUNT_SID=${fake.accountSid}\nTWILIO_AUTH_TOKEN=${fake.authToken}\nTWILIO_API_KEY=SK${'0'.repeat(32)}\nTWILIO_API_SECRET=x\n`,
    });
    expect(await setup.repair()).toMatchObject({ ok: true, result: 'not-set-up' });
    expect(fake.requests).toEqual([]);
  });

  test('a changed tunnel address updates only Operator’s own application', async () => {
    const { reopen, chosen } = await connected();
    const other = fake.addNumber({ phone_number: '+15555550102', voice_url: 'https://keep.example/voice' });
    const stranger = fake.addApp({ friendly_name: 'Someone else', voice_url: 'https://other.example/x' });
    fake.clearRequests();
    const result = await reopen({ PUBLIC_BASE_URL: NEXT_PUBLIC }).repair();
    expect(result).toMatchObject({ ok: true, result: 'ok' });
    expect(result.changes.join(' ')).toMatch(/Voice URL, Message URL, Delivery callback/);
    expect(paths(fake.writes())).toEqual([expect.stringMatching(/^POST .*\/Applications\/AP[0-9a-f]+\.json$/)]);
    expect(operatorApps()[0]).toMatchObject({ voice_url: `${NEXT_PUBLIC}/twiml`, sms_url: `${NEXT_PUBLIC}/sms/inbound`, sms_status_callback: `${NEXT_PUBLIC}/sms/status` });
    expect(other.voice_url).toBe('https://keep.example/voice');
    expect(stranger.voice_url).toBe('https://other.example/x');
    expect(chosen.voice_application_sid).toBe(operatorApps()[0].sid);
  });

  test('a deleted application is recreated and the number’s routes follow it', async () => {
    const { reopen, chosen, env } = await connected();
    const dead = operatorApps()[0].sid;
    fake.state.apps.length = 0;
    const result = await reopen().repair();
    expect(result).toMatchObject({ ok: true, result: 'ok' });
    const fresh = operatorApps()[0];
    expect(fresh.sid).not.toBe(dead);
    expect(chosen).toMatchObject({ voice_application_sid: fresh.sid, sms_application_sid: fresh.sid });
    expect(env().TWILIO_TWIML_APP_SID).toBe(fresh.sid);
    expect(result.changes.join(' ')).toMatch(/Pointed incoming calls/);
  });

  test('a deleted or rejected API key is replaced, and the old Operator key is removed only afterwards', async () => {
    const { reopen, env } = await connected();
    const old = operatorKeys()[0];
    fake.state.keys.length = 0; // deleted in the console
    const result = await reopen().repair();
    expect(result).toMatchObject({ ok: true, result: 'ok' });
    expect(operatorKeys()).toHaveLength(1);
    expect(operatorKeys()[0].sid).not.toBe(old.sid);
    expect(env().TWILIO_API_KEY).toBe(operatorKeys()[0].sid);
  });

  test('never changes a route that goes elsewhere, or one that was cleared, only reports it', async () => {
    const { reopen, chosen } = await connected();
    chosen.voice_application_sid = '';
    chosen.voice_url = 'https://moved-away.example/voice';
    chosen.sms_application_sid = '';
    fake.clearRequests();
    const result = await reopen().repair();
    expect(result.ok).toBe(true);
    expect(fake.writes()).toEqual([]);
    const status = reopen().status();
    expect(status.connection.voice).toMatchObject({ state: 'foreign', description: 'https://moved-away.example/voice' });
    expect(status.connection.sms.state).toBe('blank');
  });

  test('an unreachable Twilio changes nothing and is recorded as unreachable', async () => {
    const { reopen } = await connected();
    fake.clearRequests();
    fake.setUnreachable(true);
    const again = reopen({ PUBLIC_BASE_URL: NEXT_PUBLIC });
    const result = await again.repair();
    expect(result).toMatchObject({ ok: false, result: 'unreachable' });
    expect(fake.writes()).toEqual([]);
    expect(again.status().connection.account.state).toBe('unreachable');
  });

  test('rejected credentials are recorded as such, not as an unreachable Twilio', async () => {
    const { reopen, envFile } = await connected();
    const text = fs.readFileSync(envFile, 'utf8').replace(fake.authToken, 'a-token-twilio-no-longer-accepts');
    fs.writeFileSync(envFile, text);
    const again = reopen();
    const result = await again.repair();
    expect(result).toMatchObject({ ok: false, result: 'invalid-credentials' });
    expect(again.status().connection.account).toMatchObject({ state: 'invalid-credentials' });
  });
});

describe('Connection facts', () => {
  test('status reports presence of secrets, the connected number, routes, callback and photo capability, never a value', async () => {
    const chosen = fake.addNumber({ phone_number: '+15555550101', capabilities: { voice: true, sms: true, mms: false } });
    const { setup } = makeSetup();
    await setup.connect(connectInput(chosen.sid));
    const status = setup.status();
    expect(status).toMatchObject({
      available: true,
      credentials: true,
      connected: true,
      hasAuthToken: true,
      hasApiKey: true,
      number: '+15555550101',
      identity: IDENTITY,
      publicBaseUrl: PUBLIC,
    });
    expect(status.connection).toMatchObject({
      account: { state: 'ok' },
      voice: { state: 'operator' },
      sms: { state: 'operator' },
      callback: { state: 'ready', url: `${PUBLIC}/sms/status` },
      mms: 'no',
    });
    expect(Object.keys(status)).not.toEqual(expect.arrayContaining(['authToken', 'apiSecret']));
  });
});
