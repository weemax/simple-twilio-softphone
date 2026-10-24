// Accepted TWP-9 piece 4: photo messages through the actual Electron preload, IPC,
// brokers, private service, media store and workspace file, against a fictional
// Twilio (tools/fake-twilio). No real provider, public tunnel or Keychain: the
// Twilio SDK's send is stubbed by desktop.cjs and records what it was handed.
//
// With the renderer fixture running (see README.md):
//   node tools/workspace-ui/desktop-photos-journey.cjs
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict'),
  crypto = require('crypto'),
  fs = require('fs'),
  http = require('http'),
  path = require('path');
const { startFakeTwilio } = require('../fake-twilio');
const { JPEG, PNG, GIF } = require('../../src/photoFixtures');

const evidence = process.env.OPERATOR_EVIDENCE_DIR,
  root = process.env.OPERATOR_TEST_ROOT;
if (!evidence || !root || path.resolve(root).startsWith(path.resolve(__dirname, '../..') + path.sep))
  throw new Error('Use evidence and OPERATOR_TEST_ROOT outside the project.');
fs.mkdirSync(evidence, { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, 'desktop-photos-')),
  home = path.join(scratch, 'home'),
  profile = path.join(home, 'profile');
fs.mkdirSync(home, { recursive: true });

const ACCOUNT = 'AC00000000000000000000000000000000';
const AUTH_TOKEN = 'fixture-token'; // desktop.cjs's fictional Auth Token
const PUBLIC = 'https://fixture.invalid'; // desktop.cjs's fictional public address
let runningApp, fake;

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

const jsonl = (file) =>
  fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const sentRequests = () => jsonl(path.join(profile, 'sent-requests.jsonl'));
const mediaFiles = () => {
  const dir = path.join(profile, 'sms-media');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.bin')) : [];
};
const serverPort = () => Number(fs.readFileSync(path.join(profile, 'server-port'), 'utf8'));

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

