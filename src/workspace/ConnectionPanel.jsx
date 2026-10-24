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

export function ConnectionPanel({ status, voice, sms, configured }) {
  const service = serviceSummary(status);
  const tunnel = tunnelSummary(status);
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
        <dt>Voice registration</dt>
        <dd>{voice.state}</dd>
        <dt>Message updates</dt>
        <dd>
          {sms.lastError ||
            (sms.hydrated ? 'Connected to the local service' : 'Loading')}
        </dd>
        <dt>SMS sender</dt>
        <dd>{formatNumber(sms.smsFrom || sms.callerId) || 'Not configured'}</dd>
        <dt>Twilio account</dt>
        <dd>
          {configured
            ? 'Saved locally; provider setup remains manual'
            : 'Not configured'}
        </dd>
      </dl>
      {voice.error && <p className="error">{voice.error}</p>}
    </div>
  );
}
