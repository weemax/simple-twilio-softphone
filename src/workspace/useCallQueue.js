import { useCallback, useEffect, useRef, useState } from 'react';
import { useTwilio } from '../contexts/TwilioContext';
import { callLocalId } from '../services/twilioService';
import { useWorkspace } from './WorkspaceContext';
import {
  acceptReview,
  addToQueue,
  attachCall,
  beginCall,
  callNextBlocker,
  clearHistory,
  failStart,
  finishCall,
  moveItem,
  removeItem,
  skipItem,
} from './queue';

// What the person is told after adding contacts: what was added, what was
// already queued, and that nothing is called until they press Call next.
export function addMessage({ added, duplicates, invalid }) {
  const label = (list) =>
    list.length === 1 ? list[0].name || list[0].number : `${list.length} contacts`;
  const parts = [];
  if (added.length) parts.push(`${label(added)} added to the queue`);
  if (duplicates.length)
    parts.push(
      `${label(duplicates)} ${duplicates.length === 1 ? 'is' : 'are'} already in the queue`,
    );
  if (invalid.length) parts.push(`${invalid.length} without a valid number skipped`);
  return `${parts.join('; ')}. Nothing is called until you press Call next.`;
}

// The call queue's one owner. Only `callNext` places a call, and only from a
// person's press; when a call ends the queue records the outcome and stops.
// `externalBusy` is true while another surface (the confirmation dialog) is
// starting a call.
export function useCallQueue({ externalBusy = false } = {}) {
  const { snapshot, placeCall } = useTwilio();
  const { data, update, ready } = useWorkspace();
  const { queue, contacts } = data;
  const dialing = useRef(false);
  const [starting, setStarting] = useState(false),
    [startError, setStartError] = useState('');
  const change = useCallback(
    (fn) => update((d) => ({ ...d, queue: fn(d.queue, d.contacts) })),
    [update],
  );
  const activeCall = snapshot.currentCall || snapshot.incomingCall;
  const blocker = callNextBlocker({
    queue,
    contacts,
    voiceState: snapshot.state,
    incoming: Boolean(snapshot.incomingCall),
    busy:
      Boolean(activeCall) ||
      snapshot.connecting ||
      starting ||
      externalBusy,
  });
  // How a call this queue started ended; the next contact stays pending.
  const lastCall = snapshot.lastCall;
  const callId = queue.active?.callId;
  useEffect(() => {
    if (!ready || !callId || !lastCall || lastCall.id !== callId) return;
    update((d) => {
      const next = finishCall(d.queue, lastCall);
      return next === d.queue ? d : { ...d, queue: next };
    });
  }, [ready, callId, lastCall, update]);
  const callNext = useCallback(
    async (itemId) => {
      if (dialing.current || blocker) return;
      dialing.current = true;
      setStarting(true);
      setStartError('');
      let started = null;
      update((d) => {
        const next = beginCall(d.queue, itemId);
        started = next.active;
        return next === d.queue ? d : { ...d, queue: next };
      });
      if (!started) {
        dialing.current = false;
        setStarting(false);
        return;
      }
      try {
        const call = await placeCall(started.number);
        const id = callLocalId(call);
        change((q) => attachCall(q, started.id, id));
      } catch (e) {
        const reason = e?.message || 'The call could not start.';
        change((q) => failStart(q, started.id, reason));
        setStartError(reason);
      } finally {
        dialing.current = false;
        setStarting(false);
      }
    },
    [blocker, update, placeCall, change],
  );
  const enqueue = useCallback(
    (entries) => {
      let result;
      update((d) => {
        result = addToQueue(d.queue, entries);
        return result.queue === d.queue ? d : { ...d, queue: result.queue };
      });
      return { ...result, message: addMessage(result) };
    },
    [update],
  );
  const review = useCallback(
    (id) => {
      let merged = false;
      update((d) => {
        const r = acceptReview(d.queue, id, d.contacts);
        merged = r.merged;
        return r.queue === d.queue ? d : { ...d, queue: r.queue };
      });
      return merged;
    },
    [update],
  );
  return {
    queue,
    contacts,
    blocker,
    starting,
    startError,
    callNext,
    enqueue,
    review,
    move: useCallback((id, delta) => change((q) => moveItem(q, id, delta)), [change]),
    remove: useCallback((id) => change((q) => removeItem(q, id)), [change]),
    skip: useCallback((id) => change((q) => skipItem(q, id)), [change]),
    clearOutcomes: useCallback(() => change(clearHistory), [change]),
  };
}
