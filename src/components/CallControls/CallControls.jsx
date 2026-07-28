import React from 'react';

export function CallControls({
  callState,
  onCall,
  onHangup,
  onMute,
  muted,
  onAccept,
  onReject,
  incoming,
  disabled,
  hasNumber,
}) {
  if (incoming) {
    return (
      <div className="call-controls incoming">
        <button
          type="button"
          className="accept"
          onClick={onAccept}
          disabled={disabled}
        >
          Accept
        </button>
        <button
          type="button"
          className="reject"
          onClick={onReject}
          disabled={disabled}
        >
          Reject
        </button>
      </div>
    );
  }

  const connected = callState === 'open' || callState === 'connected';

  if (
    connected ||
    callState === 'connecting' ||
    callState === 'ringing' ||
    callState === 'reconnecting'
  ) {
    return (
      <div className="call-controls active">
        <button
          type="button"
          className={muted ? 'mute on' : 'mute'}
          onClick={onMute}
          disabled={!connected}
        >
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          type="button"
          className="hangup"
          onClick={onHangup}
        >
          Hang up
        </button>
      </div>
    );
  }

  return (
    <div className="call-controls idle">
      <button
        type="button"
        className="call"
        onClick={onCall}
        disabled={disabled || !hasNumber}
      >
        Call
      </button>
    </div>
  );
}
