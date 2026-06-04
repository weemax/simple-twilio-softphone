import React, { useEffect, useState } from 'react';

const LABELS = {
  idle: 'Idle',
  connecting: 'Connecting…',
  ringing: 'Ringing…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  busy: 'Busy',
  failed: 'Failed',
};

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

export function CallScreen({ call, onHangup, onMute, muted }) {
  const duration = useDuration(call?.startedAt, call?.status === 'connected');

  if (!call) {
    return (
      <div className="call-screen idle">
        <div className="muted">No active call</div>
      </div>
    );
  }

  const other =
    call.direction === 'outgoing' ? call.to : call.from;

  return (
    <div className={`call-screen ${call.status}`}>
      <div className="direction">
        {call.direction === 'outgoing' ? 'Calling…' : 'Incoming'}
      </div>
      <div className="number">{other || '—'}</div>
      <div className="status">
        {LABELS[call.status] || call.status}
        {call.status === 'connected' && duration != null && (
          <span className="duration"> · {formatDuration(duration)}</span>
        )}
      </div>

      <div className="actions">
        {call.status === 'connected' && (
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
