// Twilio Voice SDK wrapper.
//
// Responsibilities:
//   1. Create and manage a `Device` from @twilio/voice-sdk.
//   2. Fetch a capability token from the main process (which signs it
//      server-side; the renderer never sees Twilio Auth Tokens).
//   3. Expose a small event-style API to React.
//
// The Device is the long-lived WebRTC connection. Calls come and go.

import { Device } from '@twilio/voice-sdk';

// The Voice SDK plays a local "dialtone" feedback tone through the
// AudioContext's default output every time sendDigits() is called — full-volume
// sine waves on the laptop speakers, independent of the call's audio sink, loud
// enough to be jarring. We replace each DTMF sound with our own quiet, short
// dual-tone clip so the operator still gets familiar phone-key feedback without
// the blast. (The actual DTMF is transmitted to the far end via RTCDTMFSender
// regardless of this local sound.) See @twilio/voice-sdk call.js sendDigits().
const DTMF_FEEDBACK_SOUNDS = (() => {
  const sampleRate = 8000;
  const durationSec = 0.09;
  const amplitude = 0.06; // per-tone; the two tones sum to ~0.12 — deliberately quiet.
  const fadeSec = 0.008; // short fade in/out to avoid clicks.

  // Standard DTMF row/column frequency pairs, keyed by the SDK's sound names.
  const TONE_PAIRS = {
    dtmf1: [697, 1209], dtmf2: [697, 1336], dtmf3: [697, 1477],
    dtmf4: [770, 1209], dtmf5: [770, 1336], dtmf6: [770, 1477],
    dtmf7: [852, 1209], dtmf8: [852, 1336], dtmf9: [852, 1477],
    dtmfs: [941, 1209], dtmf0: [941, 1336], dtmfh: [941, 1477],
  };

  function toneDataUri([f1, f2]) {
    const numSamples = Math.floor(sampleRate * durationSec);
    const fadeSamples = Math.max(1, Math.floor(sampleRate * fadeSec));
    const dataBytes = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i += 1) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); // PCM fmt chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);
    for (let i = 0; i < numSamples; i += 1) {
      const t = i / sampleRate;
      let env = 1;
      if (i < fadeSamples) env = i / fadeSamples;
      else if (i > numSamples - fadeSamples) env = (numSamples - i) / fadeSamples;
      const sample =
        amplitude *
        env *
        (Math.sin(2 * Math.PI * f1 * t) + Math.sin(2 * Math.PI * f2 * t));
      // Clamp to [-1, 1] then scale to signed 16-bit.
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
    }
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return `data:audio/wav;base64,${btoa(binary)}`;
  }

  return Object.keys(TONE_PAIRS).reduce((acc, name) => {
    acc[name] = toneDataUri(TONE_PAIRS[name]);
    return acc;
  }, {});
})();

const STATE = {
  IDLE: 'idle',
  REGISTERING: 'registering',
  READY: 'ready',
  BUSY: 'busy',
  OFFLINE: 'offline',
  ERROR: 'error',
};

export class TwilioService {
  constructor() {
    this.device = null;
    this.currentCall = null;
    this.identity = null;
    this.listeners = new Set();
    this._emit();
  }

