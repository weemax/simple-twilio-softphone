// Accepted TWP-9 piece 5: the manual contact queue.
//
// Pure functions over `{ items, active, history }`. Nothing here dials, and
// nothing advances on its own: every contact that reaches `active` got there
// through `beginCall`, which the person's own "Call next" press triggers.
//   items    pending contacts, in the order they will be offered
//   active   the one contact whose call was started by a press, else null
//   history  newest-first outcomes of contacts that left the queue
import { normalizePhone } from './model';

export const HISTORY_LIMIT = 50;

export const emptyQueue = () => ({ items: [], active: null, history: [] });

const newId = () =>
  `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const isItem = (item) =>
  item &&
  typeof item === 'object' &&
  typeof item.id === 'string' &&
  normalizePhone(item.number) === item.number;

const textOr = (value, fallback = '') =>
  typeof value === 'string' ? value : fallback;

const cleanItem = (item) => ({
  id: item.id,
  number: item.number,
  name: textOr(item.name),
  contactId: typeof item.contactId === 'string' ? item.contactId : null,
  ...(typeof item.note === 'string' && item.note ? { note: item.note } : {}),
});

const historyEntry = (item, outcome, at, extra = {}) => ({
  id: item.id,
  number: item.number,
  name: item.name || '',
  outcome,
  at,
  duration: 0,
  ...extra,
});

const keepHistory = (history) => history.slice(0, HISTORY_LIMIT);

// What a saved queue becomes when the app opens. Pending contacts stay exactly
// as they were. A contact whose call was in progress when the app closed is
// recorded as interrupted and is never redialed or resumed: the person decides
// whether to add it again.
export function normalizeQueue(saved, now = Date.now()) {
  const queue = emptyQueue();
  if (!saved || typeof saved !== 'object') return queue;
  const seen = new Set();
  for (const item of Array.isArray(saved.items) ? saved.items : []) {
    if (!isItem(item) || seen.has(item.number)) continue;
    seen.add(item.number);
    queue.items.push(cleanItem(item));
  }
  queue.history = keepHistory(
    (Array.isArray(saved.history) ? saved.history : [])
      .filter((h) => h && typeof h.id === 'string' && typeof h.outcome === 'string')
      .map((h) => ({
        id: h.id,
        number: textOr(h.number),
        name: textOr(h.name),
        outcome: h.outcome,
        at: Number.isFinite(h.at) ? h.at : now,
        duration: Number.isFinite(h.duration) ? h.duration : 0,
      })),
  );
  if (isItem(saved.active)) {
    queue.history = keepHistory([
      historyEntry(saved.active, 'interrupted', now),
      ...queue.history,
    ]);
  }
  return queue;
}

export const queuedNumbers = (queue) =>
  new Set(
    [...queue.items, ...(queue.active ? [queue.active] : [])].map(
      (i) => i.number,
    ),
  );

// Adds each entry ({ number, name, contactId }) that is a valid number not
// already pending or active. Returns the new queue plus what was skipped.
export function addToQueue(queue, entries, makeId = newId) {
  const known = queuedNumbers(queue);
  const added = [],
    duplicates = [],
    invalid = [];
  for (const entry of entries) {
    const number = normalizePhone(entry.number);
    if (!number) invalid.push(entry);
    else if (known.has(number)) duplicates.push({ ...entry, number });
    else {
      known.add(number);
      added.push({
        id: makeId(),
        number,
        name: textOr(entry.name).trim(),
        contactId: entry.contactId || null,
      });
    }
  }
  return {
    queue: added.length
      ? { ...queue, items: [...queue.items, ...added] }
      : queue,
    added,
    duplicates,
    invalid,
  };
}

export function moveItem(queue, id, delta) {
  const from = queue.items.findIndex((i) => i.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= queue.items.length) return queue;
  const items = [...queue.items];
  [items[from], items[to]] = [items[to], items[from]];
  return { ...queue, items };
}

export const removeItem = (queue, id) =>
  queue.items.some((i) => i.id === id)
    ? { ...queue, items: queue.items.filter((i) => i.id !== id) }
    : queue;

// Skipping the next contact records it and leaves the one after it waiting.
export function skipItem(queue, id, now = Date.now()) {
  const item = queue.items.find((i) => i.id === id);
  if (!item) return queue;
  return {
    ...queue,
    items: queue.items.filter((i) => i.id !== id),
    history: keepHistory([historyEntry(item, 'skipped', now), ...queue.history]),
  };
}

export const clearHistory = (queue) =>
  queue.history.length ? { ...queue, history: [] } : queue;

// Whether a pending contact still matches the address book entry it came
// from. A changed or removed contact must be reviewed before it is dialed.
export function reviewState(item, contacts) {
  if (!item.contactId) return null;
  const contact = contacts.find((c) => c.id === item.contactId);
  if (!contact) return { kind: 'removed' };
  if (contact.number !== item.number || contact.name !== item.name)
    return { kind: 'changed', contact };
  return null;
}

// "Use current details": the item takes the contact's name and number, unless
// that number is already pending or active, in which case it leaves the queue.
// "Keep this number" on a removed contact keeps the number as a plain entry.
export function acceptReview(queue, id, contacts) {
  const item = queue.items.find((i) => i.id === id);
  if (!item) return { queue, merged: false };
  const state = reviewState(item, contacts);
  if (!state) return { queue, merged: false };
  if (state.kind === 'removed')
    return {
      queue: {
        ...queue,
        items: queue.items.map((i) =>
          i.id === id ? { ...i, contactId: null } : i,
        ),
      },
      merged: false,
    };
  const { contact } = state;
  const taken = [
    ...queue.items.filter((i) => i.id !== id),
    ...(queue.active ? [queue.active] : []),
  ].some((i) => i.number === contact.number);
  if (taken) return { queue: removeItem(queue, id), merged: true };
  return {
    queue: {
      ...queue,
      items: queue.items.map((i) =>
        i.id === id
          ? { ...i, name: contact.name, number: contact.number }
          : i,
      ),
    },
    merged: false,
  };
}

// The press. Starts only the contact the person was looking at (`id` must be
// the head of the queue) and only when nothing is active. Callers check
// readiness first; this still refuses a second contact or a stale press.
export function beginCall(queue, id, now = Date.now()) {
  const [head, ...rest] = queue.items;
  if (queue.active || !head || head.id !== id) return queue;
  const { note, ...item } = head;
  return { ...queue, items: rest, active: { ...item, startedAt: now, callId: null } };
}

export const attachCall = (queue, id, callId) =>
  queue.active && queue.active.id === id
    ? { ...queue, active: { ...queue.active, callId } }
    : queue;

// The call never started: nothing was dialed, so the contact goes back to the
// front with the reason. It is not retried until the next press.
export function failStart(queue, id, reason) {
  if (!queue.active || queue.active.id !== id) return queue;
  const { startedAt, callId, ...item } = queue.active;
  return {
    ...queue,
    items: [{ ...item, note: reason }, ...queue.items],
    active: null,
  };
}

// Records how the active call ended. `lastCall` is the voice service's record
// of a finished call; only the call this queue started (by id) counts. The
// next contact stays pending.
export function finishCall(queue, lastCall) {
  const active = queue.active;
  if (!active || !active.callId || !lastCall || lastCall.id !== active.callId)
    return queue;
  return {
    ...queue,
    active: null,
    history: keepHistory([
      historyEntry(active, lastCall.outcome || 'completed', lastCall.at || Date.now(), {
        duration: lastCall.duration || 0,
      }),
      ...queue.history,
    ]),
  };
}

// Why "Call next" cannot dial right now, or null when it can.
export function callNextBlocker({
  queue,
  contacts,
  voiceState,
  incoming,
  busy,
}) {
  if (queue.active) return 'A queued call is in progress.';
  if (!queue.items.length) return 'The queue is empty.';
  if (incoming) return 'An incoming call needs an answer first.';
  if (busy) return 'Another call is starting or in progress.';
  if (voiceState !== 'registered')
    return 'Calling is unavailable until the voice device registers. Your queue is kept.';
  if (reviewState(queue.items[0], contacts))
    return 'Review this contact before calling.';
  return null;
}

export const OUTCOME_LABELS = {
  completed: 'Completed',
  unanswered: 'No answer',
  declined: 'Declined',
  busy: 'Busy',
  failed: 'Failed',
  canceled: 'Canceled by you',
  skipped: 'Skipped',
  interrupted: 'Interrupted: the app closed during this call; not redialed',
};
export const outcomeLabel = (outcome) =>
  OUTCOME_LABELS[outcome] ||
  outcome.charAt(0).toUpperCase() + outcome.slice(1);
