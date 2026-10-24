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

function makeFakeOperator({
  listHandler,
  clearHandler,
  meHandler,
  notificationsShow = () => Promise.resolve({ ok: true }),
}) {
  global.window = global.window || {};
  global.window.operator = {
    sms: {
      list: listHandler,
      send: () => Promise.resolve({ ok: true }),
      clear:
        clearHandler ||
        (() => Promise.resolve({ ok: true, cleared: true, number: '+15550000000' })),
      me:
        meHandler ||
        (() => Promise.resolve({ ok: true, callerId: null, smsFrom: null })),
    },
    notifications: { show: notificationsShow },
  };
}

afterEach(() => {
  delete global.window;
  delete global.Audio;
  delete global.fetch;
});

describe('SmsService inbound notification detection', () => {
  it('skips initial hydration and alerts each new inbound message once despite reordering', async () => {
    let conversations = [
      {
        number: '+15550000001',
        messages: [
          { sid: 'SM-old-a', direction: 'inbound', body: 'old a', at: 1 },
        ],
      },
      {
        number: '+15550000002',
        messages: [
          { sid: 'SM-old-b', direction: 'inbound', body: 'old b', at: 2 },
        ],
      },
    ];
    const show = jest.fn(() => Promise.resolve({ ok: true }));
    const play = jest.fn(() => Promise.resolve());
    const AudioMock = jest.fn(() => ({ volume: 1, play }));
    global.Audio = AudioMock;
    global.window = global.window || {};
    global.window.Audio = AudioMock;
    makeFakeOperator({
      listHandler: () => Promise.resolve({ ok: true, conversations }),
      notificationsShow: show,
    });

    const svc = new SmsService();
    await svc._refresh(); // Existing history is the baseline, not an alert.
    expect(show).not.toHaveBeenCalled();
    expect(AudioMock).not.toHaveBeenCalled();

    // Polling may reorder conversations without changing message identity.
    conversations = [conversations[1], conversations[0]];
    await svc._refresh();
    expect(show).not.toHaveBeenCalled();

    const newMessage = {
      sid: 'SM-new',
      direction: 'inbound',
      body: 'new inbound',
      at: 3,
    };
    conversations = [
      {
        ...conversations[0],
        messages: [newMessage, ...conversations[0].messages],
      },
      conversations[1],
    ];
    await svc._refresh();
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith({
      number: '+15550000002',
      body: 'new inbound',
    });
    expect(AudioMock).toHaveBeenCalledTimes(1);

    // A later poll can reorder messages too; the SID prevents replay.
    conversations = [
      {
        ...conversations[0],
        messages: [...conversations[0].messages].reverse(),
      },
      conversations[1],
    ];
    await svc._refresh();
    expect(show).toHaveBeenCalledTimes(1);
    expect(AudioMock).toHaveBeenCalledTimes(1);
  });
});

describe('SmsService operator numbers', () => {
  it('copies callerId and smsFrom from the list payload onto the snapshot', async () => {
    makeFakeOperator({
      listHandler: () =>
        Promise.resolve({
          ok: true,
          conversations: [],
          callerId: '+15551110000',
          smsFrom: '+15552220000',
        }),
    });
    const svc = new SmsService();
    await svc._refresh();
    expect(svc.snapshot()).toMatchObject({
      callerId: '+15551110000',
      smsFrom: '+15552220000',
    });
  });

  it('copies callerId and smsFrom from /me', async () => {
    makeFakeOperator({
      listHandler: () => Promise.resolve({ ok: true, conversations: [] }),
      meHandler: () =>
        Promise.resolve({
          ok: true,
          callerId: '+12025550100',
          smsFrom: '+12025550100',
        }),
    });
    const svc = new SmsService();
    await svc._refreshMe();
    expect(svc.snapshot()).toMatchObject({
      callerId: '+12025550100',
      smsFrom: '+12025550100',
    });
  });

  it('clears stored numbers when the list payload sends null', async () => {
    makeFakeOperator({
      listHandler: () =>
        Promise.resolve({
          ok: true,
          conversations: [],
          callerId: '+15551110000',
          smsFrom: '+15552220000',
        }),
    });
    const svc = new SmsService();
    await svc._refresh();
    window.operator.sms.list = () =>
      Promise.resolve({
        ok: true,
        conversations: [],
        callerId: null,
        smsFrom: null,
      });
    await svc._refresh();
    expect(svc.snapshot().callerId).toBeNull();
    expect(svc.snapshot().smsFrom).toBeNull();
  });
});

describe('SmsService.clearThread', () => {
  it('calls sms.clear, refreshes the list, and returns an empty thread', async () => {
    const clear = jest.fn(() =>
      Promise.resolve({ ok: true, cleared: true, number: '+15550100' })
    );
    const list = jest.fn(() =>
      Promise.resolve({
        ok: true,
        conversations: [
          {
            number: '+15550100',
            lastMessageAt: 0,
            lastBody: '',
            lastDirection: null,
            messageCount: 0,
            messages: [],
          },
        ],
      })
    );
    makeFakeOperator({ listHandler: list, clearHandler: clear });
    const svc = new SmsService();
    const thread = await svc.clearThread('+15550100');
    expect(clear).toHaveBeenCalledWith({ number: '+15550100' });
    expect(list).toHaveBeenCalled();
    expect(thread).toEqual({
      number: '+15550100',
      lastMessageAt: 0,
      lastBody: '',
      lastDirection: null,
      messageCount: 0,
      messages: [],
    });
  });

  // TWP-7's authenticated private boundary supersedes the adopted browser fallback.
  it('never bypasses authentication when the desktop clearing handler is stale', async () => {
    makeFakeOperator({
      clearHandler: () => Promise.reject(new Error("No handler registered for sms:clear")),
    });
    global.fetch = jest.fn();
    const svc = new SmsService();
    await expect(svc.clearThread('+12025550101')).rejects.toThrow('No handler registered');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws when the bridge reports failure', async () => {
    makeFakeOperator({
      listHandler: () => Promise.resolve({ ok: true, conversations: [] }),
      clearHandler: () => Promise.resolve({ ok: false, error: 'nope' }),
    });
    const svc = new SmsService();
    await expect(svc.clearThread('+15550100')).rejects.toThrow('nope');
  });
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
