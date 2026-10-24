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
  const el = render(<ConnectionPanel status={status} voice={voice} sms={sms} configured />);
  expect(rows(el)).toEqual({
    'Local service': `Answering at ${SERVICE}`,
    'Public tunnel': 'https://fictional-dev-domain.ngrok-free.app, reaches the local service',
    'Voice registration': 'registered',
    'Message updates': 'Connected to the local service',
    'SMS sender': '+1 555 555 0100',
    'Twilio account': 'Saved locally; provider setup remains manual',
  });
});

test('a tunnel that could not start is explained beside a working service, with what still works', () => {
  const status = {
    ok: true,
    managed: true,
    service: { state: 'ready', url: SERVICE, detail: null },
    tunnel: { state: 'unavailable', url: null, reason: EXPLANATIONS.ERR_NGROK_4018 },
  };
  const panel = rows(render(<ConnectionPanel status={status} voice={voice} sms={sms} configured />));
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
  expect(rows(render(<ConnectionPanel status={unmanaged} voice={voice} sms={sms} configured={false} />))['Public tunnel']).toBe(
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
  const panel = rows(render(<ConnectionPanel status={status} voice={voice} sms={sms} configured />));
  expect(panel['Local service']).toBe(
    `Not answering at ${SERVICE} (connect ECONNREFUSED 127.0.0.1:5050). Messages and calls need it.`
  );
  expect(panel['Public tunnel']).toBe('https://fictional-dev-domain.ngrok-free.app, reaches the local service');
});
