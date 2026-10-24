// The renderer's side of the in-app Twilio setup: calls into the desktop
// bridge (window.operator.setup, see preload.js) and always answers
// { ok, ... }. No answer contains the Auth Token or an API secret.

const UNSUPPORTED = {
  ok: false,
  kind: 'unsupported',
  error: 'Twilio setup is not available in this window. Open Operator from its desktop app.',
};

async function call(name, input) {
  const api = typeof window !== 'undefined' && window.operator && window.operator.setup;
  if (!api || typeof api[name] !== 'function') return UNSUPPORTED;
  try {
    const answer = await api[name](input);
    return answer && typeof answer === 'object'
      ? answer
      : { ok: false, kind: 'service', error: 'Setup did not answer.' };
  } catch (err) {
    return { ok: false, kind: 'service', error: err.message || 'Setup did not answer.' };
  }
}

export const setupService = {
  status: () => call('status'),
  check: (input) => call('check', input),
  review: (input) => call('review', input),
  connect: (input) => call('connect', input),
  repair: () => call('repair'),
};

export const SID_RE = /^AC[0-9a-fA-F]{32}$/;
export const CONSOLE_NUMBERS_URL = 'https://console.twilio.com/us1/develop/phone-numbers/manage/incoming';
export const CONSOLE_BUY_URL = 'https://console.twilio.com/us1/develop/phone-numbers/manage/search';
