// TWP-9 piece 2 screens (accepted "Connect Twilio in the app"): Account →
// Number → Review → Connected. Intent checked here: a wrong sign-in and an
// unreachable Twilio read differently; a number with nothing suitable
// explains how to add one and never offers to buy; every foreign route has
// its own unchecked Replace control and only checked ones are agreed to;
// a failed step is named with Retry; and the Auth Token the person typed is
// sent only to be saved, never shown back. The bridge is a fake with the
// shapes server/setup.js answers (that service is tested in src/setup.test.js).

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { TwilioSetup } from './TwilioSetup';

const SID = 'AC' + '1'.repeat(32);
const TOKEN = 'a-token-typed-by-the-person-0001';
const NUMBER = {
  sid: 'PN' + 'a'.repeat(32),
  e164: '+15555550101',
  friendlyName: '+15555550101',
  capabilities: { voice: true, sms: true, mms: true },
  current: false,
  voice: { state: 'foreign', description: 'https://elsewhere.example/voice', fingerprint: 'fp-voice' },
  sms: { state: 'blank', description: 'not set', fingerprint: 'fp-sms' },
};
const REVIEW = {
  ok: true,
  number: { sid: NUMBER.sid, e164: NUMBER.e164, capabilities: NUMBER.capabilities },
  rows: [
    { id: 'key', label: 'API key', action: 'create', detail: 'Create one API key named for Operator.' },
    {
      id: 'voice',
      label: 'Incoming calls',
      action: 'replace',
      foreign: true,
      current: 'https://elsewhere.example/voice',
      fingerprint: 'fp-voice',
      detail: "The number's voice route currently goes to https://elsewhere.example/voice, which is not Operator.",
    },
    {
      id: 'sms',
      label: 'Incoming texts',
      action: 'replace',
      foreign: true,
      current: 'application AP' + 'b'.repeat(32),
      fingerprint: 'fp-sms',
      detail: "The number's text route currently goes to an application, which is not Operator.",
      notes: ["A Messaging Service's own setting overrides the number's; Operator does not edit Messaging Services."],
    },
  ],
};
const STEPS_OK = [
  { id: 'key', label: 'API key', status: 'done', detail: 'Created API key.' },
  { id: 'app', label: 'TwiML App', status: 'done', detail: 'Created the TwiML App.' },
  { id: 'voice', label: 'Incoming calls', status: 'skipped', detail: 'Left on https://elsewhere.example/voice, as you chose.' },
  { id: 'sms', label: 'Incoming texts', status: 'done', detail: 'Set incoming texts to Operator.' },
];

let container;
let root;
let setup;
let props;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  setup = {
    check: jest.fn().mockResolvedValue({ ok: true, numbers: [NUMBER], more: false }),
    review: jest.fn().mockResolvedValue(REVIEW),
    connect: jest.fn().mockResolvedValue({ ok: true, steps: STEPS_OK, warnings: [] }),
    repair: jest.fn().mockResolvedValue({ ok: true, result: 'ok', changes: [] }),
  };
  window.operator = { setup, app: { openExternal: jest.fn().mockResolvedValue({ ok: true }) } };
  props = {
    status: { ok: true, available: true, credentials: false, hasAuthToken: false, connected: false, accountSid: null, publicBaseUrl: null, publicBaseUrlSource: null, identity: null },
    fallbackIdentity: '',
    onRefresh: jest.fn().mockResolvedValue({ ok: true, connected: true }),
    onConnected: jest.fn(),
  };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete window.operator;
});

const render = async () => {
  await act(async () => root.render(<TwilioSetup {...props} />));
};
const settle = () => act(async () => {});

