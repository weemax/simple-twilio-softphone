import React, { useEffect, useState } from 'react';

const LABELS = {
  idle: 'Idle',
  pending: 'Connecting…',
  connecting: 'Connecting…',
  ringing: 'Ringing…',
  // Twilio's Voice SDK reports an active call as 'open'.
  open: 'Connected',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
  disconnected: 'Disconnected',
  busy: 'Busy',
  failed: 'Failed',
};

// Twilio Call.status() values that mean the call is live and can accept DTMF.
function isConnected(status) {
  return status === 'open' || status === 'connected';
}

// In-call DTMF keypad layout (no letters — this is for sending tones, not dialing).
const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function useDuration(startedAt, active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active || !startedAt) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);
  if (!active || !startedAt) return null;
  return Math.floor((now - startedAt) / 1000);
}

export function CallScreen({ call, onHangup, onMute, muted, onSendDigit }) {
  const duration = useDuration(call?.startedAt, isConnected(call?.status));
  const [showKeypad, setShowKeypad] = useState(true);
  // Local echo of digits the operator has sent, so they get visual feedback
  // (the audio tones go to the call, not the UI).
  const [sentDigits, setSentDigits] = useState('');

  const connected = isConnected(call?.status);

  // Reset the sent-digit echo whenever a new call starts.
  useEffect(() => {
    setSentDigits('');
  }, [call?.startedAt]);

  if (!call) {
    return (
      <div className="call-screen idle">
        <div className="muted">No active call</div>
      </div>
    );
  }

  const other =
    call.direction === 'outgoing' ? call.to : call.from;

  function pressDigit(d) {
    if (onSendDigit) onSendDigit(d);
    // Keep the echo bounded so a long IVR session doesn't overflow the display.
    setSentDigits((prev) => (prev + d).slice(-32));
  }

  return (
    <div className={`call-screen ${call.status}`}>
      <div className="direction">
        {call.direction === 'outgoing' ? 'Calling…' : 'Incoming'}
      </div>
      <div className="number">{other || '—'}</div>
      <div className="status">
        {LABELS[call.status] || call.status}
        {connected && duration != null && (
          <span className="duration"> · {formatDuration(duration)}</span>
        )}
      </div>

      {connected && showKeypad && (
        <div className="dtmf">
          <div className="dtmf-sent" aria-live="polite">
            {sentDigits || <span className="placeholder">Tap to send tones</span>}
          </div>
          <div className="dtmf-keys">
            {DTMF_KEYS.map((d) => (
              <button
                key={d}
                type="button"
                className="dtmf-key"
                onClick={() => pressDigit(d)}
                aria-label={`Send ${d}`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="actions">
        {connected && (
          <button
            type="button"
            className={showKeypad ? 'keypad on' : 'keypad'}
            onClick={() => setShowKeypad((v) => !v)}
          >
            {showKeypad ? 'Hide keypad' : 'Keypad'}
          </button>
        )}
        {connected && (
          <button
            type="button"
            className={muted ? 'mute on' : 'mute'}
            onClick={onMute}
          >
            {muted ? 'Unmute' : 'Mute'}
          </button>
        )}
        <button type="button" className="hangup" onClick={onHangup}>
          Hang up
        </button>
      </div>
    </div>
  );
}
