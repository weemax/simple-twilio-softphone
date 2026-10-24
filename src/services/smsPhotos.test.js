// Accepted TWP-9 piece 4: what the renderer's SMS service asks of the desktop
// bridge for photos (window.operator.sms, see preload.js), and what a person is
// told when it answers no. The bridge is a stand-in with the same shapes.
import { SmsService } from './smsService';
import { notifyInboundSms } from './smsNotifications';
import { JPEG } from '../photoFixtures';

const MiB = 1024 * 1024;
const id = (n) => String(n).padStart(32, '0');

function bridge(overrides = {}) {
  const sms = {
    attach: jest.fn(async ({ name, bytes }) => ({
      ok: true,
      media: { id: id(1), type: 'image/jpeg', bytes: bytes.length, width: 48, height: 32, name },
    })),
    media: jest.fn(async () => ({ ok: true, type: 'image/jpeg', bytes: JPEG })),
    send: jest.fn(async () => ({ ok: true, sid: 'MM1', status: 'queued' })),
    list: jest.fn(async () => ({ ok: true, conversations: [] })),
    discardMedia: jest.fn(async () => ({ ok: true, removed: true })),
    pruneMedia: jest.fn(async () => ({ ok: true, removed: 0 })),
    photoPolicy: jest.fn(async () => ({ ok: true, supported: true })),
    ...overrides,
  };
  window.operator = { sms };
  return sms;
}

afterEach(() => {
  delete window.operator;
});

describe('attaching a photo', () => {
  it('reads the chosen file and hands its bytes to the local service, nothing more', async () => {
    const sms = bridge();
    const file = new File([JPEG], 'beach.jpg', { type: 'image/jpeg' });
    file.arrayBuffer = async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.length);

    const photo = await new SmsService().attachPhoto(file);

    expect(photo).toMatchObject({ id: id(1), type: 'image/jpeg', name: 'beach.jpg' });
    expect(sms.attach).toHaveBeenCalledTimes(1);
    expect(Buffer.compare(Buffer.from(sms.attach.mock.calls[0][0].bytes), JPEG)).toBe(0);
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('refuses a 5 MB file before reading it', async () => {
    const sms = bridge();
    const file = new File([JPEG], 'huge.jpg');
    Object.defineProperty(file, 'size', { value: 5 * MiB });

    await expect(new SmsService().attachPhoto(file)).rejects.toThrow(/huge\.jpg is 5 MB or larger/);
    expect(sms.attach).not.toHaveBeenCalled();
  });

  it('says why the service refused a file, without the transport prefix', async () => {
    bridge({ attach: async () => ({ ok: false, error: 'SMS backend 415: The PNG has extra data after its end.' }) });
    const file = new File([JPEG], 'x.png');
    file.arrayBuffer = async () => new ArrayBuffer(8);

    await expect(new SmsService().attachPhoto(file)).rejects.toThrow('The PNG has extra data after its end.');
  });

  it('asks the person to restart when the running app predates photos', async () => {
    window.operator = { sms: { list: async () => ({ ok: true }) } };
    const file = new File([JPEG], 'x.jpg');

    await expect(new SmsService().attachPhoto(file)).rejects.toThrow(/Restart the app to enable photos/);
  });
});

describe('sending and viewing photos', () => {
  it('passes photo ids with the message only when there are photos', async () => {
    const sms = bridge();
    const service = new SmsService();
    await service.send({ to: '+12025550101', body: 'text' });
    await service.send({ to: '+12025550101', body: '', media: [id(1), id(2)] });

    expect(sms.send.mock.calls.map(([p]) => p)).toEqual([
      { to: '+12025550101', body: 'text' },
      { to: '+12025550101', body: '', media: [id(1), id(2)] },
    ]);
  });

  it('keeps the failed or unknown label the service gave, with a readable message', async () => {
    bridge({ send: async () => ({ ok: false, status: 'failed', error: 'SMS backend 400: Photos can be sent only to numbers in the United States and Canada.' }) });
    const error = await new SmsService().send({ to: '+18765550123', body: '', media: [id(1)] }).catch((e) => e);

    expect(error.message).toBe('Photos can be sent only to numbers in the United States and Canada.');
    expect(error.outcome).toBe('failed');
  });

  it('fetches a photo once and serves repeat views from its cache, retrying after a failure', async () => {
    const sms = bridge();
    const service = new SmsService();

    const first = await service.photoBlob(id(1));
    await service.photoBlob(id(1));

    expect(first.type).toBe('image/jpeg');
    expect(first.size).toBe(JPEG.length);
    expect(sms.media).toHaveBeenCalledTimes(1);

    sms.media.mockImplementationOnce(async () => ({ ok: false, error: 'SMS backend 404: photo not found' }));
    await expect(service.photoBlob(id(2))).rejects.toThrow('photo not found');
    await expect(service.photoBlob(id(2))).resolves.toBeTruthy();
    expect(sms.media).toHaveBeenCalledTimes(3);
  });

  it('forgets a discarded draft photo, and a failed cleanup is not an error', async () => {
    const sms = bridge({ discardMedia: async () => { throw new Error('service stopped'); } });
    const service = new SmsService();
    await service.photoBlob(id(1));

    await expect(service.discardPhoto(id(1))).resolves.toBeUndefined();
    await service.photoBlob(id(1));
    expect(sms.media).toHaveBeenCalledTimes(2);
  });
});

describe('alerting for an incoming photo message', () => {
  it('names the photos when a message has no text', () => {
    window.HTMLMediaElement.prototype.play = () => Promise.resolve(); // the alert sound
    const show = jest.fn(async () => ({ ok: true }));
    window.operator = { notifications: { show } };

    notifyInboundSms({ number: '+12025550101', body: '', media: [{ id: id(1) }, { id: id(2) }] });
    notifyInboundSms({ number: '+12025550101', body: '', media: [{ id: id(1) }] });
    notifyInboundSms({ number: '+12025550101', body: 'caption', media: [{ id: id(1) }] });

    expect(show.mock.calls.map(([p]) => p.body)).toEqual(['2 photos', 'Photo', 'caption']);
  });
});
