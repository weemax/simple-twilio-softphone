const fs = require('fs');
const os = require('os');
const path = require('path');
const { SmsStore } = require('../server/smsStore');

describe('SmsStore.clearConversation', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-store-'));
    store = new SmsStore(path.join(dir, 'store.json'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('wipes messages but keeps the conversation in the list', async () => {
    await store.appendMessage({
      number: '+15551234567',
      sid: 'SM1',
      direction: 'inbound',
      body: 'hello',
      at: 1,
      status: 'received',
    });
    await store.appendMessage({
      number: '+15551234567',
      sid: 'SM2',
      direction: 'outbound',
      body: 'hi',
      at: 2,
      status: 'sent',
    });

    const result = await store.clearConversation('+15551234567');
    expect(result.cleared).toBe(true);
    expect(result.messages).toEqual([]);
    expect(result.messageCount).toBe(0);

    const conv = store.getConversation('+15551234567');
    expect(conv).toBeTruthy();
    expect(conv.messages).toEqual([]);
    expect(conv.messageCount).toBe(0);
    expect(conv.lastBody).toBe('');
    expect(store.listConversations()).toHaveLength(1);
  });

  it('does not touch a different thread', async () => {
    await store.appendMessage({
      number: '+15551111111',
      sid: 'SM-a',
      direction: 'inbound',
      body: 'keep me',
      at: 1,
      status: 'received',
    });
    await store.appendMessage({
      number: '+15552222222',
      sid: 'SM-b',
      direction: 'inbound',
      body: 'wipe me',
      at: 2,
      status: 'received',
    });
    await store.clearConversation('+15552222222');
    expect(store.getConversation('+15551111111').messages).toHaveLength(1);
    expect(store.getConversation('+15552222222').messages).toHaveLength(0);
  });

  it('returns cleared:false for an unknown number', async () => {
    const result = await store.clearConversation('+15550000000');
    expect(result).toEqual({ cleared: false, number: '+15550000000' });
  });

  it('rejects invalid numbers', async () => {
    await expect(store.clearConversation('abc')).rejects.toThrow(
      'invalid phone number'
    );
  });
});
