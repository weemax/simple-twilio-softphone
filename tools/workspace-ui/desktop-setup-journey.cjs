// Accepted TWP-9 piece 2: the actual Electron preload -> IPC -> setup broker -> private
// service -> server/.env path, against tools/fake-twilio (a fictional Twilio on 127.0.0.1).
// Nothing reaches Twilio, no real credential or keychain exists, and the profile is disposable.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict'),
  fs = require('fs'),
  path = require('path');
const { startFakeTwilio } = require('../fake-twilio');
const evidence = process.env.OPERATOR_EVIDENCE_DIR,
  root = process.env.OPERATOR_TEST_ROOT;
if (
  !evidence ||
  !root ||
  path.resolve(root).startsWith(path.resolve(__dirname, '../..') + path.sep)
)
  throw new Error('Use evidence and OPERATOR_TEST_ROOT outside the project.');
fs.mkdirSync(evidence, { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, 'desktop-setup-')),
  home = path.join(scratch, 'home'),
  profile = path.join(home, 'profile'),
  envFile = path.join(profile, 'server.env');
fs.mkdirSync(home, { recursive: true });
const PUBLIC = 'https://fictional-softphone.ngrok-free.app';
let runningApp, fake, currentPage;
const launch = () =>
  electron
    .launch({
      timeout: 20000,
      executablePath: process.env.ELECTRON_EXECUTABLE || require('electron'),
      args: ['--password-store=basic', path.join(__dirname, 'desktop.cjs')],
      env: {
        ...process.env,
        HOME: home,
        FM3000_LOCAL_CODESIGN_DIR: path.join(home, 'signing'),
        OPERATOR_FIXTURE_URL: process.env.OPERATOR_FIXTURE_URL || 'http://127.0.0.1:8089',
        OPERATOR_TEST_PROFILE: profile,
        OPERATOR_DESKTOP_SETUP: 'fresh',
        OPERATOR_TWILIO_API_BASE: fake.base,
      },
    })
    .then((app) => {
      runningApp = app;
      return app;
    });
