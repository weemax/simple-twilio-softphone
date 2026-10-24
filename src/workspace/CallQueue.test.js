// Accepted TWP-9 piece 5, through the real hook, workspace provider and view:
// one press dials exactly the visible contact, a second press cannot create
// another leg, and ending a call never dials the next contact.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { SmsContext } from '../contexts/SmsContext';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext';
import { CallQueue } from './CallQueue';
import { useCallQueue } from './useCallQueue';

let mockVoice;
jest.mock('../contexts/TwilioContext', () => ({
  useTwilio: () => mockVoice,
}));

const alex = { id: 'c1', name: 'Alex Rivera', number: '+12025550101' };
const jamie = { id: 'c2', name: 'Jamie Chen', number: '+12025550103' };
const morgan = { id: 'c3', name: 'Morgan Lee', number: '+442079460958' };

let api, workspace;
function Harness() {
  api = useCallQueue();
  workspace = useWorkspace();
  return (
    <CallQueue
      queueApi={api}
      voiceStatus=""
      onAddContacts={() => {}}
    />
  );
}

let store, root, container;
const sms = { snapshot: { hydrated: true, conversations: [] }, prunePhotos: () => {} };
async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <SmsContext.Provider value={sms}>
        <WorkspaceProvider>
          <Harness />
        </WorkspaceProvider>
      </SmsContext.Provider>,
    );
  });
}
const rerender = () =>
  act(async () => {
    root.render(
      <SmsContext.Provider value={sms}>
        <WorkspaceProvider>
          <Harness />
        </WorkspaceProvider>
      </SmsContext.Provider>,
    );
  });
const buttons = (name) =>
  [...container.querySelectorAll('button')].filter((b) =>
    typeof name === 'string' ? b.textContent === name : name.test(b.textContent),
  );
const click = (button) => act(async () => button.click());
const names = () =>
  [...container.querySelectorAll('.queue-list strong')].map((e) => e.textContent);

