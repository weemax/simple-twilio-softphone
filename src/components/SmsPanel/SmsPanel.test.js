// Regression tests for SmsPanel's "+ New" flow.
//
// Background: in the empty-state (no conversations on the server), the
// poll-driven effect that auto-selects the first conversation used to
// reset the user's "+ New" selection back to null. The fix preserves
// the selection when the open thread is the synthesized empty one
// (messages.length === 0) — that thread is the renderer-side signal
// that the user just picked a new number and the server hasn't seen
// the conversation yet.
//
// These tests render the panel in JSDOM with a mocked useSms, drive
// the "+ New" UI, then simulate a poll (re-emitting the snapshot with
// a new array reference) and assert the selection survived.

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceProvider } from '../../workspace/WorkspaceContext';
import { SmsPanel } from './SmsPanel';
import { SmsContext } from '../../contexts/SmsContext';

// Mock the SmsContext to inject a controllable snapshot + thread fetch.
// Returns a handle the test can use to mutate the snapshot mid-flight.
//
// send/getThread keep a stable identity across rerenders so a poll
// does not retrigger SmsPanel's [selected, getThread] load effect.
function mountPanel(overrides = {}) {
  const calls = { list: 0, getThread: 0, send: 0, clear: 0 };
  let snapshot = {
    conversations: [],
    state: 'ready',
    lastError: null,
  };
  const threads = new Map(); // number -> thread
  const listeners = new Set();
  const send =
    overrides.send ||
    (async (payload) => {
      calls.send++;
      return { ok: true, sid: 'SM-test', to: payload.to };
    });
  const getThread =
    overrides.getThread ||
    (async (number) => {
      calls.getThread++;
      if (threads.has(number)) {
        // Return a copy so callers can't mutate the store.
        return { ...threads.get(number), messages: [...(threads.get(number).messages || [])] };
      }
      // Default behavior: synthesize the empty thread (mirrors the
      // 404-handling in SmsService.getThread).
      return {
        number,
        lastMessageAt: 0,
        lastBody: '',
        lastDirection: null,
        messageCount: 0,
        messages: [],
      };
    });
  const clearThread =
    overrides.clearThread ||
    (async (number) => {
      calls.clear++;
      const empty = {
        number,
        lastMessageAt: 0,
        lastBody: '',
        lastDirection: null,
        messageCount: 0,
        messages: [],
      };
      threads.set(number, empty);
      snapshot = {
        ...snapshot,
        conversations: (snapshot.conversations || []).map((c) =>
          c.number === number
            ? {
                ...c,
                lastMessageAt: 0,
                lastBody: '',
                lastDirection: null,
                messageCount: 0,
              }
            : c
        ),
      };
      rerender();
      return empty;
    });

  const container = document.createElement('div');
  document.body.appendChild(container);
  let root;

  function value() {
    return {
      snapshot,
      send,
      getThread,
      clearThread,
      refresh: overrides.refresh || (async () => {}),
      destroy: overrides.destroy || (async () => {}),
      service: overrides.service || {
        subscribe: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
    };
  }

  function rerender() {
    root.render(
      <SmsContext.Provider value={value()}>
        <WorkspaceProvider><SmsPanel /></WorkspaceProvider>
      </SmsContext.Provider>
    );
  }

  const handlers = {
    snapshot() {
      return snapshot;
    },
    setSnapshot(next) {
      snapshot = { ...snapshot, ...next };
      listeners.forEach((fn) => fn(snapshot));
      rerender();
    },
    setConversations(list) {
      // New array reference - the effect's dep is `snapshot.conversations`,
      // so we need a fresh array to trigger the effect even if the
      // contents are identical.
      snapshot = { ...snapshot, conversations: [...list] };
      listeners.forEach((fn) => fn(snapshot));
      rerender();
    },
    setThread(number, thread) {
      threads.set(number, thread);
    },
  };

  act(() => {
    root = createRoot(container);
    rerender();
  });
  return {
    container,
    handlers,
    calls,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function makeThread(number, count, { lastOutboundStatus = 'delivered' } = {}) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    const outbound = i % 2 === 1;
    const last = i === count - 1;
    messages.push({
      sid: `SM${i}`,
      body: `Message ${i} ${'lorem ipsum '.repeat(6)}`,
      direction: outbound ? 'outbound' : 'inbound',
      at: 1700000000000 + i * 60000,
      status: outbound
        ? last
          ? lastOutboundStatus
          : 'delivered'
        : 'received',
    });
  }
  const last = messages[messages.length - 1];
  return {
    number,
    lastMessageAt: last.at,
    lastBody: last.body,
    lastDirection: last.direction,
    messageCount: messages.length,
    messages,
  };
}

function conversationFrom(thread) {
  return {
    number: thread.number,
    lastMessageAt: thread.lastMessageAt,
    lastBody: thread.lastBody,
    lastDirection: thread.lastDirection,
    messageCount: thread.messageCount,
  };
}

async function openConversation(handlers, thread) {
  handlers.setThread(thread.number, thread);
  await act(async () => {
    handlers.setConversations([conversationFrom(thread)]);
  });
  // Auto-select the first conversation, then resolve getThread.
  await flush();
  await flush();
}

function threadScroller(container) {
  return container.querySelector('.sms-thread:not(.empty)');
}

function mockOverflow(el, { scrollHeight = 4000, clientHeight = 400 } = {}) {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  });
}

