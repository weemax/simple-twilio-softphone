// Accepted TWP-9 piece 5: the contact queue is manual. Each destination waits
// for its own "Call next" press; nothing advances, redials or resumes.
import {
  acceptReview,
  addToQueue,
  attachCall,
  beginCall,
  callNextBlocker,
  emptyQueue,
  failStart,
  finishCall,
  moveItem,
  normalizeQueue,
  removeItem,
  reviewState,
  skipItem,
} from './queue';

const alex = { id: 'c1', name: 'Alex Rivera', number: '+12025550101' };
const jamie = { id: 'c2', name: 'Jamie Chen', number: '+12025550103' };
const morgan = { id: 'c3', name: 'Morgan Lee', number: '+442079460958' };
const entry = (c) => ({ number: c.number, name: c.name, contactId: c.id });
let n = 0;
const makeId = () => `q${++n}`;
const filled = () =>
  addToQueue(emptyQueue(), [alex, jamie, morgan].map(entry), makeId).queue;

it('deduplicates pending and active numbers however they are written, and keeps order', () => {
  const first = addToQueue(
    emptyQueue(),
    [entry(alex), { number: '+1 (202) 555-0101', name: 'Alex again' }, entry(jamie)],
    makeId,
  );
  expect(first.queue.items.map((i) => i.number)).toEqual([
    '+12025550101',
    '+12025550103',
  ]);
  expect(first.duplicates).toHaveLength(1);
  const calling = beginCall(first.queue, first.queue.items[0].id);
  const second = addToQueue(calling, [entry(alex), entry(morgan), { number: '2025550104' }], makeId);
  expect(second.added.map((i) => i.number)).toEqual(['+442079460958']);
  expect(second.duplicates.map((i) => i.number)).toEqual(['+12025550101']);
  expect(second.invalid).toHaveLength(1);
});

it('reorders, removes and skips without touching the other pending contacts', () => {
  let q = filled();
  const [a, j, m] = q.items.map((i) => i.id);
  q = moveItem(q, m, -1);
  expect(q.items.map((i) => i.id)).toEqual([a, m, j]);
  expect(moveItem(q, a, -1)).toBe(q);
  expect(moveItem(q, j, 1)).toBe(q);
  q = skipItem(q, a, 5);
  expect(q.items.map((i) => i.id)).toEqual([m, j]);
  expect(q.history[0]).toMatchObject({ id: a, outcome: 'skipped', at: 5 });
  expect(removeItem(q, m).items.map((i) => i.id)).toEqual([j]);
});

it('starts only the visible contact, only once, and leaves the next one waiting', () => {
  const q = filled();
  const [a, j] = q.items.map((i) => i.id);
  expect(beginCall(q, j)).toBe(q);
  const started = beginCall(q, a, 100);
  expect(started.active).toMatchObject({ id: a, startedAt: 100, callId: null });
  expect(started.items).toHaveLength(2);
  expect(beginCall(started, started.items[0].id)).toBe(started);
  const attached = attachCall(started, a, 'call-1');
  expect(finishCall(attached, { id: 'someone-else', outcome: 'completed' })).toBe(attached);
  const done = finishCall(attached, {
    id: 'call-1',
    outcome: 'completed',
    duration: 42,
    at: 200,
  });
  expect(done.active).toBeNull();
  expect(done.history[0]).toMatchObject({ id: a, outcome: 'completed', duration: 42 });
  // The next contact is still only pending: a finished call starts nothing.
  expect(done.items.map((i) => i.id)).toEqual([j, q.items[2].id]);
  expect(beginCall(done, 'nobody')).toBe(done);
});

it('returns a call that never started to the front without dialing again', () => {
  const q = filled();
  const a = q.items[0].id;
  const failed = failStart(beginCall(q, a), a, 'Device not ready');
  expect(failed.active).toBeNull();
  expect(failed.items[0]).toMatchObject({ id: a, note: 'Device not ready' });
  expect(failed.items).toHaveLength(3);
});

it('keeps pending contacts across a restart and records an in-progress call as interrupted, never resumed', () => {
  const q = filled();
  const calling = attachCall(beginCall(q, q.items[0].id, 1), q.items[0].id, 'call-1');
  // What the file holds after the app was closed mid-call.
  const saved = JSON.parse(JSON.stringify(calling));
  expect(saved.active).not.toBeNull();
  const restored = normalizeQueue(saved, 900);
  expect(restored.active).toBeNull();
  expect(restored.items.map((i) => i.number)).toEqual([jamie.number, morgan.number]);
  expect(restored.history[0]).toMatchObject({ number: alex.number, outcome: 'interrupted', at: 900 });
  // Metadata saved before the queue existed, or damaged, becomes an empty queue.
  expect(normalizeQueue(undefined)).toEqual(emptyQueue());
  expect(
    normalizeQueue({ items: [{ id: 'z', number: '12' }, null, { id: 'y', number: '+12025550101' }, { id: 'x', number: '+12025550101' }] })
      .items.map((i) => i.id),
  ).toEqual(['y']);
});

it('needs review before dialing a contact that changed or was removed', () => {
  const q = filled();
  const [a, j] = q.items;
  expect(reviewState(a, [alex, jamie, morgan])).toBeNull();
  const moved = { ...alex, number: '+12025550199' };
  expect(reviewState(a, [moved, jamie, morgan])).toMatchObject({ kind: 'changed' });
  expect(reviewState(a, [{ ...alex, name: 'Alex R.' }])).toMatchObject({ kind: 'changed' });
  expect(reviewState(j, [alex, morgan])).toEqual({ kind: 'removed' });
  const input = (contacts, queue = q) => ({
    queue,
    contacts,
    voiceState: 'registered',
    incoming: false,
    busy: false,
  });
  expect(callNextBlocker(input([alex, jamie, morgan]))).toBeNull();
  expect(callNextBlocker(input([moved, jamie, morgan]))).toMatch(/Review/);
  // Accepting uses the current number; a removed contact keeps its number.
  const updated = acceptReview(q, a.id, [moved, jamie, morgan]);
  expect(updated.queue.items[0]).toMatchObject({ number: '+12025550199' });
  const kept = acceptReview(q, j.id, [alex, morgan]);
  expect(kept.queue.items[1]).toMatchObject({ contactId: null, number: j.number });
  expect(reviewState(kept.queue.items[1], [alex, morgan])).toBeNull();
  // A changed number that is already queued merges instead of duplicating.
  const clash = acceptReview(q, a.id, [{ ...alex, number: jamie.number }, jamie, morgan]);
  expect(clash.merged).toBe(true);
  expect(clash.queue.items.map((i) => i.number)).toEqual([jamie.number, morgan.number]);
});

it('blocks dialing, but keeps the queue, during a call, an incoming call, or lost connectivity', () => {
  const q = filled();
  const base = { queue: q, contacts: [alex, jamie, morgan], voiceState: 'registered', incoming: false, busy: false };
  expect(callNextBlocker(base)).toBeNull();
  expect(callNextBlocker({ ...base, incoming: true })).toMatch(/incoming/);
  expect(callNextBlocker({ ...base, busy: true })).toMatch(/Another call/);
  expect(callNextBlocker({ ...base, voiceState: 'unregistered' })).toMatch(/kept/);
  expect(callNextBlocker({ ...base, queue: beginCall(q, q.items[0].id) })).toMatch(/in progress/);
  expect(callNextBlocker({ ...base, queue: emptyQueue() })).toMatch(/empty/);
});
