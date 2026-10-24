// Isolated Electron test launcher. Only use a disposable profile and fictional credentials.
// The renderer comes from fixture.cjs (fake Voice SDK); all IPC/config/SMS brokers are real.
const fs = require('fs'),
  path = require('path'),
  Module = require('module');
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '../..');
const profile = process.env.OPERATOR_TEST_PROFILE;
if (!profile || path.resolve(profile) === app.getPath('userData'))
  throw new Error('Set a disposable OPERATOR_TEST_PROFILE.');
if (!process.env.OPERATOR_FIXTURE_URL?.startsWith('http://127.0.0.1:'))
  throw new Error('Use a loopback-only fictional renderer.');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('password-store', 'basic');
const account = 'AC00000000000000000000000000000000';
// OPERATOR_DESKTOP_SETUP=fresh: no Twilio settings at all, so the app opens on
// Settings → Twilio account and the real setup service talks to the fictional
// Twilio at OPERATOR_TWILIO_API_BASE (tools/fake-twilio, started by the journey).
const fresh = process.env.OPERATOR_DESKTOP_SETUP === 'fresh';
if (fresh && !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.OPERATOR_TWILIO_API_BASE || ''))
  throw new Error('Fresh mode needs the loopback fictional Twilio.');
const cfg = path.join(profile, 'config.json');
if (!fresh && !fs.existsSync(cfg))
  fs.writeFileSync(
    cfg,
    JSON.stringify({ accountSid: account, identity: 'operator-demo' }),
    { mode: 0o600 },
  );
const store = path.join(profile, 'sms-store.json');
if (!fs.existsSync(store))
  fs.writeFileSync(
    store,
    JSON.stringify({
      '+12025550101': {
        number: '+12025550101',
        lastMessageAt: 1781856060000,
        lastBody: 'Yes, see you then.',
        messages: [
          {
            sid: 'SMfictional1',
            direction: 'inbound',
            body: 'Can we meet at 2 tomorrow?',
            status: 'received',
            at: 1781856000000,
          },
          {
            sid: 'SMfictional2',
            direction: 'outbound',
            body: 'Yes, see you then.',
            status: 'delivered',
            at: 1781856060000,
          },
        ],
      },
      '+12025550102': {
        number: '+12025550102',
        lastMessageAt: 1781769600000,
        lastBody: 'Please confirm the address.',
        messages: [
          {
            sid: 'SMfictional3',
            direction: 'inbound',
            body: 'Please confirm the address.',
            status: 'received',
            at: 1781769600000,
          },
        ],
      },
    }),
    { mode: 0o600 },
  );
