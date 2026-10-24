/**
 * @jest-environment node
 */
// Accepted TWP-9 piece 4 (docs/phone-ux-plan.md): photo messages for the United
// States and Canada. JPEG/PNG only, at most ten, text and photos under 5 MB,
// links that last 24 hours, nothing uploaded by merely attaching, downloads of
// incoming photos only from Twilio and bounded.
//
// The real service runs in this process behind a tunnel-shaped proxy (as in
// serverPrivateRoutes.test.js), the app's real brokers talk to it, and Twilio is
// a fictional server on 127.0.0.1 (tools/fake-twilio). Only the Twilio SDK's
// messages.create is replaced, so the test sees the exact parameters a real
// send would carry (the links in mediaUrl) without a provider call. Images are
// real JPEG/PNG/GIF/HEIC files (src/photoFixtures.js). Fictional data only.

const mockCreates = [];
let mockCreateBehavior = () => ({ sid: 'MM00000000000000000000000000000001', status: 'queued' });
jest.mock('../server/node_modules/twilio', () => {
  const real = jest.requireActual('../server/node_modules/twilio');
  const client = () => ({
    messages: {
      create: async (params) => {
        mockCreates.push(params);
        return mockCreateBehavior(params);
      },
    },
  });
  return Object.assign(client, real);
});

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { JPEG, PNG, GIF, HEIC } = require('./photoFixtures');
const { startFakeTwilio } = require('../tools/fake-twilio');

const PUBLIC_HOST = 'fictional-softphone.ngrok-free.app';
const PUBLIC_BASE_URL = `https://${PUBLIC_HOST}`;
const AUTH_TOKEN = 'fictional-auth-token-for-tests-0001';
const SENDER = '+15555550100';
const US_RECIPIENT = '+12025550123';
const CA_RECIPIENT = '+14165550123';
const OTHER_US_RECIPIENT = '+13125550123';
const JAMAICA = '+18765550123';
const PUERTO_RICO = '+17875550123';
const UK = '+442071234567';
const MiB = 1024 * 1024;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-photos-'));
const storePath = path.join(workDir, 'sms-store.json');
const mediaDir = path.join(workDir, 'sms-media');
const keyPath = path.join(workDir, 'local-api-key');

let fake;
let server;
let tunnel;
let port;
let tunnelPort;
let smsBroker;
let whenMediaIdle;
let nowOffset = 0;
const realNow = Date.now.bind(Date);
const previousEnv = {};