beforeEach(() => {
  store = {
    workspace: {
      contacts: [alex, jamie, morgan],
      drafts: { [alex.number]: 'Running ten minutes late' },
    },
  };
  window.operator = {
    config: {
      get: jest.fn(async (k) => store[k]),
      set: jest.fn(async (k, v) => {
        store[k] = JSON.parse(JSON.stringify(v));
      }),
    },
  };
  mockVoice = {
    snapshot: { state: 'registered', currentCall: null, incomingCall: null, connecting: false, lastCall: null },
    placeCall: jest.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function queueAll() {
  let result;
  await act(async () => {
    result = api.enqueue([alex, jamie, morgan, { ...alex }].map((c) => ({ number: c.number, name: c.name, contactId: c.id })));
  });
  return result;
}

it('dials exactly the visible contact on one press, ignores a repeated press, and waits after the call ends', async () => {
  let finish;
  mockVoice.placeCall.mockImplementation(
    () => new Promise((resolve) => (finish = () => resolve({ __localId: 'call-1' }))),
  );
  await mount();
  const added = await queueAll();
  expect(names()).toEqual(['Alex Rivera', 'Jamie Chen', 'Morgan Lee']);
  expect(added.message).toBe(
    '3 contacts added to the queue; Alex Rivera is already in the queue. Nothing is called until you press Call next.',
  );
  const call = buttons('Call next')[0];
  expect(call.getAttribute('aria-label')).toContain('Alex Rivera');
  // Two presses in the same moment: one leg.
  await act(async () => {
    call.click();
    call.click();
  });
  expect(mockVoice.placeCall).toHaveBeenCalledTimes(1);
  expect(mockVoice.placeCall).toHaveBeenCalledWith('+12025550101');
  await act(async () => finish());
  // The voice service reports the call ended.
  mockVoice.snapshot = {
    ...mockVoice.snapshot,
    lastCall: { id: 'call-1', number: alex.number, direction: 'outgoing', outcome: 'completed', duration: 12, at: Date.now() },
  };
  await rerender();
  expect(container.textContent).toContain('Completed');
  expect(names()).toEqual(['Jamie Chen', 'Morgan Lee']);
  expect(mockVoice.placeCall).toHaveBeenCalledTimes(1);
  // Time passes, the voice device reconnects, the app rerenders: still no call.
  mockVoice.snapshot = { ...mockVoice.snapshot, state: 'unregistered' };
  await rerender();
  mockVoice.snapshot = { ...mockVoice.snapshot, state: 'registered' };
  await rerender();
  expect(mockVoice.placeCall).toHaveBeenCalledTimes(1);
  expect(buttons('Call next')[0].disabled).toBe(false);
  expect(buttons('Call next')[0].getAttribute('aria-label')).toContain('Jamie Chen');
});

it('does not touch message drafts or attachments while the queue changes', async () => {
  await mount();
  await queueAll();
  const [move] = buttons('Move down');
  await click(move);
  await click(buttons('Skip')[0]);
  expect(store.workspace.drafts).toEqual({ [alex.number]: 'Running ten minutes late' });
  expect(store.workspace.queue.items).toHaveLength(2);
  expect(workspace.data.attachments).toEqual({});
});

it('blocks and explains while a call is incoming or the voice device is offline, and keeps every contact', async () => {
  await mount();
  await queueAll();
  mockVoice.snapshot = { ...mockVoice.snapshot, incomingCall: { status: 'pending' } };
  await rerender();
  expect(buttons('Call next')[0].disabled).toBe(true);
  expect(container.textContent).toContain('incoming call needs an answer');
  mockVoice.snapshot = { ...mockVoice.snapshot, incomingCall: null, state: 'unregistered' };
  await rerender();
  expect(buttons('Call next')[0].disabled).toBe(true);
  expect(names()).toHaveLength(3);
  expect(mockVoice.placeCall).not.toHaveBeenCalled();
});

it('requires review of a changed contact before it is dialed, then dials the current number', async () => {
  mockVoice.placeCall.mockResolvedValue({ __localId: 'call-2' });
  await mount();
  await queueAll();
  await act(async () =>
    workspace.update((d) => ({
      ...d,
      contacts: d.contacts.map((c) => (c.id === 'c1' ? { ...c, number: '+12025550199' } : c)),
    })),
  );
  expect(container.textContent).toContain('changed after it was queued');
  expect(buttons('Call next')[0].disabled).toBe(true);
  await click(buttons('Use current details')[0]);
  await click(buttons('Call next')[0]);
  expect(mockVoice.placeCall).toHaveBeenCalledWith('+12025550199');
});

it('keeps a removed contact pending but undialable until the person reviews it', async () => {
  await mount();
  await queueAll();
  await act(async () =>
    workspace.update((d) => ({ ...d, contacts: d.contacts.filter((c) => c.id !== 'c1') })),
  );
  expect(container.textContent).toContain('removed from Contacts');
  expect(buttons('Call next')[0].disabled).toBe(true);
  await click(buttons('Remove from queue')[0]);
  expect(names()).toEqual(['Jamie Chen', 'Morgan Lee']);
  expect(mockVoice.placeCall).not.toHaveBeenCalled();
});

it('reopens with pending contacts and the interrupted call recorded, and dials nothing', async () => {
  store.workspace.queue = {
    items: [{ id: 'q2', number: jamie.number, name: jamie.name, contactId: 'c2' }],
    active: { id: 'q1', number: alex.number, name: alex.name, contactId: 'c1', startedAt: 1, callId: 'call-0' },
    history: [],
  };
  await mount();
  expect(names()).toEqual(['Jamie Chen']);
  expect(container.textContent).toContain('Interrupted');
  expect(mockVoice.placeCall).not.toHaveBeenCalled();
  expect(buttons('Call next')[0].disabled).toBe(false);
});

it('returns a contact to the queue when the call cannot start, and does not retry', async () => {
  mockVoice.placeCall.mockRejectedValue(new Error('Device not ready (state: unregistered)'));
  await mount();
  await queueAll();
  await click(buttons('Call next')[0]);
  expect(container.textContent).toContain('Device not ready');
  expect(names()).toEqual(['Alex Rivera', 'Jamie Chen', 'Morgan Lee']);
  expect(mockVoice.placeCall).toHaveBeenCalledTimes(1);
});