function postWebhook(port, p, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], PUBLIC + p);
  const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(Buffer.from(data)).digest('base64');
  const body = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: p,
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  fake = await startFakeTwilio({ accountSid: ACCOUNT, authToken: AUTH_TOKEN });
  fake.state.keys.push({ sid: 'SK00000000000000000000000000000000', secret: 'fixture-secret', friendly_name: 'fixture' });
  fake.addNumber({ phone_number: '+12025550100', capabilities: { voice: true, sms: true, mms: true, fax: false } });

  const results = [];
  const check = async (name, fn) => {
    await fn();
    results.push(name);
    console.log(`${results.length}. ${name}`);
  };
  console.log('Launching isolated Electron.');
  let app = await launch();
  let page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForFunction(() => window.__fixture?.device?.state === 'registered');
  const button = (name) => page.getByRole('button', { name, exact: true });
  const draft = () => page.getByRole('textbox', { name: /Message draft/ });
  const thread = (n) => page.locator('.sms-list-item').filter({ hasText: n });
  const chips = () => page.locator('.photo-chip');
  const attachInput = () => page.locator('input[type="file"]');
  const shot = async (name) => {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: path.join(evidence, `${name}.png`) });
  };
  const savedWorkspace = () => page.evaluate(() => window.operator.config.get('workspace'));
  const NUMBER = '+12025550102';
  const photoFiles = [
    { name: 'beach.jpg', mimeType: 'image/jpeg', buffer: JPEG },
    { name: 'logo.png', mimeType: 'image/png', buffer: PNG },
  ];

  await check('Attaching shows previews and uploads nothing: no link, no message to Twilio', async () => {
    await thread('0102').click();
    await draft().fill('Which of these looks right?');
    await attachInput().setInputFiles(photoFiles);
    await chips().nth(1).waitFor();
    assert.equal(await chips().count(), 2);
    await page.locator('.photo-chip img').first().waitFor();
    assert.match(await page.locator('.sms-composer-counter').innerText(), /MMS \(a picture message, not SMS segments\) · 2 photos/);
    assert.equal(await page.locator('.photo-notice').count(), 0);
    assert.deepEqual(sentRequests(), []);
    assert.equal(mediaFiles().length, 2);
    // The sending number's photo capability was looked up read-only at the fictional Twilio, nothing else.
    assert.ok(fake.requests.every((r) => r.method === 'GET'));
    await shot('photos-composer');
  });

  await check('The attachment draft and its text survive an abrupt restart, previews included', async () => {
    await page.waitForFunction(
      async (n) => ((await window.operator.config.get('workspace')).attachments?.[n] || []).length === 2,
      NUMBER
    );
    const saved = await savedWorkspace();
    assert.deepEqual(saved.attachments[NUMBER].map((p) => p.name), ['beach.jpg', 'logo.png']);
    // The workspace file holds descriptions, never the picture bytes.
    assert.ok(!JSON.stringify(saved).includes(JPEG.toString('base64').slice(0, 40)));
    await stop(app);
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => window.__fixture?.device?.state === 'registered');
    await thread('0102').click();
    await chips().nth(1).waitFor();
    assert.equal(await draft().inputValue(), 'Which of these looks right?');
    await page.locator('.photo-chip img').nth(1).waitFor();
    assert.equal(mediaFiles().length, 2);
    await shot('photos-after-restart');
  });

  await check('Removing one photo deletes only that file', async () => {
    await page.getByRole('button', { name: /^Remove photo 2/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('.photo-chip').length === 1);
    await page.waitForFunction(
      async (n) => ((await window.operator.config.get('workspace')).attachments?.[n] || []).length === 1,
      NUMBER
    );
    const deadline = Date.now() + 10000;
    while (mediaFiles().length !== 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(mediaFiles().length, 1);
  });

  await check('Send makes the message an MMS with one 24-hour link for the selected photo only', async () => {
    await attachInput().setInputFiles([photoFiles[1]]);
    await chips().nth(1).waitFor();
    const caption = 'Which of these looks right?';
    await button('Send').click();
    await page.locator('.sms-bubble.outbound .sms-photo img').nth(1).waitFor();
    const [sent] = sentRequests();
    assert.equal(sent.to, NUMBER);
    assert.equal(sent.body, caption);
    assert.equal(sent.mediaUrl.length, 2);
    for (const url of sent.mediaUrl) assert.match(url, new RegExp(`^${PUBLIC}/media/[A-Za-z0-9_-]{43}$`));
    assert.equal(await chips().count(), 0);
    assert.equal(await draft().inputValue(), '');
    // Twilio would fetch each link from the public address; here, the same path on the local service.
    const port = serverPort();
    const [first, second] = await Promise.all(sent.mediaUrl.map((u) => get(port, new URL(u).pathname)));
    assert.equal(first.status, 200);
    assert.equal(first.headers['content-type'], 'image/jpeg');
    assert.ok(first.bytes.equals(JPEG));
    assert.ok(second.bytes.equals(PNG));
    assert.equal((await get(port, '/media/')).status, 404);
    assert.equal((await get(port, '/media/not-a-token')).status, 404);
    assert.equal((await get(port, '/sms/conversations')).status, 401); // private routes still need the app's key
    assert.match(await page.locator('.sms-bubble.outbound .sms-mms').first().innerText(), /MMS/);
    await shot('photos-sent');
  });

  await check('Incoming photos download from the approved Twilio address only; others show placeholders', async () => {
    const jpeg = fake.addMedia({ bytes: JPEG, type: 'image/jpeg', cdn: true });
    const gif = fake.addMedia({ bytes: GIF, type: 'image/gif' });
    const evilPath = `/2010-04-01/Accounts/AC${'9'.repeat(32)}/Messages/MM${'a'.repeat(32)}/Media/ME${'b'.repeat(32)}`;
    const status = await postWebhook(serverPort(), '/sms/inbound', {
      MessageSid: 'MM00000000000000000000000000000077',
      SmsSid: 'MM00000000000000000000000000000077',
      SmsStatus: 'received',
      Body: 'Here is the picture you asked for',
      From: NUMBER,
      To: '+12025550100',
      AccountSid: ACCOUNT,
      NumMedia: '3',
      MediaUrl0: jpeg.url,
      MediaContentType0: 'image/jpeg',
      MediaUrl1: gif.url,
      MediaContentType1: 'image/gif',
      MediaUrl2: `${fake.base}${evilPath}`,
      MediaContentType2: 'image/jpeg',
    });
    assert.equal(status, 200);
    await page.locator('.sms-bubble-body', { hasText: 'Here is the picture you asked for' }).waitFor();
    await page.getByText(/A GIF attachment arrived, but Operator shows only JPEG and PNG photos/).waitFor();
    await page.getByText(/came from an address Operator does not download from/).waitFor();
    const bubble = page.locator('.sms-bubble.inbound').filter({ hasText: 'Here is the picture' });
    await bubble.locator('.sms-photo img').waitFor();
    assert.equal(fake.requests.some((r) => r.path === new URL(gif.url).pathname), false);
    assert.equal(fake.requests.some((r) => r.path === evilPath), false);
    // The key went to the first address only, not on to the CDN.
    const hops = fake.requests.filter((r) => r.path === new URL(jpeg.url).pathname || r.path === new URL(jpeg.cdnUrl).pathname);
    assert.deepEqual(hops.map((h) => h.hasAuthHeader), [true, false]);
    await shot('photos-incoming');
  });

  await check('A photo opens in a larger local view with Previous/Next', async () => {
    await page.locator('.sms-photo').first().click();
    const viewer = page.locator('dialog.photo-viewer');
    await viewer.waitFor();
    assert.match(await viewer.innerText(), /Photo 1 of 2/);
    await viewer.locator('img').waitFor();
    await shot('photos-viewer');
    await viewer.getByRole('button', { name: 'Next' }).click();
    assert.match(await viewer.innerText(), /Photo 2 of 2/);
    await viewer.getByRole('button', { name: 'Close' }).click();
    assert.equal(await page.locator('dialog.photo-viewer').count(), 0);
  });

  await check('A destination outside the United States and Canada gets a notice before Send', async () => {
    await button('+ New').click();
    await page.getByLabel('New conversation phone number').fill('+1 876 555 0123');
    await button('OK').click();
    await page.locator('.photo-notice').waitFor();
    assert.match(await page.locator('.photo-notice').innerText(), /United States and Canada/);
    assert.equal(await page.locator('.attach-photos').isDisabled(), true);
    await shot('photos-unsupported');
    await draft().fill('Text still works there');
    await button('Send').click();
    await page.locator('.sms-bubble-body', { hasText: 'Text still works there' }).waitFor();
    assert.equal(sentRequests().at(-1).mediaUrl, undefined);
  });

  await check('A confirmed failure keeps the text and photo, and closes the failed message’s link', async () => {
    await thread('0102').click();
    await attachInput().setInputFiles([photoFiles[0]]);
    await chips().first().waitFor();
    await draft().fill('[fail] one more picture');
    await button('Send').click();
    await page.locator('.sms-composer-error').waitFor();
    assert.equal(await chips().count(), 1);
    assert.equal(await draft().inputValue(), '[fail] one more picture');
    const failed = sentRequests().at(-1);
    assert.equal((await get(serverPort(), new URL(failed.mediaUrl[0]).pathname)).status, 404);
    await button('Review resend').last().waitFor();
    await shot('photos-failed');
  });

  await check('An unknown result keeps the text, blocks sending it again and leaves the photo with its message', async () => {
    await draft().fill('[unknown] one more picture');
    await button('Send').click();
    await page.getByText(/Unknown outcome: “\[unknown\] one more picture” with photo/).waitFor();
    assert.equal(await chips().count(), 0);
    const stored = JSON.parse(fs.readFileSync(path.join(profile, 'sms-store.json'), 'utf8'))[NUMBER].messages;
    assert.deepEqual(stored.slice(-2).map((m) => m.status), ['failed', 'unknown']);
    assert.ok(stored.at(-1).media.length === 1 && stored.at(-1).mms === true);
    // The unknown message's link stays open: Twilio may still be fetching it.
    const unknown = sentRequests().at(-1);
    assert.equal((await get(serverPort(), new URL(unknown.mediaUrl[0]).pathname)).status, 200);
  });

  await check('Clearing the thread removes its photos from this computer and closes their links', async () => {
    const port = serverPort();
    const before = sentRequests().filter((r) => r.to === NUMBER && r.mediaUrl).at(0);
    await button('Clear messages in this thread').click();
    await button('Clear').click();
    await page.getByText(/No messages yet/).waitFor();
    const deadline = Date.now() + 10000;
    while (mediaFiles().length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(mediaFiles().length, 0);
    assert.equal((await get(port, new URL(before.mediaUrl[0]).pathname)).status, 404);
  });

  const mode = fs.statSync(path.join(profile, 'sms-media')).mode & 0o777;
  assert.equal(mode, 0o700);
  const runtime = await app.evaluate(() => process.versions.electron);
  fs.writeFileSync(
    path.join(evidence, 'desktop-photos-journey.json'),
    JSON.stringify(
      {
        desktop: `Electron ${runtime} with actual preload, IPC, brokers, private service and media store`,
        checks: results,
        realProviderOperations: 0,
        publicTunnels: 0,
        keychainOperations: 0,
        twilioRequestsFromThisTest: [...new Set(fake.requests.map((r) => `${r.method} ${r.path.replace(/[A-Z]{2}[0-9a-f]{32}/g, '<sid>')}`))],
      },
      null,
      2
    )
  );
  await stop(app);
  await fake.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log('Actual isolated Electron photo journey passed.');
})().catch(async (e) => {
  console.error(e);
  if (runningApp) await stop(runningApp);
  if (fake) await fake.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exitCode = 1;
});
