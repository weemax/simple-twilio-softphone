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

import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { SmsPanel } from './SmsPanel';
import { SmsContext } from '../../contexts/SmsContext';

// Mock the SmsContext to inject a controllable snapshot + thread fetch.
// Returns a handle the test can use to mutate the snapshot mid-flight.
function mountPanel(overrides = {}) {
  const calls = { list: 0, getThread: 0, send: 0 };
  let snapshot = {
    conversations: [],
    state: 'ready',
    lastError: null,
  };
  const threads = new Map(); // number -> thread
  const handlers = {
    snapshot() {
      return snapshot;
    },
    setSnapshot(next) {
      snapshot = { ...snapshot, ...next };
      listeners.forEach((fn) => fn(snapshot));
    },
    setConversations(list) {
      // New array reference — the effect's dep is `snapshot.conversations`,
      // so we need a fresh array to trigger the effect even if the
      // contents are identical.
      snapshot = { ...snapshot, conversations: [...list] };
      listeners.forEach((fn) => fn(snapshot));
    },
    setThread(number, thread) {
      threads.set(number, thread);
    },
  };
  const listeners = new Set();
  const ctx = {
    snapshot,
    send: async (payload) => {
      calls.send++;
      return { ok: true, sid: 'SM-test', to: payload.to };
    },
    getThread: async (number) => {
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
    },
    refresh: async () => {},
    destroy: async () => {},
    service: { subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } },
  };
  const merged = { ...ctx, ...overrides };
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root;
  act(() => {
    root = createRoot(container);
    root.render(
      <SmsContext.Provider value={merged}>
        <SmsPanel />
      </SmsContext.Provider>
    );
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
      setter.call(input, '+155****0100');
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

    // Debug: dump what we see
    // eslint-disable-next-line no-console
    console.log('post-poll container:', container.innerHTML.slice(0, 2000));

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
      setter.call(input, '+155****0100');
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
