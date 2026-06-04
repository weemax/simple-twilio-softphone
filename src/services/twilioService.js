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

  _onIncoming(call) {
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
