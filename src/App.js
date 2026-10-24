import React, { useState, useEffect, useCallback } from 'react';
import { TwilioProvider, useTwilio } from './contexts/TwilioContext';
import { SmsProvider, useSms } from './contexts/SmsContext';
import { WorkspaceProvider, useWorkspace } from './workspace/WorkspaceContext';
import { normalizePhone, unreadCount } from './workspace/model';
import { Contacts } from './workspace/Contacts';
import { ConfirmDialog } from './workspace/ConfirmDialog';
import {
  ConnectionPanel,
  TunnelNotice,
  serviceSummary,
  tunnelSummary,
} from './workspace/ConnectionPanel';
import { useSessionStatus } from './workspace/useSessionStatus';
import { formatNumber } from './formatNumber';
import { TwilioSetup } from './setup/TwilioSetup';
import { useSetupStatus } from './setup/useSetupStatus';
import { Dialpad } from './components/Dialpad/Dialpad';
import { CallScreen } from './components/CallScreen/CallScreen';
import { SmsPanel } from './components/SmsPanel/SmsPanel';
import './App.css';
import './components/SmsPanel/SmsPanel.css';
import './workspace/Workspace.css';

function MainPanel() {
  const voice = useTwilio(),
    { snapshot: sms } = useSms();
  const { data, update, ready, saveError, nameFor } = useWorkspace();
  const { snapshot, placeCall, register } = voice;
  const session = useSessionStatus();
  const { status: setup, refresh: refreshSetup } = useSetupStatus();
  const [config, setConfig] = useState(null),
    [number, setNumber] = useState(''),
    [callsView, setCallsView] = useState('dialer');
  const [confirmation, setConfirmation] = useState(null),
    [callError, setCallError] = useState(''),
    [calling, setCalling] = useState(false),
    [settingsView, setSettingsView] = useState('connection');
  const readConfig = useCallback(async () => {
    try {
      const cfg = await window.operator.config.get();
      setConfig(cfg || {});
    } catch (_) {
      setConfig({});
    }
  }, []);
  useEffect(() => {
    readConfig();
  }, [readConfig]);
  // One identity for registering and for incoming calls: the one the setup
  // saved in server/.env, else the one an earlier version saved in the app's
  // own settings.
  const savedIdentity =
    typeof config?.identity === 'string' ? config.identity : '';
  const identity = (setup && setup.ok !== false && setup.identity) || savedIdentity;
  const configured = Boolean(setup && setup.ok !== false && setup.credentials && identity);
  useEffect(() => {
    if (configured) register(identity).catch(() => {});
  }, [configured, identity, register]);
  // An unconnected first launch opens Settings → Twilio account, once;
  // every other launch keeps the section the person last used.
  const [openedSetup, setOpenedSetup] = useState(false);
  useEffect(() => {
    if (openedSetup || !ready || !setup || setup.ok === false) return;
    setOpenedSetup(true);
    if (!setup.credentials) {
      setSettingsView('account');
      update((d) => ({ ...d, view: 'settings' }));
    }
  }, [openedSetup, ready, setup, update]);
  // A replaced key or a new identity needs a fresh registration, but never
  // in the middle of a call: re-registering would end it. The first
  // connection registers through the effect above once its status arrives.
  const reRegister = useCallback(
    (next) => {
      const id = (next && next.ok !== false && next.identity) || identity;
      const busy = snapshot.currentCall || snapshot.incomingCall || snapshot.connecting;
      if (configured && id && !busy) register(id).catch(() => {});
    },
    [configured, identity, register, snapshot.currentCall, snapshot.incomingCall, snapshot.connecting],
  );
  useEffect(() => {
    if (!ready || !snapshot.lastCall) return;
    update((d) =>
      d.recentCalls.some((c) => c.id === snapshot.lastCall.id)
        ? d
        : { ...d, recentCalls: [snapshot.lastCall, ...d.recentCalls] },
    );
  }, [snapshot.lastCall, ready, update]);
  const navigate = useCallback(
    (view) => update((d) => ({ ...d, view })),
    [update],
  );
  const openText = useCallback(
    (number) =>
      update((d) => ({
        ...d,
        view: 'messages',
        selected: number,
        archived: { ...d.archived, [number]: false },
      })),
    [update],
  );
  useEffect(
    () =>
      window.operator?.on?.('sms:open', (payload) => {
        const n = normalizePhone(payload?.number);
        if (n) openText(n);
      }),
    [openText],
  );
  const requestCall = useCallback(
    (value) => {
      const n =
        normalizePhone(value) ||
        (/^[a-z][a-z0-9_-]{0,63}$/i.test(value) ? value : null);
      if (!n) {
        setCallError(
          'Include + and the country code, or enter a Client identity.',
        );
        return;
      }
      setCallError('');
      setConfirmation({ number: n, name: nameFor(n) });
    },
    [nameFor],
  );
  async function confirmCall() {
    if (
      !confirmation ||
      calling ||
      snapshot.connecting ||
      snapshot.currentCall ||
      snapshot.incomingCall
    )
      return;
    setCalling(true);
    setCallError('');
    const destination = confirmation.number;
    setConfirmation(null);
    try {
      await placeCall(destination);
    } catch (e) {
      setCallError(e.message || 'The call could not start.');
    } finally {
      setCalling(false);
    }
  }
  if (!ready || !config)
    return (
      <div className="app">
        <p role="status">Opening your workspace…</p>
        {saveError && <p role="alert">{saveError}</p>}
      </div>
    );
  const view = ['messages', 'calls', 'contacts', 'settings'].includes(data.view)
    ? data.view
    : 'messages';
  const activeCall = snapshot.currentCall || snapshot.incomingCall;
  const pendingIncoming =
    !snapshot.currentCall && Boolean(snapshot.incomingCall);
  const direction =
    String(activeCall?.direction || '').toUpperCase() === 'INCOMING'
      ? 'incoming'
      : 'outgoing';
  const other = direction === 'incoming' ? activeCall?.from : activeCall?.to;
  const blocked =
    snapshot.state !== 'registered' ||
    Boolean(activeCall) ||
    snapshot.connecting ||
    calling;
  const unread = data.seeded
    ? (sms.conversations || []).reduce((n, c) => n + unreadCount(c, data), 0)
    : 0;
  return (
    <div className="app workspace-app">
      <header className="app-header">
        <h1>Operator</h1>
        <span className="subtitle">Twilio Softphone</span>
        <span className="spacer" />
        {sms.smsFrom && (
          <span className="muted small">
            Your number {formatNumber(sms.smsFrom)}
          </span>
        )}
      </header>
      <div className="status-bar" role="status">
        <span>Service: {serviceSummary(session).short}</span>
        <span>Tunnel: {tunnelSummary(session).short}</span>
        <span>
          Voice: {snapshot.connecting ? 'connecting call' : snapshot.state}
        </span>
        <span>
          Messages:{' '}
          {sms.lastError
            ? 'updates unavailable'
            : sms.hydrated
              ? 'connected'
              : 'loading'}
        </span>
        {!configured && <span>Account needs configuration</span>}
      </div>
      {saveError && (
        <p className="alert" role="alert">
          {saveError}
        </p>
      )}
      <TunnelNotice status={session} />
      <div className="workspace-layout">
        <nav className="workspace-nav" aria-label="Main navigation">
          {['messages', 'calls', 'contacts', 'settings'].map((v) => (
            <button
              key={v}
              type="button"
              aria-current={view === v ? 'page' : undefined}
              className={view === v ? 'active' : ''}
              onClick={() => navigate(v)}
            >
              {v[0].toUpperCase() + v.slice(1)}
              {v === 'messages' && unread > 0 && (
                <span
                  className="badge"
                  aria-label={`${unread} unread messages`}
                >
                  {unread}
                </span>
              )}
              {v === 'settings' && !configured && (
                <span className="badge">!</span>
              )}
            </button>
          ))}
        </nav>
        <main className="app-main workspace-main">
          {callError && (
            <p className="alert" role="alert">
              {callError}
            </p>
          )}
          <div className="messages-view" hidden={view !== 'messages'}>
            <SmsPanel
              active={view === 'messages' && !pendingIncoming}
              onCall={requestCall}
            />
          </div>
          <div hidden={view !== 'contacts'}>
            <Contacts onText={openText} onCall={requestCall} />
          </div>
          <section
            className="workspace-page calls-page"
            hidden={view !== 'calls'}
            aria-label="Calls"
          >
            <h2>Calls</h2>
            <div className="button-row subnav">
              {['dialer', 'recents'].map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={callsView === v}
                  className={callsView === v ? 'active' : ''}
                  onClick={() => setCallsView(v)}
                >
                  {v === 'dialer' ? 'Dialer' : 'Recents'}
                </button>
              ))}
            </div>
            <div className="dialer" hidden={callsView !== 'dialer'}>
              <Dialpad
                value={number}
                onChange={setNumber}
                disabled={Boolean(activeCall) || calling}
              />
              <button
                type="button"
                className="primary dial-call"
                onClick={() => requestCall(number)}
                disabled={!number.trim()}
              >
                Review call
              </button>
              {snapshot.state !== 'registered' && (
                <p className="muted small">
                  Calling is unavailable until the voice device registers. You
                  can still use contacts and stored messages.
                </p>
              )}
            </div>
            <div hidden={callsView !== 'recents'}>
              <p className="muted small">
                Only calls observed by this app appear here, not calls missed
                while it was closed.
              </p>
              {!data.recentCalls.length && <p>No recent calls yet.</p>}
              {data.recentCalls.map((c) => (
                <article className="panel recent-call" key={c.id}>
                  <div>
                    <strong>
                      {nameFor(c.number) || formatNumber(c.number)}
                    </strong>
                    {nameFor(c.number) && (
                      <div className="muted small">
                        {formatNumber(c.number)}
                      </div>
                    )}
                    <p>
                      {c.direction} · {c.outcome} ·{' '}
                      {new Date(c.at).toLocaleString()}
                      {c.duration ? ` · ${c.duration}s` : ''}
                    </p>
                  </div>
                  <div className="button-row">
                    <button type="button" onClick={() => requestCall(c.number)}>
                      Call
                    </button>
                    {normalizePhone(c.number) && (
                      <button type="button" onClick={() => openText(c.number)}>
                        Text
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
          <section
            className="workspace-page"
            hidden={view !== 'settings'}
            aria-label="Settings"
          >
            <h2>Settings</h2>
            <div className="button-row subnav">
              <button
                type="button"
                aria-pressed={settingsView === 'connection'}
                onClick={() => setSettingsView('connection')}
              >
                Connection
              </button>
              <button
                type="button"
                aria-pressed={settingsView === 'account'}
                onClick={() => setSettingsView('account')}
              >
                Twilio account
              </button>
            </div>
            <div hidden={settingsView !== 'connection'}>
              <ConnectionPanel
                status={session}
                voice={snapshot}
                sms={sms}
                setup={setup}
              />
            </div>
            <div hidden={settingsView !== 'account'}>
              <TwilioSetup
                status={setup}
                fallbackIdentity={savedIdentity}
                onRefresh={refreshSetup}
                onConnected={reRegister}
              />
            </div>
          </section>
        </main>
      </div>
      {activeCall && (
        <aside
          className="call-overlay"
          aria-label={pendingIncoming ? 'Incoming call' : 'Active call'}
        >
          {nameFor(other) && (
            <h2 className="call-contact-name">{nameFor(other)}</h2>
          )}
          <CallScreen
            call={{ ...activeCall, direction }}
            incoming={pendingIncoming}
            onAccept={voice.acceptIncoming}
            onReject={voice.rejectIncoming}
            onHangup={voice.hangup}
            onMute={voice.toggleMute}
            onSendDigit={voice.sendDigits}
            muted={activeCall.muted}
          />
        </aside>
      )}
      {confirmation && (
        <ConfirmDialog
          title="Confirm call destination"
          confirmLabel={calling ? 'Calling…' : 'Call now'}
          onCancel={() => setConfirmation(null)}
          onConfirm={confirmCall}
          disabled={blocked}
        >
          <p>
            {confirmation.name && (
              <strong>
                {confirmation.name}
                <br />
              </strong>
            )}
            {formatNumber(confirmation.number)}
          </p>
          {blocked && (
            <p className="muted">
              Calling is unavailable while offline or another call is in
              progress.
            </p>
          )}
        </ConfirmDialog>
      )}
      <footer className="app-footer">
        {identity && <span>Identity: {identity}</span>}
        {(sms.smsFrom || sms.callerId) && (
          <span> · Number: {formatNumber(sms.smsFrom || sms.callerId)}</span>
        )}
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <TwilioProvider>
      <SmsProvider>
        <WorkspaceProvider>
          <MainPanel />
        </WorkspaceProvider>
      </SmsProvider>
    </TwilioProvider>
  );
}
