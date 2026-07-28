// Tests for SmsService.getThread — specifically the 404 → empty-thread
// synthesis path. This is what powers the "+ New" flow for numbers that
// have never been texted: the server returns 404 "no such conversation",
// the service turns that into a synthesized empty thread so the
// renderer's "+ New" selection isn't blown away.
//
// Bug history: before the service learned to handle 404, the renderer
// would receive an error from the IPC bridge, the [selected, getThread]
// effect would set threadError, and the user would see a red error
// message in the thread pane. The fix is in the service.

import { SmsService } from './smsService';

function makeFakeOperator({ listHandler }) {
  global.window = global.window || {};
  global.window.operator = {
    sms: {
      list: listHandler,
      send: () => Promise.resolve({ ok: true }),
    },
  };
}

afterEach(() => {
  delete global.window;
});

describe('SmsService.getThread', () => {
  it('synthesizes an empty thread when the server returns 404 "no such conversation"', async () => {
    // Simulate the renderer-side broker response: the HTTP request
    // returned 404 with body { error: "no such conversation" }, so the
    // IPC handler returned { ok: false, error: "SMS backend 404: no such conversation" }.
    makeFakeOperator({
      listHandler: () =>
        Promise.resolve({
          ok: false,
          error: 'SMS backend 404: no such conversation',
        }),
    });
    const svc = new SmsService();
    const thread = await svc.getThread('+155****0100');
    expect(thread).toEqual({
      number: '+155****0100',
      lastMessageAt: 0,
      lastBody: '',
      lastDirection: null,
      messageCount: 0,
      messages: [],
    });
  });

  it('synthesizes an empty thread when the error message contains "404" alone', async () => {
    makeFakeOperator({
      listHandler: () =>
        Promise.resolve({ ok: false, error: 'SMS backend 404' }),
    });
    const svc = new SmsService();
    const thread = await svc.getThread('+155****0100');
    expect(thread.messages).toEqual([]);
  });

  it('rethrows real errors (not just 404s)', async () => {
    makeFakeOperator({
      listHandler: () =>
        Promise.resolve({ ok: false, error: 'SMS backend 500: boom' }),
    });
    const svc = new SmsService();
    await expect(svc.getThread('+155****0100')).rejects.toThrow('500: boom');
  });

  it('strips the ok flag from a real thread response', async () => {
    makeFakeOperator({
      listHandler: () =>
        Promise.resolve({
          ok: true,
          number: '+155****0100',
          lastMessageAt: 123,
          lastBody: 'hi',
          lastDirection: 'inbound',
          messageCount: 1,
          messages: [{ sid: 'SM1', direction: 'inbound', body: 'hi', at: 123, status: 'received' }],
        }),
    });
    const svc = new SmsService();
    const thread = await svc.getThread('+155****0100');
    expect(thread.ok).toBeUndefined();
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].body).toBe('hi');
  });
});