if (fresh) {
  Object.assign(process.env, {
    SMS_STORE_PATH: store,
    OPERATOR_LOCAL_API_KEY_FILE: path.join(profile, 'local-api-key'),
    OPERATOR_ENV_FILE: path.join(profile, 'server.env'),
    OPERATOR_SETUP_STATE_FILE: path.join(profile, 'setup.json'),
  });
  for (const k of [
    'TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY', 'TWILIO_API_SECRET', 'TWILIO_TWIML_APP_SID',
    'TWILIO_CALLER_ID', 'TWILIO_SMS_FROM', 'TWILIO_AUTH_TOKEN', 'OPERATOR_IDENTITY',
    'PUBLIC_BASE_URL', 'SMS_PUBLIC_BASE_URL', 'SMS_STATUS_CALLBACK_URL', 'OPERATOR_INSTALL_ID',
  ])
    delete process.env[k];
} else Object.assign(process.env, {
  TWILIO_ACCOUNT_SID: account,
  TWILIO_API_KEY: 'SK00000000000000000000000000000000',
  TWILIO_API_SECRET: 'fixture-secret',
  TWILIO_AUTH_TOKEN: 'fixture-token',
  TWILIO_TWIML_APP_SID: 'AP00000000000000000000000000000000',
  TWILIO_CALLER_ID: '+12025550100',
  TWILIO_SMS_FROM: '+12025550100',
  SMS_PUBLIC_BASE_URL: 'https://fixture.invalid',
  SMS_STATUS_CALLBACK_URL: 'https://fixture.invalid/sms/status',
  OPERATOR_IDENTITY: 'operator-demo',
  PUBLIC_BASE_URL: 'https://fixture.invalid',
  SMS_STORE_PATH: store,
  OPERATOR_LOCAL_API_KEY_FILE: path.join(profile, 'local-api-key'),
});
// Stub only the provider's REST client, not the server/router/brokers/preload.
const original = Module._load;
const realTwilio = require(path.join(root, 'server/node_modules/twilio'));
// The messages client only; setup talks to the fictional Twilio over HTTP.
const fakeTwilio = Object.assign(
  () => ({
    messages: {
      create: async (p) => {
        // What the service handed to Twilio, for the journey to read (photo links included).
        fs.appendFileSync(path.join(profile, 'sent-requests.jsonl'), JSON.stringify(p) + '\n');
        const body = p.body || '';
        if (body.includes('[unknown]'))
          throw Object.assign(new Error('Connection ended'), {
            code: 'ETIMEDOUT',
          });
        if (body.includes('[fail]'))
          throw Object.assign(new Error('Invalid destination'), {
            status: 400,
            code: 21211,
          });
        return { sid: 'SMfixture' + Date.now(), status: 'sent' };
      },
    },
  }),
  realTwilio,
);
Module._load = function (name, parent, isMain) {
  if (name === 'twilio' && parent?.filename.startsWith(root + path.sep))
    return fakeTwilio;
  if (name === 'electron' && parent?.filename.startsWith(root + path.sep)) {
    const real = original.call(this, name, parent, isMain);
    class FictionalNotification {
      on(event, handler) {
        if (event === 'click')
          global.__operatorFixtureNotificationClick = handler;
      }
      show() {}
      static isSupported() {
        return true;
      }
    }
    return {
      ...real,
      Notification: FictionalNotification,
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => {
          throw new Error('No keychain in tests');
        },
        decryptString: () => {
          throw new Error('No keychain in tests');
        },
      },
    };
  }
  return original.call(this, name, parent, isMain);
};
// The service looks up the sending number's photo (MMS) capability with a read-only
// request; in this launcher that goes to the fictional Twilio the journey started
// (OPERATOR_TWILIO_API_BASE) or, without one, to a closed loopback port, never the internet.
if (!process.env.OPERATOR_TWILIO_API_BASE) process.env.OPERATOR_TWILIO_API_BASE = 'http://127.0.0.1:9';
const loadURL = BrowserWindow.prototype.loadURL;
BrowserWindow.prototype.loadURL = function () {
  return loadURL.call(this, process.env.OPERATOR_FIXTURE_URL);
};
// No detached developer-tools window and no real OS notification in this test.
app.on('web-contents-created', (_e, contents) => {
  contents.openDevTools = () => {};
});
(async () => {
  const serverModule = require(path.join(root, 'server/server'));
  const server = await serverModule.startServer({ port: 0 });
  // What a launch does once the service listens: check what Operator owns.
  if (fresh) serverModule.startRepair();
  const base = 'http://127.0.0.1:' + server.address().port;
  fs.writeFileSync(path.join(profile, 'server-port'), String(server.address().port));
  // Brokers use the real private key against the isolated server, not the installed app.
  process.env.TOKEN_BACKEND_URL = base + '/token';
  process.env.SMS_BACKEND_URL = base;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_API_KEY;
  delete process.env.TWILIO_API_SECRET;
  delete process.env.TWILIO_TWIML_APP_SID;
  require(path.join(root, 'main.js'));
  app.on('before-quit', () => server.close());
})().catch((e) => {
  console.error(e);
  app.exit(1);
});
