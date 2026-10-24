// Accepted TWP-9 piece 3: actual Electron preload -> IPC -> brokers -> private server,
// plus actual atomic workspace-file persistence. A fake SDK/REST boundary prevents traffic.
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict'),
  fs = require('fs'),
  path = require('path');
const evidence = process.env.OPERATOR_EVIDENCE_DIR,
  root = process.env.OPERATOR_TEST_ROOT;
if (
  !evidence ||
  !root ||
  path.resolve(root).startsWith(path.resolve(__dirname, '../..') + path.sep)
)
  throw new Error('Use evidence and OPERATOR_TEST_ROOT outside the project.');
const scratch = fs.mkdtempSync(path.join(root, 'desktop-')),
  home = path.join(scratch, 'home'),
  profile = path.join(home, 'profile');
fs.mkdirSync(home, { recursive: true });
let runningApp;
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
        OPERATOR_FIXTURE_URL:
          process.env.OPERATOR_FIXTURE_URL || 'http://127.0.0.1:8089',
        OPERATOR_TEST_PROFILE: profile,
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
(async () => {
  console.log('Launching isolated Electron.');
  let app = await launch();
  console.log('Electron launched.');
  let page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForFunction(
    () => window.__fixture?.device?.state === 'registered',
  );
  const nav = (name) =>
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('button')
      .filter({ hasText: new RegExp('^' + name) });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const draft = () => page.getByRole('textbox', { name: /Message draft/ });
  await nav('Contacts').click();
  await button('Add contact').click();
  await page.getByLabel('Name', { exact: true }).fill('Alex Rivera');
  await page.getByLabel('Phone number', { exact: true }).fill('+12025550101');
  await button('Save contact').click();
  await page
    .getByRole('article', { name: 'Alex Rivera' })
    .getByRole('button', { name: 'Text', exact: true })
    .click();
  await draft().fill('Meet at 2?');
  await page.locator('.sms-list-item').filter({ hasText: '0102' }).click();
  assert.equal(await draft().inputValue(), '');
  await draft().fill('Please confirm the address.');
  await nav('Calls').click();
  await nav('Messages').click();
  assert.equal(await draft().inputValue(), 'Please confirm the address.');
  // Await the real main-process write, not a timer, before quitting the desktop.
  await page.waitForFunction(
    async () =>
      (await window.operator.config.get('workspace')).drafts['+12025550102'] ===
      'Please confirm the address.',
  );
  // A queued contact is saved by the same real write, and survives the restart.
  await nav('Contacts').click();
  await page
    .getByRole('article', { name: 'Alex Rivera' })
    .getByRole('button', { name: 'Add Alex Rivera to queue' })
    .click();
  await page.waitForFunction(
    async () =>
      (await window.operator.config.get('workspace')).queue.items.length === 1,
  );
  await nav('Messages').click();
  await stop(app);
  app = await launch();
  page = await app.firstWindow();
  await page.waitForFunction(
    () => window.__fixture?.device?.state === 'registered',
  );
  assert.equal(await draft().inputValue(), 'Please confirm the address.');
  await page
    .locator('.sms-list-item')
    .filter({ hasText: 'Alex Rivera' })
    .click();
  assert.equal(await draft().inputValue(), 'Meet at 2?');
  await nav('Calls').click();
  await page.locator('.calls-page .subnav button').filter({ hasText: /^Queue/ }).click();
  await page.getByRole('button', { name: /^Call next: Alex Rivera/ }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__fixture.calls), [], 'Reopening never calls anyone.');
  await nav('Messages').click();
  await page.screenshot({ path: path.join(evidence, 'desktop-restart.png') });
  await page.evaluate(() =>
    window.operator.notifications.show({
      number: '+12025550102',
      body: 'Fictional notification click check.',
    }),
  );
  await app.evaluate(() => {
    global.__operatorFixtureNotificationClick();
  });
  await page
    .getByRole('textbox', { name: /Message draft for \+1 202 555 0102/ })
    .waitFor();
  assert.equal(await draft().inputValue(), 'Please confirm the address.');
  await page
    .locator('.sms-list-item')
    .filter({ hasText: 'Alex Rivera' })
    .click();

  await draft().fill('[fail] Please confirm tomorrow’s meeting.');
  await button('Send').click();
  await button('Review resend').waitFor();
  assert.equal(
    await draft().inputValue(),
    '[fail] Please confirm tomorrow’s meeting.',
  );
  await draft().fill('[unknown] Please confirm tomorrow’s meeting.');
  await button('Send').click();
  await page.getByText(/Unknown outcome: “/).waitFor();
  assert.equal(await button('Send').isDisabled(), true);
  const stored = JSON.parse(
    fs.readFileSync(path.join(profile, 'sms-store.json'), 'utf8'),
  )['+12025550101'].messages;
  assert.deepEqual(
    stored.slice(-2).map((m) => m.status),
    ['failed', 'unknown'],
  );
  await page.screenshot({
    path: path.join(evidence, 'desktop-send-outcomes.png'),
  });
  const runtime = await app.evaluate(() => process.versions.electron);
  const mode = fs.statSync(path.join(profile, 'config.json')).mode & 0o777;
  assert.equal(mode, 0o600);
  fs.writeFileSync(
    path.join(evidence, 'desktop-journey.json'),
    JSON.stringify(
      {
        desktop: `Electron ${runtime} with actual preload, IPC, brokers and private server`,
        checks: [
          'Contacts saved through real IPC',
          'Native-notification click handler opened its recipient through the real preload channel',
          'Two recipient drafts survived a complete process restart after IPC confirmed the write',
          'A queued contact survived the restart and nothing was dialed',
          'Failed and unknown results persisted by the real backend and surfaced by the real broker',
          'Unknown text has no enabled Send action',
          'Atomic config file is owner-only',
        ],
        persistedSendStatuses: stored.slice(-2).map((m) => m.status),
        realProviderOperations: 0,
        keychainOperations: 0,
      },
      null,
      2,
    ),
  );
  await stop(app);
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log('Actual isolated Electron journey passed.');
})().catch(async (e) => {
  console.error(e);
  if (runningApp) await stop(runningApp);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exitCode = 1;
});