function type(label, value) {
  const field = [...container.querySelectorAll('label')].find((l) => l.textContent.startsWith(label));
  const input = field.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const buttons = () => [...container.querySelectorAll('button')];
const button = (name) => buttons().find((b) => b.textContent.trim() === name);
async function press(name) {
  const b = button(name);
  if (!b) throw new Error(`no "${name}" button; have: ${buttons().map((x) => x.textContent).join(' | ')}`);
  await act(async () => b.click());
}
const text = () => container.textContent;

async function toNumberStep() {
  await render();
  type('Account SID', SID);
  type('Auth Token', TOKEN);
  type('Public address', 'https://fictional.ngrok-free.app');
  await press('Check account');
}
async function toReviewStep() {
  await toNumberStep();
  act(() => container.querySelector('input[type="radio"]').click());
  await press('Review changes');
}

test('an unconnected account starts on Account with Check account unavailable until it can work', async () => {
  await render();
  expect(container.querySelector('[aria-current="step"]').textContent).toBe('Account');
  expect(button('Check account').disabled).toBe(true);
  type('Account SID', 'nonsense');
  expect(text()).toContain('does not look like a Twilio Account SID');
  type('Account SID', SID);
  type('Auth Token', TOKEN);
  expect(button('Check account').disabled).toBe(false);
});

test('a saved Auth Token is never shown, and typing one is optional', async () => {
  props.status = { ...props.status, credentials: true, hasAuthToken: true, accountSid: SID, identity: 'operator-demo' };
  await render();
  await settle();
  const token = [...container.querySelectorAll('label')].find((l) => l.textContent.startsWith('Auth Token')).querySelector('input');
  expect(token.type).toBe('password');
  expect(token.value).toBe('');
  expect(text()).toContain('saved in server/.env');
  expect(button('Check account').disabled).toBe(false);
});

test.each([
  ['invalid-credentials', 'Twilio did not accept this sign-in.', 'Sign-in not accepted'],
  ['unreachable', 'Could not reach Twilio.', 'Twilio could not be reached'],
])('Check account says "%s" in its own words', async (kind, message, heading) => {
  setup.check.mockResolvedValue({ ok: false, kind, error: message });
  await toNumberStep();
  expect(container.querySelector('[role="alert"]').textContent).toBe(`${heading}${message}`);
  expect(container.querySelector('[aria-current="step"]').textContent).toBe('Account');
});

test('the number step lists capabilities and current routes, and never offers to buy a number', async () => {
  await toNumberStep();
  expect(setup.check).toHaveBeenCalledWith({
    accountSid: SID,
    authToken: TOKEN,
    publicBaseUrl: 'https://fictional.ngrok-free.app',
    identity: expect.stringMatching(/^operator-/),
  });
  expect(text()).toContain('+1 555 555 0101');
  expect(text()).toContain('Calls · Texts · Photos');
  expect(text()).toContain('Calls go to https://elsewhere.example/voice');
  expect(text()).toContain('Texts: not set');
  expect(button('Review changes').disabled).toBe(true);
  expect(text()).toContain('never buys numbers');
  expect(buttons().map((b) => b.textContent).join(' ')).not.toMatch(/\bbuy\b/i);
});

test('an account with no numbers explains how to add one in the console', async () => {
  setup.check.mockResolvedValue({ ok: true, numbers: [], more: false });
  await toNumberStep();
  expect(text()).toContain('This account has no numbers.');
  expect(button('Review changes').disabled).toBe(true);
  await press('Open the Twilio console to add a number');
  expect(window.operator.app.openExternal).toHaveBeenCalledWith(expect.stringContaining('console.twilio.com'));
});

test('each foreign route has its own unchecked Replace control, and only a checked one is agreed to', async () => {
  await toReviewStep();
  expect(container.querySelector('[aria-current="step"]').textContent).toBe('Review');
  expect(setup.review).toHaveBeenCalledWith(expect.objectContaining({ numberSid: NUMBER.sid }));
  const boxes = [...container.querySelectorAll('.replace-choice input[type="checkbox"]')];
  expect(boxes).toHaveLength(2);
  expect(boxes.every((b) => !b.checked)).toBe(true);
  expect(text()).toContain('Replace where calls go now (https://elsewhere.example/voice) with Operator');
  expect(text()).toContain('Operator does not edit Messaging Services');

  // Nothing checked: Connect agrees to nothing.
  await press('Connect');
  expect(setup.connect.mock.calls[0][0].replace).toEqual({});
});

test('agreeing to one route does not agree to the other', async () => {
  await toReviewStep();
  const [voice] = [...container.querySelectorAll('.replace-choice input[type="checkbox"]')];
  act(() => voice.click());
  await press('Connect');
  expect(setup.connect).toHaveBeenCalledTimes(1);
  expect(setup.connect.mock.calls[0][0].replace).toEqual({ voice: 'fp-voice' });
});

test('Connected lists each step as done, unchanged or left unchanged, then clears the typed token', async () => {
  await toReviewStep();
  await press('Connect');
  expect(container.querySelector('[aria-current="step"]').textContent).toBe('Connected');
  const steps = [...container.querySelectorAll('.result-steps li')].map((li) => li.textContent);
  expect(steps[2]).toContain('Left unchanged');
  expect(steps[2]).toContain('Left on https://elsewhere.example/voice, as you chose.');
  expect(steps[3]).toContain('Done');
  expect(props.onConnected).toHaveBeenCalledTimes(1);
  // The token was sent for saving, and is gone from the page.
  expect(setup.connect.mock.calls[0][0].authToken).toBe(TOKEN);
  expect(text()).not.toContain(TOKEN);
  expect([...container.querySelectorAll('input')].some((i) => i.value === TOKEN)).toBe(false);
  expect(button('Change number')).toBeDefined();
});

test('a failed step is named, finished steps stay, and Retry resumes with the same choices', async () => {
  setup.connect
    .mockResolvedValueOnce({
      ok: false,
      failedStep: 'app',
      error: 'Could not reach Twilio.',
      steps: [
        { id: 'key', label: 'API key', status: 'done', detail: 'Created API key.' },
        { id: 'app', label: 'TwiML App', status: 'failed', detail: 'Could not reach Twilio.' },
        { id: 'voice', label: 'Incoming calls', status: 'pending' },
      ],
      warnings: [],
    })
    .mockResolvedValueOnce({ ok: true, steps: STEPS_OK, warnings: [] });
  await toReviewStep();
  const [voice] = [...container.querySelectorAll('.replace-choice input[type="checkbox"]')];
  act(() => voice.click());
  await press('Connect');
  const alert = container.querySelector('[role="alert"]');
  expect(alert.textContent).toContain('TwiML App did not finish.');
  expect(alert.textContent).toContain('creates nothing twice');
  expect(props.onConnected).not.toHaveBeenCalled();
  await press('Retry');
  expect(setup.connect).toHaveBeenCalledTimes(2);
  expect(setup.connect.mock.calls[1][0]).toEqual(setup.connect.mock.calls[0][0]);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(props.onConnected).toHaveBeenCalledTimes(1);
});

test('an already connected account shows its summary, and Check connection now reports repairs', async () => {
  props.status = { ...props.status, credentials: true, connected: true, hasAuthToken: true, accountSid: SID, number: '+15555550101', identity: 'operator-demo' };
  setup.repair.mockResolvedValue({ ok: true, result: 'ok', changes: ['Updated Voice URL on the TwiML App AP1.'] });
  await render();
  await settle();
  expect(container.querySelector('[aria-current="step"]').textContent).toBe('Connected');
  expect(text()).toContain('+1 555 555 0101');
  expect(text()).toContain('Saved in server/.env');
  await press('Check connection now');
  expect(text()).toContain('Repaired: Updated Voice URL on the TwiML App AP1.');
  expect(props.onRefresh).toHaveBeenCalled();
});

test('a public address supplied by this session is shown, not asked for, and not sent back', async () => {
  props.status = { ...props.status, publicBaseUrl: 'https://session.ngrok-free.app', publicBaseUrlSource: 'environment' };
  await render();
  expect(text()).toContain('https://session.ngrok-free.app');
  expect(text()).toContain('From this session');
  type('Account SID', SID);
  type('Auth Token', TOKEN);
  await press('Check account');
  expect(setup.check.mock.calls[0][0].publicBaseUrl).toBe('');
});

test('setup that cannot run says so and offers to try again', async () => {
  props.status = { ok: false, error: 'The local service is not answering (ECONNREFUSED).' };
  await render();
  expect(container.querySelector('[role="alert"]').textContent).toContain('not answering');
  await press('Try again');
  expect(props.onRefresh).toHaveBeenCalled();
});
