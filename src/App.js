import React, { useState, useEffect, useCallback } from 'react';
import { TwilioProvider, useTwilio } from './contexts/TwilioContext';
import { SmsProvider } from './contexts/SmsContext';
import { AccountConfig } from './components/AccountConfig/AccountConfig';
import { Dialpad } from './components/Dialpad/Dialpad';
import { CallControls } from './components/CallControls/CallControls';
import { CallScreen } from './components/CallScreen/CallScreen';
import { SmsPanel } from './components/SmsPanel/SmsPanel';
import './App.css';
import './components/SmsPanel/SmsPanel.css';

function StatusBar({ snapshot, accountSid }) {
  let label;
  let tone = 'idle';
  if (snapshot.error) {
    label = `Error: ${snapshot.error}`;
    tone = 'error';
  } else if (snapshot.currentCall) {
    label = `In call — ${snapshot.currentCall.status}`;
    tone = 'active';
  } else if (snapshot.incomingCall) {
    label = 'Incoming call';
    tone = 'ringing';
  } else if (snapshot.state === 'registered') {
    label = `Ready${accountSid ? '' : ' · account not configured'}`;
    tone = 'ready';
  } else if (snapshot.state === 'registering') {
    label = 'Connecting…';
    tone = 'busy';
  } else if (snapshot.state === 'offline' || snapshot.state === 'unregistered') {
    label = 'Offline';
    tone = 'idle';
  } else {
    label = snapshot.state || 'Idle';
    tone = 'idle';
  }
  return <div className={`status-bar ${tone}`}>{label}</div>;
}

function MainPanel() {
  const {
    snapshot,
    placeCall,
    hangup,
    acceptIncoming,
    rejectIncoming,
    toggleMute,
    sendDigits,
    register,
  } = useTwilio();

  const [number, setNumber] = useState('');
  const [configured, setConfigured] = useState(false);
  const [accountSid, setAccountSid] = useState(null);
  const [identity, setIdentity] = useState(null);

  // Check configured state on mount.
  useEffect(() => {
    (async () => {
      // Read whole config so we can sanity-check shape even if individual
      // key reads ever return a non-string.
      const cfg = await window.operator.config.get();
      const sid =
        cfg && typeof cfg === 'object' ? cfg.accountSid : cfg?.accountSid;
      const ident =
        cfg && typeof cfg === 'object' ? cfg.identity : cfg?.identity;
      const sidStr = typeof sid === 'string' ? sid : null;
      const identStr = typeof ident === 'string' ? ident : null;
      setAccountSid(sidStr);
      setIdentity(identStr);
      setConfigured(Boolean(sidStr && identStr));
    })();
  }, []);

  // When configured and we have identity, register the Device.
  useEffect(() => {
    if (configured && identity) {
      register(identity).catch((err) => {
        // Errors already surface in snapshot.error.
        console.warn('register failed:', err.message);
      });
    }
  }, [configured, identity, register]);

  // Send dialpad digits to an active call (in-call DTMF).
  useEffect(() => {
    if (snapshot.currentCall && snapshot.currentCall.status === 'connected') {
      // No-op: handled in onKeyPress below so digits only go out when tapped
      // during an active call. This effect is here in case future logic
      // needs to react to call-state changes.
    }
  }, [snapshot.currentCall]);

  const handleCall = useCallback(() => {
    if (!number) return;
    placeCall(number).catch((err) => {
      console.warn('placeCall failed:', err.message);
    });
  }, [number, placeCall]);

  const handleKeyPress = useCallback(
    (digit) => {
      if (snapshot.currentCall && snapshot.currentCall.status === 'connected') {
        sendDigits(digit);
      }
    },
    [snapshot.currentCall, sendDigits]
  );

  const handleConfigured = useCallback(() => {
    setConfigured(true);
  }, []);

  const handleCancelConfigure = useCallback(() => {
    // Go back to the dialer without re-saving. Used when the user opened
    // the form via "Reconfigure" but didn't want to change anything.
    setConfigured(true);
  }, []);

  const showCallScreen = snapshot.currentCall || snapshot.incomingCall;
  // 'voice' = dialer or call screen; 'messages' = sms panel.
  // An incoming or active call always wins — we route to call screen
  // even if the user is on the messages tab.
  const [view, setView] = useState('voice');
  const effectiveView = showCallScreen ? 'voice' : view;

  return (
    <div className="app">
      <header className="app-header">
        <h1>Operator</h1>
        <span className="subtitle">Twilio Softphone</span>
        {configured && accountSid && identity && (
          <nav className="app-tabs" aria-label="View">
            <button
              type="button"
              className={`app-tab${effectiveView === 'voice' ? ' active' : ''}`}
              onClick={() => setView('voice')}
            >
              Voice
            </button>
            <button
              type="button"
              className={`app-tab${effectiveView === 'messages' ? ' active' : ''}`}
              onClick={() => setView('messages')}
            >
              Messages
            </button>
          </nav>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="link"
          onClick={() => setConfigured(false)}
        >
          {configured ? 'Reconfigure' : 'Configure'}
        </button>
      </header>

      <StatusBar snapshot={snapshot} accountSid={accountSid} />

      <main className="app-main">
        {!configured || !accountSid || !identity ? (
          <AccountConfig
            onConfigured={handleConfigured}
            onCancel={
              // Only offer Cancel if there's already something saved —
              // otherwise Cancel is meaningless and Save is the only way out.
              accountSid && identity ? handleCancelConfigure : undefined
            }
          />
        ) : showCallScreen ? (
          <CallScreen
            call={
              snapshot.currentCall
                ? { ...snapshot.currentCall, direction: 'outgoing' }
                : { ...snapshot.incomingCall, direction: 'incoming' }
            }
            onHangup={hangup}
            onMute={toggleMute}
            onSendDigit={sendDigits}
            muted={
              (snapshot.currentCall || snapshot.incomingCall)?.muted || false
            }
          />
        ) : effectiveView === 'messages' ? (
          <SmsPanel />
        ) : (
          <div className="dialer">
            <Dialpad
              value={number}
              onChange={setNumber}
              onKeyPress={handleKeyPress}
              disabled={snapshot.state !== 'registered'}
            />
            <CallControls
              callState={
                snapshot.currentCall
                  ? snapshot.currentCall.status
                  : 'idle'
              }
              hasNumber={Boolean(number)}
              disabled={snapshot.state !== 'registered'}
              onCall={handleCall}
              onHangup={hangup}
              onMute={toggleMute}
              muted={snapshot.currentCall?.muted || false}
              incoming={Boolean(snapshot.incomingCall)}
              onAccept={acceptIncoming}
              onReject={rejectIncoming}
            />
            {snapshot.state !== 'registered' && (
              <p className="muted small">
                {snapshot.state === 'registering'
                  ? 'Connecting to Twilio…'
                  : snapshot.error
                  ? `Device error: ${snapshot.error}`
                  : 'Device is not ready.'}
              </p>
            )}
          </div>
        )}
      </main>

      <footer className="app-footer">
        <span className="muted small">
          {identity ? `Identity: ${identity}` : ''}
        </span>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <TwilioProvider>
      <SmsProvider>
        <MainPanel />
      </SmsProvider>
    </TwilioProvider>
  );
}