async function stop(app) {
  const exited = new Promise((resolve) => app.process().once('exit', resolve));
  app.process().kill('SIGKILL');
  await exited;
  if (runningApp === app) runningApp = null;
}
const until = async (what, probe, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
};
const operatorKeys = () => fake.state.keys.filter((k) => k.friendly_name.startsWith('Operator softphone'));
const operatorApps = () => fake.state.apps.filter((a) => a.friendly_name.startsWith('Operator softphone'));
(async () => {
  fake = await startFakeTwilio();
  const line = fake.addNumber({ phone_number: '+12025550100' });
  const office = fake.addNumber({ phone_number: '+12025550177', voice_url: 'https://elsewhere.example/voice' });
  const spare = fake.addNumber({ phone_number: '+12025550188', sms_url: 'https://keep.example/sms' });
  const stranger = fake.addApp({ friendly_name: 'Someone else', voice_url: 'https://other.example/x' });
  const results = [];
  const check = (name) => results.push(name);

  let app = await launch();
  let page = await app.firstWindow();
  currentPage = page;
  page.setDefaultTimeout(20000);
  page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log('[page]', m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const nav = (name) =>
    page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button').filter({ hasText: new RegExp('^' + name) });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const step = () => page.locator('.setup-steps [aria-current="step"]');

  // 1. An unconnected first launch opens Settings -> Twilio account by itself.
  await page.getByRole('heading', { name: 'Twilio account' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.setup-steps [aria-current="step"]')?.textContent === 'Account');
  assert.equal(await nav('Settings').getAttribute('aria-current'), 'page');
  await page.screenshot({ path: path.join(evidence, 'setup-1-account.png') });
  check('Unconnected first launch opened Settings → Twilio account on the Account step');
  // The bridge has no way to read a stored secret.
  assert.equal(await page.evaluate(() => 'secrets' in window.operator), false);
  const refused = await page.evaluate(() => window.operator.invoke('secrets:get', 'twilioAuthToken').then(() => 'allowed', (e) => e.message));
  assert.match(refused, /not allowed/);
  check('Renderer has no secrets bridge: secrets:get is refused');

  // 2. Wrong sign-in is its own message and changes nothing.
  await page.getByLabel('Account SID').fill(fake.accountSid);
  await page.getByLabel('Auth Token').fill('not-the-token');
  await page.getByLabel('Public address').fill(PUBLIC);
  await button('Check account').click();
  await page.getByRole('alert').getByText('Sign-in not accepted').waitFor();
  assert.deepEqual(fake.writes(), []);
  await page.screenshot({ path: path.join(evidence, 'setup-2-wrong-signin.png') });
  check('Wrong Auth Token reported as "Sign-in not accepted"; nothing written');

  // 3. Right sign-in: one read-only request, numbers with capabilities and routes.
  fake.clearRequests();
  await page.getByLabel('Auth Token').fill(fake.authToken);
  await button('Check account').click();
  await step().filter({ hasText: 'Number' }).waitFor();
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].method, 'GET');
  const numbersText = await page.locator('.number-list').innerText();
  assert.match(numbersText, /\+1 202 555 0177/);
  assert.match(numbersText, /Calls go to https:\/\/elsewhere\.example\/voice/);
  assert.match(numbersText, /Calls · Texts · Photos/);
  await page.screenshot({ path: path.join(evidence, 'setup-3-numbers.png') });
  check('Check account made exactly one GET and listed numbers with capabilities and current routes');
  assert.equal(await page.getByText(/buy/i).filter({ hasText: /^Buy/ }).count(), 0);

  // 4. Review: nothing written yet, Replace unchecked for the foreign voice route.
  await page.getByRole('radio').nth(1).check();
  fake.clearRequests();
  await button('Review changes').click();
  await step().filter({ hasText: 'Review' }).waitFor();
  assert.deepEqual(fake.writes(), []);
  const replace = page.getByLabel(/Replace where calls go now/);
  assert.equal(await replace.isChecked(), false);
  assert.equal(await page.locator('.replace-choice').count(), 1);
  await page.screenshot({ path: path.join(evidence, 'setup-4-review.png'), fullPage: true });
  check('Review listed every change from reads only; the foreign voice route has an unchecked Replace control');

  // 5. Connect without replacing: voice stays, everything else is set up.
  await button('Connect').click();
  await page.getByText('Connected.', { exact: false }).first().waitFor();
  await step().filter({ hasText: 'Connected' }).waitFor();
  assert.equal(operatorKeys().length, 1);
  assert.equal(operatorApps().length, 1);
  const owned = operatorApps()[0];
  assert.equal(office.voice_url, 'https://elsewhere.example/voice');
  assert.equal(office.voice_application_sid, '');
  assert.equal(office.sms_application_sid, owned.sid);
  assert.equal(line.voice_application_sid, '');
  assert.equal(spare.sms_url, 'https://keep.example/sms');
  assert.equal(stranger.voice_url, 'https://other.example/x');
  assert.deepEqual(owned, { ...owned, voice_url: `${PUBLIC}/twiml`, sms_url: `${PUBLIC}/sms/inbound`, sms_status_callback: `${PUBLIC}/sms/status` });
  await page.screenshot({ path: path.join(evidence, 'setup-5-connected.png'), fullPage: true });
  const resultText = await page.locator('.result-steps').innerText();
  assert.match(resultText, /Incoming calls\s*Left unchanged/);
  assert.match(resultText, /Left on https:\/\/elsewhere\.example\/voice, as you chose/);
  check('Connect created one key and one app, set the blank text route, and left the declined voice route and every other number/app alone');

  // 6. Secrets: owner-only file, nothing returned to the page, calls work with no restart.
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  const env = fs.readFileSync(envFile, 'utf8');
  assert.match(env, new RegExp(`TWILIO_AUTH_TOKEN=${fake.authToken}`));
  assert.match(env, new RegExp(`TWILIO_API_SECRET=${operatorKeys()[0].secret}`));
  const body = await page.evaluate(() => document.body.innerHTML + JSON.stringify(Object.keys(window.operator)));
  assert.equal(body.includes(fake.authToken), false);
  assert.equal(body.includes(operatorKeys()[0].secret), false);
  const status = await page.evaluate(() => window.operator.setup.status());
  assert.equal(JSON.stringify(status).includes(fake.authToken), false);
  assert.equal(JSON.stringify(status).includes(operatorKeys()[0].secret), false);
  await page.waitForFunction(() => window.__fixture?.device?.state === 'registered');
  check('server/.env is owner-only; neither the Auth Token nor the API secret reached the page; the voice device registered without a restart');

  // 7. Connect again: nothing changes, no duplicates.
  await button('Change number').click();
  await page.getByLabel('Auth Token').waitFor();
  assert.equal(await page.getByLabel('Auth Token').inputValue(), '');
  await button('Check account').click();
  await step().filter({ hasText: 'Number' }).waitFor();
  assert.equal(await page.getByRole('radio').nth(1).isChecked(), true); // the saved number is preselected
  await page.getByRole('radio').nth(1).check();
  await button('Review changes').click();
  await step().filter({ hasText: 'Review' }).waitFor();
  fake.clearRequests();
  await button('Connect').click();
  await step().filter({ hasText: 'Connected' }).waitFor();
  await page.locator('.result-steps').waitFor();
  assert.deepEqual(fake.writes(), []);
  assert.equal(operatorKeys().length, 1);
  assert.equal(operatorApps().length, 1);
  check('Connecting twice wrote nothing to Twilio and created no second key or app');

  // 8. Agreeing to replace the foreign voice route replaces only that.
  await button('Change number').click();
  await button('Check account').click();
  await step().filter({ hasText: 'Number' }).waitFor();
  await page.getByRole('radio').nth(1).check();
  await button('Review changes').click();
  await step().filter({ hasText: 'Review' }).waitFor();
  await page.getByLabel(/Replace where calls go now/).check();
  await button('Connect').click();
  await step().filter({ hasText: 'Connected' }).waitFor();
  await page.locator('.result-steps').getByText('as you agreed').waitFor();
  assert.equal(office.voice_application_sid, owned.sid);
  assert.equal(spare.sms_url, 'https://keep.example/sms');
  check('A checked Replace control replaced exactly that route');

  // 9. Restart: the launch repairs what Operator owns (the app was deleted in the console).
  await stop(app);
  fake.state.apps.splice(fake.state.apps.indexOf(owned), 1);
  fake.clearRequests();
  app = await launch();
  page = await app.firstWindow();
  await until('Operator application to be recreated', () => operatorApps().length === 1);
  const fresh = operatorApps()[0];
  assert.notEqual(fresh.sid, owned.sid);
  await until('routes to follow it', () => office.voice_application_sid === fresh.sid && office.sms_application_sid === fresh.sid);
  assert.equal(spare.sms_url, 'https://keep.example/sms');
  assert.equal(operatorKeys().length, 1);
  await page.waitForFunction(() => window.__fixture?.device?.state === 'registered');
  await nav('Settings').click();
  await button('Connection').click();
  await page.getByText(/^Connected \(AC/).waitFor();
  await page.screenshot({ path: path.join(evidence, 'setup-6-connection.png'), fullPage: true });
  check('A restart recreated the deleted Operator application and pointed the chosen number at it; the app opened straight on the saved section');

  // 10. Twilio unreachable at launch: nothing changes and the Connection view says so.
  await stop(app);
  fake.setUnreachable(true);
  fake.clearRequests();
  app = await launch();
  page = await app.firstWindow();
  await nav('Settings').click();
  await button('Connection').click();
  await page.getByText(/Twilio could not be reached at the last check; nothing was changed/).waitFor();
  await page.getByText(/Operator could not verify this Voice URL on the last check/).waitFor();
  const failedStatus = await page.evaluate(() => window.operator.setup.status());
  assert.equal(failedStatus.connection.voiceUrlVerified, false);
  assert.equal(failedStatus.connection.voiceUrl, `${PUBLIC}/twiml`);
  assert.deepEqual(fake.writes(), []);
  await page.screenshot({ path: path.join(evidence, 'setup-7-unreachable.png'), fullPage: true });
  check('With Twilio unreachable the launch changed nothing and Connection showed the last observed Voice URL as unverified');
  fake.setUnreachable(false);
  fake.clearRequests();
  await button('Twilio account').click();
  await button('Check connection now').click();
  await page.getByText('Everything Operator owns is in place. Nothing needed repair.').waitFor();
  const retriedStatus = await page.evaluate(() => window.operator.setup.status());
  assert.equal(retriedStatus.connection.voiceUrlVerified, true);
  assert.equal(retriedStatus.connection.voiceUrl, `${PUBLIC}/twiml`);
  assert.deepEqual(fake.writes(), []);
  await button('Connection').click();
  await page.getByText(`${PUBLIC}/twiml. No tunnel address this session to compare it with.`).waitFor();
  await page.screenshot({ path: path.join(evidence, 'setup-8-retried-connection.png'), fullPage: true });
  check('Check connection now retried after the outage, verified the same owned app, and restored current status without writes');

  fs.writeFileSync(
    path.join(evidence, 'desktop-setup-journey.json'),
    JSON.stringify(
      {
        desktop: `Electron ${await app.evaluate(() => process.versions.electron)} with actual preload, IPC, broker, private service and server/.env`,
        checks: results,
        realProviderOperations: 0,
        keychainOperations: 0,
      },
      null,
      2,
    ),
  );
  await stop(app);
  await fake.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log('Actual isolated Electron setup journey passed.');
})().catch(async (e) => {
  console.error(e);
  if (currentPage) await currentPage.screenshot({ path: path.join(evidence, 'setup-failure.png') }).catch(() => {});
  if (runningApp) await stop(runningApp);
  if (fake) await fake.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exitCode = 1;
});