  // --- pub/sub for React ---
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    const snapshot = this.snapshot();
    this.listeners.forEach((fn) => fn(snapshot));
  }

  snapshot() {
    return {
      state: this.device?.state || STATE.IDLE,
      identity: this.identity,
      currentCall: this.currentCall
        ? this._callSnapshot(this.currentCall)
        : null,
      incomingCall: this.incomingCall
        ? this._callSnapshot(this.incomingCall)
        : null,
      error: this.lastError || null,
    };
  }

  _callSnapshot(call) {
    return {
      sid: call.parameters?.CallSid || null,
      to: call.parameters?.To || null,
      from: call.parameters?.From || null,
      direction: call.direction,
      status: call.status(),
      hasEarlyMedia: call.__hasEarlyMedia ?? null,
      muted: call.isMuted(),
      startedAt: call.__startedAt || null,
    };
  }

  // --- lifecycle ---

  async register(identity) {
    this.identity = identity;
    this.lastError = null;
    this._emit();

    // Fetch a capability JWT from the main process.
    const result = await window.operator.token.fetch(identity);
    if (!result.ok) {
      this.lastError = result.error || 'token fetch failed';
      this._emit();
      throw new Error(this.lastError);
    }

    // Destroy any existing device before creating a new one.
    if (this.device) {
      try {
        await this.device.destroy();
      } catch (_) {}
      this.device = null;
    }

    const device = new Device(result.token, {
      logLevel: 'warn',
      codecPreferences: ['opus', 'pcmu'],
      // Allow the user to answer/reject incoming calls from the UI.
      allowIncomingWhileBusy: false,
      // Replace the loud local DTMF feedback with quiet tones (see
      // DTMF_FEEDBACK_SOUNDS).
      sounds: DTMF_FEEDBACK_SOUNDS,
    });

    device.on('registered', () => this._emit());
    device.on('unregistered', () => this._emit());
    device.on('error', (err) => {
      this.lastError = err.message || String(err);
      this._emit();
    });
    device.on('incoming', (call) => this._onIncoming(call));
    device.on('tokenWillExpire', () => this._refreshToken());
    device.on('tokenExpired', () => this._refreshToken());

    this.device = device;
    this._emit();

    try {
      await device.register();
    } catch (err) {
      this.lastError = err.message || String(err);
      this._emit();
      throw err;
    }
  }

  async _refreshToken() {
    if (!this.identity) return;
    try {
      const result = await window.operator.token.fetch(this.identity);
      if (result.ok && this.device) {
        this.device.updateToken(result.token);
      }
    } catch (err) {
      this.lastError = `token refresh failed: ${err.message}`;
      this._emit();
    }
  }

  _watchCallState(call) {
    if (call.__twilioServiceStateListenersAttached) return;
    call.__twilioServiceStateListenersAttached = true;

    call.on('ringing', (hasEarlyMedia) => {
      call.__hasEarlyMedia = hasEarlyMedia;
      this._emit();
    });
    call.on('reconnecting', () => this._emit());
    call.on('reconnected', () => this._emit());
  }

  _onIncoming(call) {
    this._watchCallState(call);
    this.incomingCall = call;
    this._emit();
    call.on('accept', () => this._setCurrentCall(call));
    call.on('disconnect', () => {
      if (this.incomingCall === call) this.incomingCall = null;
      this._emit();
    });
    call.on('reject', () => {
      if (this.incomingCall === call) this.incomingCall = null;
      this._emit();
    });
    call.on('cancel', () => {
      if (this.incomingCall === call) this.incomingCall = null;
      this._emit();
    });
    call.on('error', (err) => {
      this.lastError = err.message || String(err);
      this._emit();
    });
  }

  _setCurrentCall(call) {
    this._watchCallState(call);
    this.currentCall = call;
    call.__startedAt = Date.now();
    call.on('accept', () => {
      call.__startedAt = Date.now();
      this._emit();
    });
    call.on('disconnect', () => {
      if (this.currentCall === call) this.currentCall = null;
      this._emit();
    });
    call.on('error', (err) => {
      this.lastError = err.message || String(err);
      this._emit();
    });
    this._emit();
  }

  // --- actions ---

  async placeCall(params) {
    if (!this.device) throw new Error('Device not registered');
    if (this.device.state !== 'registered') {
      throw new Error(`Device not ready (state: ${this.device.state})`);
    }
    const call = await this.device.connect({
      params: { To: params.to },
    });
    this._setCurrentCall(call);
    return call;
  }

  acceptIncoming() {
    if (!this.incomingCall) return;
    this.incomingCall.accept();
  }

  rejectIncoming() {
    if (!this.incomingCall) return;
    this.incomingCall.reject();
    this.incomingCall = null;
    this._emit();
  }

  hangup() {
    if (this.currentCall) {
      this.currentCall.disconnect();
      this.currentCall = null;
      this._emit();
    }
  }

  toggleMute() {
    if (!this.currentCall) return false;
    if (this.currentCall.isMuted()) {
      this.currentCall.mute(false);
    } else {
      this.currentCall.mute(true);
    }
    this._emit();
    return this.currentCall.isMuted();
  }

  sendDigits(digit) {
    if (this.currentCall) {
      this.currentCall.sendDigits(digit);
    }
  }

  async destroy() {
    if (this.device) {
      try {
        await this.device.destroy();
      } catch (_) {}
      this.device = null;
    }
    this.identity = null;
    this.currentCall = null;
    this.incomingCall = null;
    this._emit();
  }
}

export const TwilioStates = STATE;
