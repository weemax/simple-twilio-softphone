import { TwilioService } from './twilioService';

jest.mock('@twilio/voice-sdk', () => ({
  Device: jest.fn(),
}));

class FakeCall {
  constructor(status = 'connecting') {
    this.statusValue = status;
    this.parameters = {
      CallSid: 'CA-test',
      To: '+15558675309',
      From: 'client:operator',
    };
    this.direction = 'OUTGOING';
    this.listeners = new Map();
    this.muted = false;
  }

  on(event, handler) {
    const handlers = this.listeners.get(event) || [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  emit(event, ...args) {
    (this.listeners.get(event) || []).forEach((handler) => handler(...args));
  }

  status() {
    return this.statusValue;
  }

  isMuted() {
    return this.muted;
  }
}

describe('TwilioService call state snapshots', () => {
  it('forwards ringing and preserves hasEarlyMedia', () => {
    const service = new TwilioService();
    const call = new FakeCall();
    const snapshots = [];
    service.subscribe((snapshot) => snapshots.push(snapshot));
    service._setCurrentCall(call);

    call.statusValue = 'ringing';
    call.emit('ringing', false);

    expect(service.snapshot().currentCall).toMatchObject({
      status: 'ringing',
      hasEarlyMedia: false,
    });
    expect(snapshots.at(-1).currentCall).toMatchObject({
      status: 'ringing',
      hasEarlyMedia: false,
    });
  });

  it('does not lose reconnecting or reconnected transitions', () => {
    const service = new TwilioService();
    const call = new FakeCall('open');
    const snapshots = [];
    service.subscribe((snapshot) => snapshots.push(snapshot));
    service._setCurrentCall(call);

    call.statusValue = 'reconnecting';
    call.emit('reconnecting');
    expect(snapshots.at(-1).currentCall.status).toBe('reconnecting');

    call.statusValue = 'open';
    call.emit('reconnected');
    expect(snapshots.at(-1).currentCall.status).toBe('open');
  });

  it('forwards ringing for incoming call snapshots too', () => {
    const service = new TwilioService();
    const call = new FakeCall();
    service._onIncoming(call);

    call.statusValue = 'ringing';
    call.emit('ringing', true);

    expect(service.snapshot().incomingCall).toMatchObject({
      status: 'ringing',
      hasEarlyMedia: true,
    });
  });
});

// Accepted TWP-9 piece 3: incoming calls stay usable and recents reflect observed outcomes.
describe('observed call history',()=>{
  it('records a missed incoming call once and clears both call slots after an answered call ends',()=>{
    const service=new TwilioService();
    const missed=new FakeCall('pending');missed.direction='INCOMING';missed.parameters.From='+12025550101';
    service._onIncoming(missed);missed.emit('cancel');
    expect(service.snapshot().lastCall).toMatchObject({number:'+12025550101',direction:'incoming',outcome:'missed'});
    const call=new FakeCall('pending');call.direction='INCOMING';call.parameters.From='+12025550102';
    service._onIncoming(call);call.statusValue='open';call.emit('accept');
    expect(service.snapshot().incomingCall).toBeNull();expect(service.snapshot().currentCall.from).toBe('+12025550102');
    call.emit('disconnect');
    expect(service.snapshot().incomingCall).toBeNull();expect(service.snapshot().currentCall).toBeNull();
    expect(service.snapshot().lastCall.outcome).toBe('completed');
    const id=service.snapshot().lastCall.id;call.emit('disconnect');expect(service.snapshot().lastCall.id).toBe(id);
  });
});