function setEnv(values) {
  for (const [k, v] of Object.entries(values)) {
    if (!(k in previousEnv)) previousEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function request(targetPort, { method = 'GET', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: targetPort, method, path: p, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks), body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// What ngrok does to a public request before it reaches the upstream.
function startTunnel(upstreamPort) {
  const proxy = http.createServer((req, res) => {
    const up = http.request(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        method: req.method,
        path: req.url,
        agent: false,
        headers: { ...req.headers, host: PUBLIC_HOST, 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https', 'x-forwarded-host': PUBLIC_HOST },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
      }
    );
    req.pipe(up);
  });
  return new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(proxy)));
}

function twilioSignature(url, params = {}) {
  const data = Object.keys(params).sort().reduce((acc, name) => acc + name + params[name], url);
  return crypto.createHmac('sha1', AUTH_TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');
}

function postWebhook(p, params) {
  return request(tunnelPort, {
    method: 'POST',
    path: p,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilioSignature(PUBLIC_BASE_URL + p, params) },
    body: new URLSearchParams(params).toString(),
  });
}

// A PNG whose picture data is `dataBytes` of unreadable filler: structurally a PNG
// of the requested size, for the size limits.
function bigPng(dataBytes) {
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(typed));
    return Buffer.concat([len, typed, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2000, 0);
  ihdr.writeUInt32BE(2000, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = Buffer.concat([Buffer.from([0x78, 0x9c]), crypto.randomBytes(dataBytes)]);
  return Buffer.concat([PNG.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const attach = async (bytes, name = 'photo') => (await smsBroker.attachPhoto({ name, bytes })).media;
const stored = () => JSON.parse(fs.readFileSync(storePath, 'utf8'));
const mediaPathOf = (url) => new URL(url).pathname;
const linkCount = () => Object.keys(JSON.parse(fs.readFileSync(path.join(mediaDir, 'media-index.json'), 'utf8')).links).length;
const filesOnDisk = () => fs.readdirSync(mediaDir).filter((n) => n.endsWith('.bin'));
const thread = async (number) => (await smsBroker.listConversations(number)).messages;
const tunnelGet = (p, method = 'GET') => request(tunnelPort, { method, path: p });

async function sendError(args) {
  try {
    await smsBroker.sendMessage(args);
  } catch (err) {
    return err;
  }
  throw new Error('the send should have been refused');
}

beforeAll(async () => {
  jest.spyOn(Date, 'now').mockImplementation(() => realNow() + nowOffset);
  fake = await startFakeTwilio();
  const key = fake.addKey('Operator softphone [test]');
  fake.addNumber({ phone_number: SENDER, capabilities: { voice: true, sms: true, mms: true, fax: false } });
  setEnv({
    TWILIO_ACCOUNT_SID: fake.accountSid,
    TWILIO_API_KEY: key.sid,
    TWILIO_API_SECRET: key.secret,
    TWILIO_TWIML_APP_SID: 'AP00000000000000000000000000000000',
    TWILIO_CALLER_ID: SENDER,
    OPERATOR_IDENTITY: 'operator',
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    PUBLIC_BASE_URL,
    SMS_PUBLIC_BASE_URL: undefined,
    SMS_STATUS_CALLBACK_URL: undefined,
    SMS_STORE_PATH: storePath,
    SMS_MEDIA_DIR: undefined,
    OPERATOR_LOCAL_API_KEY_FILE: keyPath,
    OPERATOR_TWILIO_API_BASE: fake.base,
    TOKEN_BACKEND_URL: undefined,
    SMS_BACKEND_URL: undefined,
  });
  const serverModule = require('../server/server');
  whenMediaIdle = serverModule.whenMediaIdle;
  server = await serverModule.startServer({ port: 0, host: '127.0.0.1' });
  port = server.address().port;
  tunnel = await startTunnel(port);
  tunnelPort = tunnel.address().port;
  setEnv({ SMS_BACKEND_URL: `http://127.0.0.1:${port}` });
  smsBroker = require('../main/services/smsBroker');
});

afterAll(async () => {
  jest.restoreAllMocks();
  for (const s of [tunnel, server]) {
    if (!s) continue;
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  if (fake) await fake.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(previousEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  // The test runner resets mock implementations before each test.
  Date.now.mockImplementation(() => realNow() + nowOffset);
  mockCreates.length = 0;
  mockCreateBehavior = () => ({ sid: 'MM00000000000000000000000000000001', status: 'queued' });
  nowOffset = 0;
  fake.clearRequests();
});

describe('what counts as a photo (attaching a draft)', () => {
  it('stores a real JPEG and a real PNG by their contents, whatever they are called', async () => {
    const jpeg = await attach(JPEG, 'holiday.png'); // the name is not trusted
    const png = await attach(PNG, 'scan.jpg');

    expect(jpeg).toMatchObject({ type: 'image/jpeg', bytes: JPEG.length, width: 48, height: 32 });
    expect(png).toMatchObject({ type: 'image/png', bytes: PNG.length, width: 48, height: 32 });
    const back = await smsBroker.readPhoto(jpeg.id);
    expect(back.type).toBe('image/jpeg');
    expect(Buffer.compare(back.bytes, JPEG)).toBe(0);
  });

  it('refuses GIF, HEIC, renamed text, damaged and truncated files, and stores nothing', async () => {
    const before = filesOnDisk().length;
    const damagedPng = Buffer.from(PNG);
    damagedPng[damagedPng.length - 20] ^= 0xff; // inside the picture data: the section's check value fails
    const cases = [
      ['photo.gif', GIF],
      ['photo.heic', HEIC],
      ['notes.jpg', Buffer.from('This is a text file that someone renamed to .jpg for no good reason.')],
      ['cut.png', PNG.subarray(0, PNG.length - 30)],
      ['cut.jpg', JPEG.subarray(0, JPEG.length - 40)],
      ['damaged.png', damagedPng],
      ['tail.png', Buffer.concat([PNG, Buffer.from('<script>alert(1)</script>')])],
    ];
    for (const [name, bytes] of cases) {
      const err = await attach(bytes, name).then(
        () => null,
        (e) => e
      );
      expect(err && err.message).toMatch(/SMS backend 415/);
    }
    expect(filesOnDisk().length).toBe(before);
  });

  it('refuses a file that is 5 MB or more and an empty file', async () => {
    await expect(attach(bigPng(5 * MiB), 'huge.png')).rejects.toThrow(/SMS backend 413/);
    await expect(smsBroker.attachPhoto({ name: 'x', bytes: Buffer.alloc(0) })).rejects.toThrow(/empty/);
  });

  it('refuses a picture that claims impossible dimensions', async () => {
    const claimsHuge = Buffer.from(PNG);
    // IHDR width/height live at bytes 16..23; the damaged check value is also refused, so rebuild it.
    claimsHuge.writeUInt32BE(60000, 16);
    await expect(attach(claimsHuge, 'wide.png')).rejects.toThrow(/SMS backend 415/);
  });

  it('keeps attaching local: nothing was sent to Twilio, and no link exists', async () => {
    const linksBefore = linkCount();
    const photo = await attach(JPEG, 'local.jpg');

    expect(linkCount()).toBe(linksBefore);
    expect(mockCreates).toHaveLength(0);
    expect(fake.requests.filter((r) => r.path.includes('/Messages'))).toHaveLength(0);
    // Neither the photo's id nor anything else answers as a public link.
    for (const p of [`/media/${photo.id}`, `/media/${crypto.randomBytes(32).toString('base64url')}`]) {
      expect((await tunnelGet(p)).status).toBe(404);
    }
  });

  it('answers the app only: previews, attaching and discarding are private routes', async () => {
    const photo = await attach(PNG, 'private.png');

    for (const [method, p] of [
      ['GET', `/sms/media/${photo.id}`],
      ['DELETE', `/sms/media/${photo.id}`],
      ['POST', '/sms/media'],
      ['GET', `/sms/media-policy?to=${encodeURIComponent(US_RECIPIENT)}`],
      ['POST', '/sms/media-prune'],
    ]) {
      const res = await request(tunnelPort, { method, path: p, body: method === 'POST' ? JSON.stringify({ keep: [] }) : undefined });
      expect(res.status).toBe(403);
      expect(res.bytes.includes(PNG.subarray(0, 8))).toBe(false);
    }
    // Locally, but without the app's key: refused too.
    expect((await request(port, { path: `/sms/media/${photo.id}` })).status).toBe(401);
  });

  it('removes a photo from a draft, and the file with it', async () => {
    const photo = await attach(JPEG, 'discard.jpg');

    expect((await smsBroker.discardPhoto(photo.id)).removed).toBe(true);
    expect(fs.existsSync(path.join(mediaDir, `${photo.id}.bin`))).toBe(false);
    await expect(smsBroker.readPhoto(photo.id)).rejects.toThrow(/404/);
  });

  it('keeps the photo folder and files owner-only', async () => {
    const photo = await attach(JPEG, 'mode.jpg');

    expect(fs.statSync(mediaDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(mediaDir, `${photo.id}.bin`)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(mediaDir, 'media-index.json')).mode & 0o777).toBe(0o600);
  });
});

describe('where photos may be sent, checked before Send', () => {
  const policy = async (to) => smsBroker.photoPolicy(to);

  it('allows United States and Canadian numbers, by area code', async () => {
    expect(await policy(US_RECIPIENT)).toMatchObject({ supported: true, country: 'US', sender: { mms: 'yes' } });
    expect(await policy(CA_RECIPIENT)).toMatchObject({ supported: true, country: 'CA' });
  });

  it('refuses +1 numbers that are not in either country, and every other country', async () => {
    for (const [to, label] of [[JAMAICA, 'Jamaica'], [PUERTO_RICO, 'Puerto Rico'], [UK, 'UK']]) {
      const answer = await policy(to);
      expect({ label, supported: answer.supported, code: answer.reason && answer.reason.code }).toEqual({
        label,
        supported: false,
        code: 'unsupported-country',
      });
      expect(answer.reason.message).toMatch(/United States and Canada/);
    }
  });

  it('refuses when the sending number cannot send photos', async () => {
    fake.state.numbers[0].capabilities.mms = false;
    nowOffset += 6 * 60 * 1000; // past the capability answer's five minutes
    try {
      const answer = await policy(US_RECIPIENT);
      expect(answer).toMatchObject({ supported: false, sender: { mms: 'no' } });
      expect(answer.reason.code).toBe('sender-no-mms');
      const photo = await attach(JPEG, 'nomms.jpg');
      const err = await sendError({ to: US_RECIPIENT, body: 'with photo', media: [photo.id] });
      expect(err.outcome).toBe('failed');
      expect(mockCreates).toHaveLength(0);
    } finally {
      fake.state.numbers[0].capabilities.mms = true;
      nowOffset += 6 * 60 * 1000;
      await policy(US_RECIPIENT); // remember the restored answer for the tests after this one
    }
  });

  it('does not block when the sender cannot be looked up, only when it is known not to work', async () => {
    fake.setUnreachable(true);
    nowOffset += 40 * 60 * 1000;
    try {
      const answer = await policy(US_RECIPIENT);
      expect(answer.sender.mms).toBe('unknown');
      expect(answer.supported).toBe(true);
    } finally {
      fake.setUnreachable(false);
    }
  });

  it('keeps its limits in one place for the app to show', async () => {
    const answer = await policy(US_RECIPIENT);

    expect(answer.limits).toEqual({ maxPhotos: 10, maxBytes: 5 * MiB, linkHours: 24 });
  });

  it('explains a missing public address instead of sending a link nobody can open', () => {
    const { checkPhotoSend } = require('../server/photoPolicy');

    expect(
      checkPhotoSend({ to: US_RECIPIENT, photos: [{ bytes: 10 }], textBytes: 0, publicBaseUrl: null, sender: SENDER, senderMms: 'yes' })
    ).toMatchObject({ code: 'no-public-address' });
  });
});

describe('sending photos', () => {
  it('sends only the selected photos, each with its own unguessable link, after Send', async () => {
    const first = await attach(JPEG, 'one.jpg');
    const second = await attach(PNG, 'two.png');
    const unselected = await attach(JPEG, 'not-sent.jpg');
    expect(mockCreates).toHaveLength(0);
    const linksBefore = linkCount();

    const result = await smsBroker.sendMessage({ to: US_RECIPIENT, body: 'Here they are', media: [first.id, second.id] });

    expect(result).toMatchObject({ ok: true, to: US_RECIPIENT, mms: true });
    expect(mockCreates).toHaveLength(1);
    const params = mockCreates[0];
    expect(params).toMatchObject({ to: US_RECIPIENT, from: SENDER, body: 'Here they are' });
    expect(params.mediaUrl).toHaveLength(2);
    for (const url of params.mediaUrl) {
      expect(url).toMatch(new RegExp(`^${PUBLIC_BASE_URL}/media/[A-Za-z0-9_-]{43}$`));
      expect(url).not.toContain(first.id);
      expect(url).not.toContain(second.id);
    }
    expect(new Set(params.mediaUrl).size).toBe(2);
    expect(linkCount()).toBe(linksBefore + 2); // one per selected photo, none for the unselected one

    // Twilio fetches each link through the tunnel and receives exactly that photo.
    const [a, b] = await Promise.all(params.mediaUrl.map((u) => tunnelGet(mediaPathOf(u))));
    expect(a.status).toBe(200);
    expect(a.headers['content-type']).toBe('image/jpeg');
    expect(a.headers['x-content-type-options']).toBe('nosniff');
    expect(a.headers['cache-control']).toBe('no-store');
    expect(Buffer.compare(a.bytes, JPEG)).toBe(0);
    expect(b.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(b.bytes, PNG)).toBe(0);
    expect((await tunnelGet(mediaPathOf(params.mediaUrl[0]), 'HEAD')).status).toBe(200);

    // The photo that was attached but not selected has no link and was not sent.
    expect(JSON.stringify(params)).not.toContain(unselected.id);
    expect((await smsBroker.readPhoto(unselected.id)).type).toBe('image/jpeg');
    // The stored message records the photos as MMS, with no link or token in it.
    const message = stored()[US_RECIPIENT].messages.at(-1);
    expect(message).toMatchObject({ body: 'Here they are', direction: 'outbound', mms: true });
    expect(message.media.map((m) => m.id)).toEqual([first.id, second.id]);
    expect(JSON.stringify(stored())).not.toMatch(/\/media\/[A-Za-z0-9_-]{43}/);
    await smsBroker.discardPhoto(unselected.id);
  });

  it('sends a photo with no text, and a caption goes as the message body', async () => {
    const photo = await attach(PNG, 'only.png');

    await smsBroker.sendMessage({ to: CA_RECIPIENT, body: '', media: [photo.id] });

    expect(mockCreates[0]).not.toHaveProperty('body');
    expect(mockCreates[0].mediaUrl).toHaveLength(1);
    expect(stored()[CA_RECIPIENT].messages.at(-1)).toMatchObject({ body: '', mms: true });
    expect((await smsBroker.listConversations(CA_RECIPIENT)).lastMediaCount).toBe(1);
  });

  it('serves nothing but a valid, unexpired token through the tunnel', async () => {
    const photo = await attach(JPEG, 'scope.jpg');
    await smsBroker.sendMessage({ to: US_RECIPIENT, body: 'scope', media: [photo.id] });
    const link = mockCreates[0].mediaUrl[0];

    for (const p of [
      '/media',
      '/media/',
      `/media/${photo.id}`,
      '/media/..%2Fsms-store.json',
      '/media/%2e%2e/%2e%2e/sms-store.json',
      `/media/${mediaPathOf(link).split('/')[2]}/extra`,
      `/media/${mediaPathOf(link).split('/')[2]}.jpg`,
      '/media/short',
    ]) {
      const res = await tunnelGet(p);
      expect({ p, status: res.status }).toEqual({ p, status: 404 });
      expect(res.bytes.includes(JPEG.subarray(0, 4))).toBe(false);
    }
    const post = await request(tunnelPort, { method: 'POST', path: mediaPathOf(link) });
    expect(post.status).toBe(405);
  });

  it('stops serving a link after 24 hours', async () => {
    const photo = await attach(PNG, 'expires.png');
    await smsBroker.sendMessage({ to: US_RECIPIENT, body: 'expires', media: [photo.id] });
    const p = mediaPathOf(mockCreates[0].mediaUrl[0]);
    expect((await tunnelGet(p)).status).toBe(200);

    nowOffset = 24 * 60 * 60 * 1000 - 1000;
    expect((await tunnelGet(p)).status).toBe(200);
    nowOffset = 24 * 60 * 60 * 1000 + 1000;
    expect((await tunnelGet(p)).status).toBe(410);
    expect((await tunnelGet(p)).status).toBe(404);
    // The app still shows its own copy.
    expect((await smsBroker.readPhoto(photo.id)).type).toBe('image/png');
  });

  it('refuses more than ten photos, and an over-limit combination, without sending', async () => {
    const ten = [];
    for (let i = 0; i < 11; i++) ten.push((await attach(JPEG, `n${i}.jpg`)).id);
    const tooMany = await sendError({ to: US_RECIPIENT, body: 'eleven', media: ten });
    expect(tooMany.message).toMatch(/up to 10 photos/);
    expect(tooMany.outcome).toBe('failed');

    // Ten is allowed.
    await smsBroker.sendMessage({ to: US_RECIPIENT, body: 'ten', media: ten.slice(0, 10) });
    expect(mockCreates[0].mediaUrl).toHaveLength(10);
    mockCreates.length = 0;

    // Two photos that are each under 5 MB but together are not.
    const a = await attach(bigPng(3 * MiB), 'a.png');
    const b = await attach(bigPng(3 * MiB), 'b.png');
    const tooLarge = await sendError({ to: US_RECIPIENT, body: '', media: [a.id, b.id] });
    expect(tooLarge.message).toMatch(/under 5 MB/);
    // The text counts too: one photo just under the limit plus a long caption.
    const nearly = await attach(bigPng(5 * MiB - 700), 'nearly.png');
    const withText = await sendError({ to: US_RECIPIENT, body: 'x'.repeat(1500), media: [nearly.id] });
    expect(withText.message).toMatch(/under 5 MB/);
    expect(mockCreates).toHaveLength(0);
    for (const id of [a.id, b.id, nearly.id, ten[10]]) await smsBroker.discardPhoto(id);
  });

  it('refuses a destination outside the United States and Canada and keeps the photo as a draft', async () => {
    const photo = await attach(JPEG, 'abroad.jpg');
    const before = JSON.stringify(stored());

    for (const to of [JAMAICA, PUERTO_RICO, UK]) {
      const err = await sendError({ to, body: 'hello', media: [photo.id] });
      expect(err.message).toMatch(/United States and Canada/);
      expect(err.outcome).toBe('failed');
    }

    expect(mockCreates).toHaveLength(0);
    expect(JSON.stringify(stored())).toBe(before); // no message recorded: nothing happened
    // Text-only to the same number still works: the refusal is about photos.
    await smsBroker.sendMessage({ to: JAMAICA, body: 'hello, text only' });
    expect(mockCreates[0]).not.toHaveProperty('mediaUrl');
    // And the photo is still there for a supported recipient.
    await smsBroker.sendMessage({ to: US_RECIPIENT, body: 'back home', media: [photo.id] });
    expect(mockCreates[1].mediaUrl).toHaveLength(1);
  });

  it('refuses ids that are not photos waiting to be sent', async () => {
    const photo = await attach(JPEG, 'once.jpg');
    await smsBroker.sendMessage({ to: US_RECIPIENT, body: 'first', media: [photo.id] });
    mockCreates.length = 0;

    // Already sent (and not failed): another message cannot reuse it, nor to another number.
    expect((await sendError({ to: US_RECIPIENT, body: 'again', media: [photo.id] })).outcome).toBe('failed');
    expect((await sendError({ to: CA_RECIPIENT, body: 'again', media: [photo.id] })).message).toMatch(/no longer available/);
    expect((await sendError({ to: US_RECIPIENT, body: 'x', media: ['0'.repeat(32)] })).message).toMatch(/no longer available/);
    expect((await sendError({ to: US_RECIPIENT, body: 'x', media: ['../../sms-store'] })).message).toMatch(/photo ids/);
    expect(mockCreates).toHaveLength(0);
    // A sent photo is not a draft any more: removing "the draft" does not delete it.
    expect((await smsBroker.discardPhoto(photo.id)).removed).toBe(false);
    expect((await smsBroker.readPhoto(photo.id)).type).toBe('image/jpeg');
  });

  it('after a confirmed failure revokes the links, keeps the content, and allows one reviewed resend', async () => {
    const photo = await attach(JPEG, 'retry.jpg');
    mockCreateBehavior = () => {
      throw Object.assign(new Error('Invalid To phone number'), { status: 400, code: 21211 });
    };
    const err = await sendError({ to: OTHER_US_RECIPIENT, body: 'will fail', media: [photo.id] });
    expect(err.outcome).toBe('failed');
    const failedLink = mediaPathOf(mockCreates[0].mediaUrl[0]);
    expect((await tunnelGet(failedLink)).status).toBe(404); // Twilio refused the message: nothing will fetch it
    const failed = (await thread(OTHER_US_RECIPIENT)).at(-1);
    expect(failed).toMatchObject({ status: 'failed', body: 'will fail', mms: true });
    expect((await smsBroker.readPhoto(photo.id)).bytes.length).toBe(JPEG.length);

    // The reviewed resend uses the failed message's photo, with a new link.
    mockCreateBehavior = () => ({ sid: 'MM00000000000000000000000000000002', status: 'queued' });
    await smsBroker.sendMessage({ to: OTHER_US_RECIPIENT, body: 'will fail', media: [photo.id] });
    expect(mockCreates[1].mediaUrl[0]).not.toBe(mockCreates[0].mediaUrl[0]);
    expect((await tunnelGet(mediaPathOf(mockCreates[1].mediaUrl[0]))).status).toBe(200);
    // ...only to the same number.
    expect((await sendError({ to: CA_RECIPIENT, body: 'x', media: [photo.id] })).message).toMatch(/no longer available/);
  });

  it('after an unknown result keeps the links open, never offers the photos again, and records it as unknown', async () => {
    const photo = await attach(PNG, 'unknown.png');
    mockCreateBehavior = () => {
      throw Object.assign(new Error('Connection ended before a response'), { code: 'ETIMEDOUT' });
    };
    const err = await sendError({ to: CA_RECIPIENT, body: 'did it send?', media: [photo.id] });

    expect(err.outcome).toBe('unknown');
    // Twilio may still be about to fetch the photo.
    expect((await tunnelGet(mediaPathOf(mockCreates[0].mediaUrl[0]))).status).toBe(200);
    expect((await thread(CA_RECIPIENT)).at(-1)).toMatchObject({ status: 'unknown', mms: true });
    mockCreates.length = 0;
    expect((await sendError({ to: CA_RECIPIENT, body: 'did it send?', media: [photo.id] })).message).toMatch(/no longer available/);
    expect(mockCreates).toHaveLength(0);
  });

  it('sends a draft once even if Send is requested twice at the same moment', async () => {
    const photo = await attach(JPEG, 'double.jpg');
    const results = await Promise.allSettled([
      smsBroker.sendMessage({ to: US_RECIPIENT, body: 'double', media: [photo.id] }),
      smsBroker.sendMessage({ to: US_RECIPIENT, body: 'double', media: [photo.id] }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(mockCreates).toHaveLength(1);
  });

  it('removes unlisted old drafts and never touches a photo that belongs to a message', async () => {
    const keep = await attach(JPEG, 'keep.jpg');
    const forgotten = await attach(PNG, 'forgotten.png');
    const sent = await attach(JPEG, 'sent.jpg');
    await smsBroker.sendMessage({ to: US_RECIPIENT, body: 'sent', media: [sent.id] });

    expect((await smsBroker.prunePhotos([keep.id])).removed).toBe(0); // too new: it may be attached any moment
    nowOffset += 11 * 60 * 1000;
    expect((await smsBroker.prunePhotos([keep.id])).removed).toBeGreaterThanOrEqual(1);

    await expect(smsBroker.readPhoto(forgotten.id)).rejects.toThrow(/404/);
    expect((await smsBroker.readPhoto(keep.id)).type).toBe('image/jpeg');
    expect((await smsBroker.readPhoto(sent.id)).type).toBe('image/jpeg');
    await smsBroker.discardPhoto(keep.id);
  });

  it('clears a thread’s photos from this computer and closes their links, leaving drafts alone', async () => {
    const draft = await attach(PNG, 'draft-stays.png');
    const sent = await attach(JPEG, 'goes.jpg');
    await smsBroker.sendMessage({ to: OTHER_US_RECIPIENT, body: 'to clear', media: [sent.id] });
    const link = mediaPathOf(mockCreates[0].mediaUrl[0]);
    expect((await tunnelGet(link)).status).toBe(200);

    await smsBroker.clearConversation(OTHER_US_RECIPIENT);

    expect((await tunnelGet(link)).status).toBe(404);
    await expect(smsBroker.readPhoto(sent.id)).rejects.toThrow(/404/);
    expect(fs.existsSync(path.join(mediaDir, `${sent.id}.bin`))).toBe(false);
    expect((await smsBroker.readPhoto(draft.id)).type).toBe('image/png');
    await smsBroker.discardPhoto(draft.id);
  });
});

describe('receiving photos', () => {
  const INBOUND = (n, extra) => ({
    SmsSid: `MM0000000000000000000000000000${String(n).padStart(4, '0')}`,
    MessageSid: `MM0000000000000000000000000000${String(n).padStart(4, '0')}`,
    SmsStatus: 'received',
    Body: 'Photos from the trip',
    From: '+15555550199',
    To: SENDER,
    AccountSid: process.env.TWILIO_ACCOUNT_SID,
    ApiVersion: '2010-04-01',
    ...extra,
  });
  const media = (m) => (m.media || []).map((x) => `${x.state}${x.reason ? ':' + x.reason : ''}`);
  const latestInbound = async () => (await thread('+15555550199')).filter((m) => m.direction === 'inbound').at(-1);

  it('downloads JPEG and PNG from Twilio only, shows pending first, and refuses what it cannot show', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const jpeg = fake.addMedia({ bytes: JPEG, type: 'image/jpeg', cdn: true, gate });
    const png = fake.addMedia({ bytes: PNG, type: 'image/png' });
    const gif = fake.addMedia({ bytes: GIF, type: 'image/gif' });
    const res = await postWebhook(
      '/sms/inbound',
      INBOUND(1, {
        NumMedia: '3',
        MediaUrl0: jpeg.url,
        MediaContentType0: 'image/jpeg',
        MediaUrl1: png.url,
        MediaContentType1: 'image/png',
        MediaUrl2: gif.url,
        MediaContentType2: 'image/gif',
      })
    );

    expect(res.status).toBe(200); // answered before the downloads finish
    expect(media(await latestInbound())).toEqual(['pending', 'pending', 'unavailable:unsupported-type']);
    expect((await latestInbound()).media[2].contentType).toBe('image/gif');

    release();
    await whenMediaIdle();
    const message = await latestInbound();
    expect(media(message)).toEqual(['ready', 'ready', 'unavailable:unsupported-type']);
    expect(message.media[0]).toMatchObject({ type: 'image/jpeg', width: 48, height: 32, bytes: JPEG.length });
    const first = await smsBroker.readPhoto(message.media[0].id);
    expect(Buffer.compare(first.bytes, JPEG)).toBe(0);
    expect(Buffer.compare((await smsBroker.readPhoto(message.media[1].id)).bytes, PNG)).toBe(0);
    // The GIF was never requested.
    expect(fake.requests.some((r) => r.path === new URL(gif.url).pathname)).toBe(false);
    // Credentials went to the first address, not to the CDN redirect.
    const hops = fake.requests.filter((r) => r.path === new URL(jpeg.url).pathname || r.path === new URL(jpeg.cdnUrl).pathname);
    expect(hops.map((h) => [new URL(jpeg.url).pathname === h.path ? 'api' : 'cdn', h.auth, h.hasAuthHeader])).toEqual([
      ['api', 'key', true],
      ['cdn', false, false],
    ]);
    // Nothing but the app can read the downloaded copy.
    expect((await tunnelGet(`/sms/media/${message.media[0].id}`)).status).toBe(403);
    expect((await tunnelGet(`/media/${message.media[0].id}`)).status).toBe(404);
  });

  it('never fetches from another host, another account, another port or a redirect elsewhere', async () => {
    const otherAccount = `AC${'2'.repeat(32)}`;
    const mediaPath = (account) => `/2010-04-01/Accounts/${account}/Messages/MM${'a'.repeat(32)}/Media/ME${'b'.repeat(32)}`;
    const elsewhereRedirect = fake.addMedia({ bytes: JPEG, redirectTo: 'http://127.0.0.1:9/never' });
    const ownPath = new URL(fake.addMedia({ bytes: JPEG }).url).pathname;
    const urls = [
      `https://evil.example${mediaPath(process.env.TWILIO_ACCOUNT_SID)}`,
      `https://api.twilio.com.evil.example${mediaPath(process.env.TWILIO_ACCOUNT_SID)}`,
      `${fake.base}${mediaPath(otherAccount)}`,
      `${fake.base}${ownPath}?token=x`,
      `http://user:pass@127.0.0.1:${new URL(fake.base).port}${ownPath}`,
      `http://127.0.0.1:9${ownPath}`,
      `${fake.base}/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages/MM${'a'.repeat(32)}/Media/../../../../Keys.json`,
      elsewhereRedirect.url,
    ];
    const params = { NumMedia: String(urls.length) };
    urls.forEach((u, i) => {
      params[`MediaUrl${i}`] = u;
      params[`MediaContentType${i}`] = 'image/jpeg';
    });
    fake.clearRequests();

    await postWebhook('/sms/inbound', INBOUND(2, params));
    await whenMediaIdle();

    expect(media(await latestInbound())).toEqual(urls.map(() => 'unavailable:refused'));
    // The only request that reached the fake is the approved first address that redirects away.
    expect(fake.requests.map((r) => r.path)).toEqual([new URL(elsewhereRedirect.url).pathname]);
  });

  it('stops a photo that is too large, and one that is not what it says', async () => {
    const huge = fake.addMedia({ bytes: bigPng(5 * MiB), type: 'image/png' });
    const realGif = fake.addMedia({ bytes: GIF, type: 'image/jpeg' }); // says JPEG, is a GIF
    const gone = fake.addMedia({ bytes: Buffer.alloc(0), status: 404 });
    const fine = fake.addMedia({ bytes: JPEG, type: 'image/jpeg' });
    await postWebhook(
      '/sms/inbound',
      INBOUND(3, {
        NumMedia: '4',
        MediaUrl0: huge.url,
        MediaContentType0: 'image/png',
        MediaUrl1: realGif.url,
        MediaContentType1: 'image/jpeg',
        MediaUrl2: gone.url,
        MediaContentType2: 'image/jpeg',
        MediaUrl3: fine.url,
        MediaContentType3: 'image/jpeg',
      })
    );
    await whenMediaIdle();

    expect(media(await latestInbound())).toEqual(['unavailable:too-large', 'unavailable:invalid', 'unavailable:unavailable', 'ready']);
    expect(filesOnDisk().length).toBeGreaterThan(0);
    const bad = (await latestInbound()).media.slice(0, 3).map((m) => path.join(mediaDir, `${m.id}.bin`));
    expect(bad.some((f) => fs.existsSync(f))).toBe(false);
  });

  it('keeps the text of a photo message under 5 MB along with its photos', async () => {
    const first = fake.addMedia({ bytes: bigPng(3 * MiB), type: 'image/png' });
    const second = fake.addMedia({ bytes: bigPng(3 * MiB), type: 'image/png' });
    await postWebhook(
      '/sms/inbound',
      INBOUND(4, { NumMedia: '2', MediaUrl0: first.url, MediaContentType0: 'image/png', MediaUrl1: second.url, MediaContentType1: 'image/png' })
    );
    await whenMediaIdle();

    expect(media(await latestInbound())).toEqual(['ready', 'unavailable:too-large']);
  });

  it('shows videos and other types as placeholders without downloading them, and caps the count', async () => {
    const params = { NumMedia: '12' };
    for (let i = 0; i < 12; i++) {
      params[`MediaUrl${i}`] = `${fake.base}/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages/MM${'c'.repeat(32)}/Media/ME${String(i).padStart(32, '0')}`;
      params[`MediaContentType${i}`] = i === 0 ? 'video/mp4' : 'image/webp';
    }
    fake.clearRequests();
    await postWebhook('/sms/inbound', INBOUND(5, params));
    await whenMediaIdle();

    const message = await latestInbound();
    expect(message.media).toHaveLength(11);
    expect(media(message).slice(0, 2)).toEqual(['unavailable:unsupported-type', 'unavailable:unsupported-type']);
    expect(message.media[10].reason).toBe('too-many');
    expect(fake.requests).toHaveLength(0);
  });

  it('drops a photo that finishes downloading after its thread was cleared', async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const held = fake.addMedia({ bytes: JPEG, type: 'image/jpeg', gate });
    const before = filesOnDisk().length;
    await postWebhook('/sms/inbound', INBOUND(6, { From: '+15555550177', NumMedia: '1', MediaUrl0: held.url, MediaContentType0: 'image/jpeg' }));
    await smsBroker.clearConversation('+15555550177');
    release();
    await whenMediaIdle();

    expect(filesOnDisk().length).toBe(before);
  });
});

describe('storage and restarts', () => {
  const { MediaStore } = require('../server/mediaStore');
  const { SmsStore } = require('../server/smsStore');

  it('keeps drafts and sent photos through a restart, and sweeps unreferenced files', () => {
    const dir = fs.mkdtempSync(path.join(workDir, 'restart-'));
    const first = new MediaStore({ dir });
    const draft = first.add({ bytes: JPEG, name: 'draft.jpg', kind: 'draft' });
    const kept = first.add({ bytes: PNG, kind: 'message' });
    fs.writeFileSync(path.join(dir, `${'f'.repeat(32)}.bin`), 'left behind by a crash');

    const second = new MediaStore({ dir });
    second.reconcile();

    expect(second.get(draft.id)).toMatchObject({ kind: 'draft', type: 'image/jpeg', name: 'draft.jpg' });
    expect(second.get(kept.id)).toMatchObject({ kind: 'message', type: 'image/png' });
    expect(Buffer.compare(second.read(draft.id).bytes, JPEG)).toBe(0);
    expect(fs.existsSync(path.join(dir, `${'f'.repeat(32)}.bin`))).toBe(false);
  });

  it('does not delete photos when the index is damaged', () => {
    const dir = fs.mkdtempSync(path.join(workDir, 'damaged-'));
    const first = new MediaStore({ dir });
    const photo = first.add({ bytes: JPEG, kind: 'message' });
    fs.writeFileSync(path.join(dir, 'media-index.json'), '{not json');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const second = new MediaStore({ dir });
    second.reconcile();

    spy.mockRestore();
    expect(fs.existsSync(path.join(dir, `${photo.id}.bin`))).toBe(true);
  });

  it('marks downloads a stop interrupted as unavailable, and releases photos of messages dropped by retention', async () => {
    const file = path.join(workDir, 'retention-store.json');
    const released = [];
    const store = new SmsStore(file, { onRelease: (ids) => released.push(...ids) });
    const id = MediaStore.newId();
    await store.appendMessage({ number: '+15555550142', sid: 'SM1', direction: 'inbound', body: '', at: 1, status: 'received', media: [{ id, state: 'pending' }] });

    const restarted = new SmsStore(file);
    expect(restarted.failPendingMedia()).toBe(true);
    expect(restarted.getConversation('+15555550142').messages[0].media[0]).toMatchObject({ state: 'unavailable', reason: 'interrupted' });

    for (let i = 0; i < 500; i++) {
      await store.appendMessage({ number: '+15555550142', sid: `SMx${i}`, direction: 'inbound', body: 'filler', at: 2 + i, status: 'received' });
    }
    expect(released).toEqual([id]);
  });
});

describe('approved download addresses', () => {
  const { approvedMediaUrl } = require('../server/mediaFetch');
  const account = `AC${'1'.repeat(32)}`;
  const good = `https://api.twilio.com/2010-04-01/Accounts/${account}/Messages/MM${'a'.repeat(32)}/Media/ME${'b'.repeat(32)}`;

  it('accepts Twilio’s own media address for this account, and nothing like it', () => {
    const env = {};
    expect(approvedMediaUrl(good, account, env)).not.toBeNull();
    for (const bad of [
      good.replace('https:', 'http:'),
      good.replace('api.twilio.com', 'api.twilio.com:8443'),
      good.replace('api.twilio.com', 'api.twilio.com@evil.example'),
      good.replace('api.twilio.com', 'api.twilio.com.evil.example'),
      good.replace('api.twilio.com', 'twilio.com'),
      `${good}?x=1`,
      `${good}/`,
      good.replace(account, `AC${'2'.repeat(32)}`),
      good.replace('/Media/', '/Other/'),
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect({ bad, ok: approvedMediaUrl(bad, account, env) !== null }).toEqual({ bad, ok: false });
    }
  });
});
