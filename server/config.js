// The token server's settings, readable again after the in-app setup has
// written server/.env.
//
// Precedence matches dotenv, which this replaces: a value present in the
// environment this process started with (the shell, or `npm run phone`)
// wins over server/.env. That is how `npm run phone` supplies the tunnel's
// address without touching the file. The file is read again on reload().

const { readEnvFile } = require('./envFile');

const NAMES = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_API_KEY',
  'TWILIO_API_SECRET',
  'TWILIO_TWIML_APP_SID',
  'TWILIO_CALLER_ID',
  'TWILIO_SMS_FROM',
  'SMS_STATUS_CALLBACK_URL',
  'OPERATOR_IDENTITY',
  'TWILIO_AUTH_TOKEN',
  'PUBLIC_BASE_URL',
  'SMS_PUBLIC_BASE_URL',
  'OPERATOR_INSTALL_ID',
];

function createConfig({ launchEnv, envFile }) {
  let fileValues = {};
  let current = null;

  function pick(name) {
    const fromEnv = launchEnv[name];
    return fromEnv !== undefined && fromEnv !== '' ? { value: fromEnv, source: 'environment' } : null;
  }

  function resolve() {
    const settings = {};
    const sources = {};
    for (const name of NAMES) {
      const env = pick(name);
      if (env) {
        settings[name] = env.value;
        sources[name] = 'environment';
      } else if (fileValues[name]) {
        settings[name] = fileValues[name];
        sources[name] = 'file';
      } else {
        settings[name] = '';
        sources[name] = null;
      }
    }
    // The public base URL Twilio calls (the tunnel's address, no trailing
    // slash), or null when unset or not an http(s) URL. SMS_PUBLIC_BASE_URL
    // is the older name for the same setting.
    const rawPublic = settings.PUBLIC_BASE_URL || settings.SMS_PUBLIC_BASE_URL || '';
    const publicSource = settings.PUBLIC_BASE_URL ? sources.PUBLIC_BASE_URL : sources.SMS_PUBLIC_BASE_URL;
    let publicBaseUrl = null;
    if (rawPublic) {
      try {
        const parsed = new URL(rawPublic);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          publicBaseUrl = rawPublic.replace(/\/+$/, '');
        }
      } catch (_) {
        publicBaseUrl = null;
      }
    }
    return {
      accountSid: settings.TWILIO_ACCOUNT_SID,
      apiKey: settings.TWILIO_API_KEY,
      apiSecret: settings.TWILIO_API_SECRET,
      twimlAppSid: settings.TWILIO_TWIML_APP_SID,
      callerId: settings.TWILIO_CALLER_ID,
      smsFrom: settings.TWILIO_SMS_FROM,
      statusCallbackUrl: settings.SMS_STATUS_CALLBACK_URL,
      identity: settings.OPERATOR_IDENTITY,
      authToken: settings.TWILIO_AUTH_TOKEN,
      installId: settings.OPERATOR_INSTALL_ID,
      rawPublicBaseUrl: rawPublic,
      publicBaseUrl,
      publicBaseUrlSource: publicBaseUrl ? publicSource : null,
      sources,
    };
  }

  function reload() {
    fileValues = envFile ? readEnvFile(envFile).values : {};
    current = resolve();
    return current;
  }

  reload();
  return {
    get: () => current,
    reload,
    envFile,
    // Names whose value comes from the environment, so a value written to
    // server/.env under that name would not take effect.
    shadowed: (names) => names.filter((n) => pick(n)),
  };
}

module.exports = { createConfig, NAMES };
