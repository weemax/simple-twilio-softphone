import React from 'react';
import { formatNumber } from '../formatNumber';

// What works without the public tunnel and what needs it (TWP-9 piece 1).
export const TUNNEL_LIMITS =
  'Calls, incoming texts and delivery updates need the tunnel; contacts, message history and sending texts still work.';

const PROBLEM_STATES = new Set(['unreachable', 'unavailable', 'lost']);

// The local service, in a short form for the status strip and a sentence
// for the Connection view.
export function serviceSummary(status) {
  if (!status) return { short: 'checking', text: 'Checking…' };
  if (status.unsupported || status.error) {
    return { short: 'not checked', text: 'Not checked by this window.' };
  }
  const s = status.service || {};
  if (s.state === 'ready') {
    return { short: 'ready', text: `Answering at ${s.url}` };
  }
  if (s.state === 'other') {
    return {
      short: 'not this launch',
      text: `Another program is answering at ${s.url}, not the service npm run phone started.`,
    };
  }
  return {
    short: 'not answering',
    text: `Not answering at ${s.url}${s.detail ? ` (${s.detail})` : ''}. Messages and calls need it.`,
  };
}

// The public tunnel, kept apart from the local service.
export function tunnelSummary(status) {
  if (!status) return { short: 'checking', text: 'Checking…' };
  if (status.unsupported || status.error || !status.tunnel) {
    return { short: 'not checked', text: 'Not checked by this window.' };
  }
  const t = status.tunnel;
  switch (t.state) {
    case 'ready':
      return { short: 'ready', text: `${t.url}, reaches the local service` };
    case 'unmanaged':
      return {
        short: 'not checked',
        text: 'Not checked: this window was not started with npm run phone.',
      };
    case 'unreachable':
      return { short: 'not reachable', text: `${t.url} is not reachable. ${t.reason || ''}`.trim(), problem: true };
    case 'lost':
      return { short: 'stopped', text: `Stopped. ${t.reason || ''}`.trim(), problem: true };
    case 'unavailable':
      return { short: 'unavailable', text: `Unavailable. ${t.reason || ''}`.trim(), problem: true };
    default:
      return { short: 'starting', text: t.url ? `Checking ${t.url}…` : 'Starting…' };
  }
}

// Shown above every section while npm run phone has no working tunnel.
export function TunnelNotice({ status }) {
  const tunnel = status && status.tunnel;
  if (!tunnel || !PROBLEM_STATES.has(tunnel.state)) return null;
  const heading =
    tunnel.state === 'lost'
      ? 'The public tunnel stopped.'
      : tunnel.state === 'unreachable'
        ? 'The public tunnel is not reachable.'
        : 'The public tunnel is unavailable.';
  return (
    <div className="notice" role="status">
      <strong>{heading}</strong> {tunnel.reason}
      <div className="small">{TUNNEL_LIMITS}</div>
    </div>
  );
}

// What the setup service last learned about the Twilio account, kept apart
// from the local service and the tunnel. `setup` is the answer of
// setup:status (never a secret); null while it is loading.
export function accountSummary(setup) {
  if (!setup) return { short: 'checking', text: 'Checking…' };
  if (setup.ok === false) return { short: 'not checked', text: 'Not checked: the setup service did not answer.' };
  if (!setup.credentials) return { short: 'not connected', text: 'Not connected. Open Twilio account to connect it.' };
  const c = setup.connection || {};
  const state = (c.account && c.account.state) || 'unchecked';
  const when = c.checkedAt ? ` Last checked ${new Date(c.checkedAt).toLocaleString()}.` : '';
  if (state === 'ok') return { short: 'connected', text: `Connected (${setup.accountSid}).${when}` };
  if (state === 'invalid-credentials') {
    return { short: 'sign-in rejected', text: `Twilio did not accept the saved Account SID and Auth Token. Open Twilio account to update them.${when}`, problem: true };
  }
  if (state === 'unreachable') {
    return { short: 'not reachable', text: `Twilio could not be reached at the last check; nothing was changed.${when}`, problem: true };
  }
  if (state === 'error') {
    return { short: 'check failed', text: `The last check did not finish: ${(c.account && c.account.detail) || 'unknown reason'}.${when}`, problem: true };
  }
  return { short: 'saved', text: `Credentials saved (${setup.accountSid}); not checked yet. Open Twilio account and choose Check connection now.` };
}

function routeSummary(route, noun) {
  if (!route) return 'Not checked yet. Open Twilio account and choose Check connection now.';
  if (route.state === 'operator') return 'Goes to Operator';
  if (route.state === 'blank') return `Not set: ${noun} will not reach this app.`;
  if (route.state === 'unavailable') return `Not available on the chosen number.`;
  if (route.state === 'stale') return 'Goes to an Operator application that no longer exists.';
  return `Goes to ${route.description}, not Operator: ${noun} will not reach this app.`;
}

export function ConnectionPanel({ status, voice, sms, setup }) {
  const service = serviceSummary(status);
  const tunnel = tunnelSummary(status);
  const account = accountSummary(setup);
  const conn = (setup && setup.connection) || {};
  const callback = conn.callback;
  const mms = conn.mms;
  return (
    <div className="panel">
      <h3>Connection</h3>
      <dl className="connection-list">
        <dt>Local service</dt>
        <dd>{service.text}</dd>
        <dt>Public tunnel</dt>
        <dd>
          {tunnel.text}
          {tunnel.problem && <div className="muted small">{TUNNEL_LIMITS}</div>}
        </dd>
        <dt>Twilio account</dt>
        <dd>{account.text}</dd>
        <dt>Voice registration</dt>
        <dd>{voice.state}</dd>
        <dt>Incoming calls</dt>
        <dd>{routeSummary(conn.voice, 'calls')}</dd>
        <dt>Incoming texts</dt>
        <dd>{routeSummary(conn.sms, 'texts')}</dd>
        <dt>Delivery callback</dt>
        <dd>
          {callback && callback.state === 'ready'
            ? callback.url
            : 'No public address: delivery updates for texts you send will not arrive.'}
        </dd>
        <dt>Message updates</dt>
        <dd>
          {sms.lastError ||
            (sms.hydrated ? 'Connected to the local service' : 'Loading')}
        </dd>
        <dt>SMS sender</dt>
        <dd>{formatNumber(sms.smsFrom || sms.callerId) || 'Not configured'}</dd>
        <dt>Photo (MMS) sender</dt>
        <dd>
          {mms === 'yes'
            ? 'This number can send photos.'
            : mms === 'no'
              ? 'This number cannot send photos.'
              : 'Not checked yet.'}
        </dd>
      </dl>
      {voice.error && <p className="error">{voice.error}</p>}
    </div>
  );
}
