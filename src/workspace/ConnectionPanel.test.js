// TWP-14, accepted TWP-9 piece 1: the Connection view keeps the local
// service, tunnel, voice registration, SMS sender and Twilio account apart,
// and a missing tunnel leaves contacts and history usable while saying what
// needs it. Statuses have the shape main/services/session.js returns; the
// tunnel reason is the launcher's own explanation.

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionPanel, TunnelNotice, TUNNEL_LIMITS } from './ConnectionPanel';
import { EXPLANATIONS } from '../../launcher/ngrok';
import { TUNNEL_LIMITS as LAUNCHER_LIMITS } from '../../launcher/supervisor';

const SERVICE = 'http://127.0.0.1:5050';
const voice = { state: 'registered', error: null };
const sms = { hydrated: true, lastError: null, smsFrom: '+15555550100' };

let container;
let root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(ui) {
  act(() => root.render(ui));
  return container;
}

// The Connection view's rows as { label: value }.
function rows(el) {
  const out = {};
  el.querySelectorAll('dt').forEach((dt) => {
    out[dt.textContent] = dt.nextElementSibling.textContent;
  });
  return out;
}

test('every part of the connection has its own row', () => {
  const status = {
    ok: true,
    managed: true,
    service: { state: 'ready', url: SERVICE, detail: null },
    tunnel: { state: 'ready', url: 'https://fictional-dev-domain.ngrok-free.app', reason: null },
  };
  const el = render(<ConnectionPanel status={status} voice={voice} sms={sms} />);
  expect(rows(el)).toEqual({
    'Local service': `Answering at ${SERVICE}`,
    'Public tunnel': 'https://fictional-dev-domain.ngrok-free.app, reaches the local service',
    'Twilio account': 'Checking…',
    'Voice registration': 'registered',
    'Incoming calls': 'Not checked yet. Open Twilio account and choose Check connection now.',
    'Incoming texts': 'Not checked yet. Open Twilio account and choose Check connection now.',
    'Delivery callback': 'No public address: delivery updates for texts you send will not arrive.',
    'Message updates': 'Connected to the local service',
    'SMS sender': '+1 555 555 0100',
    'Photo (MMS) sender': 'Not checked yet.',
  });
});

// TWP-9 piece 2: the Connection view keeps the account, incoming voice,
// incoming texts, delivery callback and photo capability apart, from what the
// setup service last verified (setup:status), so one failure never reads as
// another.
const SETUP = {
  ok: true,
  credentials: true,
  accountSid: 'AC' + '1'.repeat(32),
  connection: {
    checkedAt: Date.UTC(2026, 9, 24, 3, 0),
    account: { state: 'ok', detail: null },
    voice: { state: 'operator', description: 'Operator' },
    sms: { state: 'foreign', description: 'https://elsewhere.example/sms' },
    callback: { state: 'ready', url: 'https://fictional-dev-domain.ngrok-free.app/sms/status' },
    mms: 'yes',
  },
};

test('the account, each incoming route, the delivery callback and photo capability each have their own row', () => {
  const panel = rows(render(<ConnectionPanel status={null} voice={voice} sms={sms} setup={SETUP} />));
  expect(panel['Twilio account']).toMatch(/^Connected \(AC1{32}\)\. Last checked /);
  expect(panel['Incoming calls']).toBe('Goes to Operator');
  expect(panel['Incoming texts']).toBe('Goes to https://elsewhere.example/sms, not Operator: texts will not reach this app.');
  expect(panel['Delivery callback']).toBe('https://fictional-dev-domain.ngrok-free.app/sms/status');
  expect(panel['Photo (MMS) sender']).toBe('This number can send photos.');
});

test.each([
  ['invalid-credentials', /^Twilio did not accept the saved Account SID and Auth Token/],
  ['unreachable', /^Twilio could not be reached at the last check; nothing was changed\./],
])('an account that is %s is described as that, and as a problem', (state, text) => {
  const setup = { ...SETUP, connection: { ...SETUP.connection, account: { state, detail: null } } };
  expect(rows(render(<ConnectionPanel status={null} voice={voice} sms={sms} setup={setup} />))['Twilio account']).toMatch(text);
});

test('credentials that were never entered read as not connected', () => {
  const setup = { ok: true, credentials: false, connection: { account: { state: 'unchecked' } } };
  expect(rows(render(<ConnectionPanel status={null} voice={voice} sms={sms} setup={setup} />))['Twilio account']).toBe(
    'Not connected. Open Twilio account to connect it.'
  );
});

test('a tunnel that could not start is explained beside a working service, with what still works', () => {
  const status = {
    ok: true,
    managed: true,
    service: { state: 'ready', url: SERVICE, detail: null },
    tunnel: { state: 'unavailable', url: null, reason: EXPLANATIONS.ERR_NGROK_4018 },
  };
  const panel = rows(render(<ConnectionPanel status={status} voice={voice} sms={sms} />));
  expect(panel['Local service']).toBe(`Answering at ${SERVICE}`);
  expect(panel['Public tunnel']).toBe(`Unavailable. ${EXPLANATIONS.ERR_NGROK_4018}${TUNNEL_LIMITS}`);

  const notice = render(<TunnelNotice status={status} />).querySelector('[role="status"]');
  expect(notice.textContent).toBe(`The public tunnel is unavailable. ${EXPLANATIONS.ERR_NGROK_4018}${TUNNEL_LIMITS}`);
  // The app and the terminal describe the same limits.
  expect(TUNNEL_LIMITS).toBe(LAUNCHER_LIMITS);
});

test('a ready tunnel, or a window not started by npm run phone, shows no notice', () => {
  const ready = { ok: true, managed: true, service: { state: 'ready', url: SERVICE }, tunnel: { state: 'ready', url: 'https://x.ngrok-free.app' } };
  expect(render(<TunnelNotice status={ready} />).textContent).toBe('');
  const unmanaged = { ok: true, managed: false, service: { state: 'ready', url: SERVICE }, tunnel: { state: 'unmanaged', url: null, reason: null } };
  expect(render(<TunnelNotice status={unmanaged} />).textContent).toBe('');
  expect(rows(render(<ConnectionPanel status={unmanaged} voice={voice} sms={sms} />))['Public tunnel']).toBe(
    'Not checked: this window was not started with npm run phone.'
  );
});

test('a service that does not answer is reported as such, not as a tunnel problem', () => {
  const status = {
    ok: true,
    managed: true,
    service: { state: 'unavailable', url: SERVICE, detail: 'connect ECONNREFUSED 127.0.0.1:5050' },
    tunnel: { state: 'ready', url: 'https://fictional-dev-domain.ngrok-free.app', reason: null },
  };
  const panel = rows(render(<ConnectionPanel status={status} voice={voice} sms={sms} />));
  expect(panel['Local service']).toBe(
    `Not answering at ${SERVICE} (connect ECONNREFUSED 127.0.0.1:5050). Messages and calls need it.`
  );
  expect(panel['Public tunnel']).toBe('https://fictional-dev-domain.ngrok-free.app, reaches the local service');
});