function scrollThread(el, scrollTop) {
  el.scrollTop = scrollTop;
  el.dispatchEvent(new Event('scroll'));
}

function $(container, sel) {
  return container.querySelector(sel);
}

function $$(container, sel) {
  return Array.from(container.querySelectorAll(sel));
}

afterEach(() => {
  // Clean up any stragglers.
  document.body.innerHTML = '';
});

describe('SmsPanel "+ New" selection preservation across polls', () => {
  it('keeps the + New selection when the server has no conversations yet (regression)', async () => {
    const { container, handlers, unmount } = mountPanel();

    // Initial state: empty list, "No conversations yet" placeholder.
    expect($(container, '.sms-list-empty').textContent).toMatch(/No conversations/);

    // Click "+ New".
    await act(async () => {
      const newBtn = $$(container, 'button').find((b) => b.textContent.trim() === '+ New');
      expect(newBtn).toBeTruthy();
      newBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Input should be visible.
    const input = $(container, '.sms-new-input');
    expect(input).toBeTruthy();

    // Type a number and hit Enter.
    await act(async () => {
      // Use the React-friendly setter so onChange fires.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(input, '+12025550101');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    // After Enter, the input row is gone and the thread-header shows the number.
    expect($(container, '.sms-new-input')).toBeNull();
    // formatNumber is rough (no real formatting library); the only
    // thing we care about for the bug under test is that the
    // selection survived — which is observable from the composer's
    // disabled state below. The thread-header text is just a
    // sanity check that something is rendered there.
    expect($(container, '.sms-panel-thread-number')).toBeTruthy();

    // Composer should be enabled (the disabled state would mean the
    // selection was reset to null).
    const composerInput = $(container, '.sms-composer-input');
    expect(composerInput.disabled).toBe(false);

    // Simulate a poll that returns the same empty list (a new array ref
    // so the effect re-runs).
    await act(async () => {
      handlers.setConversations([]);
      // Let any microtasks settle.
      await Promise.resolve();
    });
    // Run a second act to flush any effects queued by the first.
    await act(async () => {
      await Promise.resolve();
    });

    // The selection should still be intact after the poll.
    expect($(container, '.sms-panel-thread-number')).toBeTruthy();
    expect($(container, '.sms-composer-input').disabled).toBe(false);

    unmount();
  });

  it('does not show a stale error after a poll during the + New state', async () => {
    const { container, handlers, unmount } = mountPanel();

    await act(async () => {
      const newBtn = $$(container, 'button').find((b) => b.textContent.trim() === '+ New');
      newBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const input = $(container, '.sms-new-input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(input, '+12025550101');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    // Multiple polls in a row (simulating a few seconds of waiting).
    await act(async () => {
      handlers.setConversations([]);
    });
    await act(async () => {
      handlers.setConversations([]);
    });

    // The thread pane should still be in the empty-but-ready state,
    // not showing an error.
    const errEl = $(container, '.sms-thread .error');
    expect(errEl).toBeNull();
    expect($(container, '.sms-thread.empty')).toBeTruthy();

    unmount();
  });
});

describe('SmsPanel operator number', () => {
  it('shows the operator from-number in the messages header', async () => {
    const { container, handlers, unmount } = mountPanel();
    expect($(container, '.sms-panel-from')).toBeNull();

    await act(async () => {
      handlers.setSnapshot({ smsFrom: '+15551234567' });
    });

    const fromEl = $(container, '.sms-panel-from');
    expect(fromEl).toBeTruthy();
    expect(fromEl.textContent.replace(/\s+/g, ' ').trim()).toBe(
      'Your number +1 555 123 4567'
    );

    unmount();
  });

  it('falls back to callerId when smsFrom is missing', async () => {
    const { container, handlers, unmount } = mountPanel();
    await act(async () => {
      handlers.setSnapshot({ callerId: '+15559876543' });
    });
    expect($(container, '.sms-panel-from').textContent.replace(/\s+/g, ' ').trim()).toBe(
      'Your number +1 555 987 6543'
    );
    unmount();
  });
});

describe('SmsPanel clear thread', () => {
  const NUMBER = '+15551234567';

  it('asks for confirmation, then clears the open thread', async () => {
    const { container, handlers, calls, unmount } = mountPanel();
    const thread = makeThread(NUMBER, 6);
    await openConversation(handlers, thread);

    expect(threadScroller(container)).toBeTruthy();
    const headerButtons = $$(container, '[aria-label="Clear messages in this thread"]');
    const clearBtn = headerButtons[0];
    expect(clearBtn).toBeTruthy();

    await act(async () => {
      clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toMatch(/Clear local history\?/);
    expect(calls.clear).toBe(0);

    await act(async () => {
      const confirm = $(container, '.sms-panel-thread-header .danger');
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();

    expect(calls.clear).toBe(1);
    expect($(container, '.sms-thread.empty')).toBeTruthy();
    expect($(container, '.sms-thread.empty').textContent).toMatch(/No messages yet/);
    expect($(container, '[aria-label="Clear messages in this thread"]')).toBeNull();

    unmount();
  });

  it('does not clear when the user cancels', async () => {
    const { container, handlers, calls, unmount } = mountPanel();
    const thread = makeThread(NUMBER, 4);
    await openConversation(handlers, thread);

    await act(async () => {
      const clearBtn = $(container, '[aria-label="Clear messages in this thread"]');
      clearBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      const cancel = $$(container, '.sms-thread-clear-prompt button').find(
        (b) => b.textContent.trim() === 'Cancel'
      );
      cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(calls.clear).toBe(0);
    expect(threadScroller(container)).toBeTruthy();
    expect($$(container, '.sms-bubble').length).toBe(4);

    unmount();
  });

  it('does not show Clear on an empty thread', async () => {
    const { container, handlers, unmount } = mountPanel();
    const empty = {
      number: NUMBER,
      lastMessageAt: 0,
      lastBody: '',
      lastDirection: null,
      messageCount: 0,
      messages: [],
    };
    await openConversation(handlers, empty);
    expect($(container, '.sms-thread.empty')).toBeTruthy();
    expect($(container, '[aria-label="Clear messages in this thread"]')).toBeNull();
    unmount();
  });
});

describe('SmsPanel thread scroll stays put while reading history', () => {
  const NUMBER = '+15550100';

  it('does not jump to the latest on a poll refresh after the user scrolls up (regression)', async () => {
    const { container, handlers, unmount } = mountPanel();
    const thread = makeThread(NUMBER, 20, { lastOutboundStatus: 'sent' });
    await openConversation(handlers, thread);

    const el = threadScroller(container);
    expect(el).toBeTruthy();
    mockOverflow(el);
    await act(async () => {
      scrollThread(el, 120);
    });
    expect(el.scrollTop).toBe(120);

    // Poll with a new conversations array ref. Unsettled outbound
    // ("sent") makes SmsPanel re-fetch the thread, which used to
    // assign scrollTop = scrollHeight and yank the viewport down.
    await act(async () => {
      handlers.setConversations([conversationFrom(thread)]);
    });
    await flush();
    await flush();

    expect(el.scrollTop).toBe(120);

    unmount();
  });

  it('does not jump to the latest when a new inbound arrives while scrolled up', async () => {
    const { container, handlers, unmount } = mountPanel();
    const thread = makeThread(NUMBER, 20);
    await openConversation(handlers, thread);

    const el = threadScroller(container);
    mockOverflow(el);
    await act(async () => {
      scrollThread(el, 120);
    });

    const next = makeThread(NUMBER, 21);
    handlers.setThread(NUMBER, next);
    await act(async () => {
      handlers.setConversations([conversationFrom(next)]);
    });
    await flush();
    await flush();

    expect(el.scrollTop).toBe(120);

    unmount();
  });

  it('still follows the latest when the user is already at the bottom', async () => {
    const { container, handlers, unmount } = mountPanel();
    const thread = makeThread(NUMBER, 20, { lastOutboundStatus: 'sent' });
    await openConversation(handlers, thread);

    const el = threadScroller(container);
    mockOverflow(el);
    await act(async () => {
      scrollThread(el, 3600);
    });
    expect(el.scrollTop).toBe(3600);

    await act(async () => {
      handlers.setConversations([conversationFrom(thread)]);
    });
    await flush();
    await flush();

    expect(el.scrollTop).toBe(el.scrollHeight);

    unmount();
  });

  it('jumps to the latest after the user sends, even if they were scrolled up', async () => {
    const { container, handlers, unmount } = mountPanel();
    const thread = makeThread(NUMBER, 20);
    await openConversation(handlers, thread);

    const el = threadScroller(container);
    mockOverflow(el);
    await act(async () => {
      scrollThread(el, 120);
    });

    const composerInput = $(container, '.sms-composer-input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set;
      setter.call(composerInput, 'hello from here');
      composerInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      $(container, '.sms-composer-send').dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
      await Promise.resolve();
    });
    await flush();

    expect(el.scrollTop).toBe(el.scrollHeight);

    unmount();
  });
});

// Accepted TWP-9: acknowledgement and transport uncertainty must not be confused.
describe('truthful composer outcomes', () => {
  const number = '+12025550101';
  const thread = { number, messages:[{sid:'SMmeeting',body:'Can we meet at 2 tomorrow?',at:1781856000000,direction:'inbound',status:'received'}] };
  async function enterAndSend(container, text) {
    await act(async () => {
      const input=container.querySelector('.sms-composer-input');
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(input,text);
      input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await act(async () => {container.querySelector('.sms-composer-send').click();});
    await flush();
  }
  it('does not relabel an acknowledged send as unknown if only the subsequent refresh fails', async () => {
    let acknowledged=false;
    const {container,handlers,unmount}=mountPanel({
      send:async()=>{acknowledged=true;return{ok:true,status:'sent'};},
      getThread:async()=>{if(acknowledged)throw new Error('History is temporarily unavailable');return thread;},
    });
    await openConversation(handlers,thread);
    await enterAndSend(container,'Yes, see you then.');
    expect(container.querySelector('.sms-composer-input').value).toBe('');
    expect(container.textContent).not.toContain('Unknown outcome:');
    expect(container.textContent).not.toContain('The send result is unknown');
    unmount();
  });
  it('keeps an unknown attempt visible after a separate acknowledged message',async()=>{
    const {container,handlers,unmount}=mountPanel({
      send:async({body})=>{if(body==='Please confirm the address.')throw new Error('Connection closed');return{ok:true,status:'sent'};},
      getThread:async()=>thread,
    });
    await openConversation(handlers,thread);
    await enterAndSend(container,'Please confirm the address.');
    expect(container.querySelector('.sms-composer-send').disabled).toBe(true);
    await enterAndSend(container,'Meet at 2?');
    expect(container.querySelector('.sms-composer-input').value).toBe('');
    expect(container.textContent).toContain('Unknown outcome: “Please confirm the address.”');
    unmount();
  });
});

it('keeps the new recipient thread when an earlier successful send refresh resolves late (TWP-9)',async()=>{
  const a={number:'+12025550101',messages:[{sid:'SMa',body:'Can we meet at 2 tomorrow?',at:1781856000000,direction:'inbound',status:'received'}]};
  const b={number:'+12025550102',messages:[{sid:'SMb',body:'Please confirm the address.',at:1781856060000,direction:'inbound',status:'received'}]};
  let sent=false,resolveOld;
  const {container,handlers,unmount}=mountPanel({send:async()=>{sent=true;return{ok:true};},getThread:async n=>n===a.number&&sent?new Promise(resolve=>{resolveOld=resolve;}):n===a.number?a:b});
  await openConversation(handlers,a);
  await act(async()=>handlers.setConversations([conversationFrom(a),conversationFrom(b)]));
  await act(async()=>{const input=container.querySelector('.sms-composer-input');Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set.call(input,'Yes, see you then.');input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>container.querySelector('.sms-composer-send').click());
  await act(async()=>container.querySelectorAll('.sms-list-item')[1].click());
  await flush();
  expect(container.querySelector('.sms-thread').textContent).toContain(b.messages[0].body);
  await act(async()=>resolveOld(a));
  expect(container.querySelector('.sms-thread').textContent).toContain(b.messages[0].body);
  unmount();
});

it('does not mark unseen inbound messages read when the selected history fails to load (TWP-9)',async()=>{
  const previous=window.operator;
  const number='+12025550101';
  const saved={seeded:true,readIds:{[number]:[]}};
  const set=jest.fn(async()=>{});
  window.operator={config:{get:async()=>saved,set}};
  const {container,handlers,unmount}=mountPanel({getThread:async()=>{throw new Error('History is unavailable');}});
  try{
    await flush();
    await act(async()=>handlers.setConversations([{number,messages:[{sid:'SMunread',body:'Please confirm the address.',at:1781856000000,direction:'inbound',status:'received'}],messageCount:1}]));
    await flush();
    expect(container.querySelector('.sms-thread').textContent).toContain('History is unavailable');
    const writes=set.mock.calls.filter(([key])=>key==='workspace');
    expect(writes.length).toBeGreaterThan(0);
    writes.forEach(([,value])=>expect(value.readIds[number]).toEqual([]));
  }finally{unmount();window.operator=previous;}
});
