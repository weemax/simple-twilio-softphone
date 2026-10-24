import React, { useState } from 'react';
import { formatNumber } from '../formatNumber';
import { outcomeLabel, reviewState } from './queue';

function Person({ item }) {
  return (
    <>
      <strong>{item.name || formatNumber(item.number)}</strong>
      {item.name && <div className="muted small">{formatNumber(item.number)}</div>}
    </>
  );
}

// Shown where a pending contact no longer matches its address book entry.
function Review({ item, state, onUse, onRemove }) {
  return (
    <div className="queue-review" role="group" aria-label={`Review ${item.name || item.number}`}>
      {state.kind === 'removed' ? (
        <p>
          This contact was removed from Contacts. It was queued as{' '}
          {formatNumber(item.number)}. Review it before calling.
        </p>
      ) : (
        <p>
          This contact changed after it was queued. Queued as{' '}
          {item.name || 'no name'}, {formatNumber(item.number)}; now{' '}
          {state.contact.name}, {formatNumber(state.contact.number)}. Review it
          before calling.
        </p>
      )}
      <div className="button-row">
        <button type="button" onClick={onUse}>
          {state.kind === 'removed' ? 'Keep this number' : 'Use current details'}
        </button>
        <button type="button" onClick={onRemove}>
          Remove from queue
        </button>
      </div>
    </div>
  );
}

// Calls → Queue. Every contact waits for its own press of Call next: nothing
// here advances, redials or resumes by itself.
export function CallQueue({ queueApi, voiceStatus, onAddContacts }) {
  const { queue, contacts, blocker, starting, startError, callNext, review, move, remove, skip, clearOutcomes } =
    queueApi;
  const [notice, setNotice] = useState('');
  const head = queue.items[0];
  const headReview = head && reviewState(head, contacts);
  const acceptReviewed = (id) => {
    setNotice(
      review(id)
        ? 'That number is already in the queue, so the duplicate was removed.'
        : '',
    );
  };
  return (
    <section className="call-queue" aria-label="Call queue">
      <p className="muted small">
        Each contact needs its own press of Call next. The queue never dials
        the next contact, redials or resumes by itself.
      </p>
      {notice && <p role="status">{notice}</p>}
      {startError && (
        <p className="alert" role="alert">
          {startError}
        </p>
      )}
      <div className="panel queue-next" aria-label="Next contact">
        {queue.active ? (
          <>
            <h3>On a call</h3>
            <Person item={queue.active} />
            <p role="status">
              {starting ? 'Starting the call…' : voiceStatus || 'Calling…'}
            </p>
            <p className="muted small">
              Mute, keypad and Hang up are in the call controls. When this call ends, the next contact waits for you.
            </p>
          </>
        ) : head ? (
          <>
            <h3>Next contact</h3>
            <Person item={head} />
            {head.note && <p className="muted small">Last attempt: {head.note}</p>}
            {headReview && (
              <Review
                item={head}
                state={headReview}
                onUse={() => acceptReviewed(head.id)}
                onRemove={() => remove(head.id)}
              />
            )}
            <p className="muted small" role="status">
              {blocker || 'Ready to call.'}
            </p>
            <div className="button-row">
              <button
                type="button"
                className="primary"
                disabled={Boolean(blocker)}
                aria-label={`Call next: ${head.name || formatNumber(head.number)}, ${formatNumber(head.number)}`}
                onClick={() => callNext(head.id)}
              >
                Call next
              </button>
              <button type="button" onClick={() => skip(head.id)}>
                Skip
              </button>
              <button type="button" onClick={onAddContacts}>
                Add contacts
              </button>
            </div>
          </>
        ) : (
          <>
            <h3>The queue is empty</h3>
            <p>
              Add contacts from Contacts or a conversation. Nothing is called
              until you press Call next.
            </p>
            <div className="button-row">
              <button type="button" onClick={onAddContacts}>
                Add contacts
              </button>
            </div>
          </>
        )}
      </div>
      {queue.items.length > 0 && (
        <>
          <h3>Waiting ({queue.items.length})</h3>
          <ol className="queue-list">
            {queue.items.map((item, i) => {
              const state = reviewState(item, contacts);
              return (
                <li className="panel queue-row" key={item.id}>
                  <span className="queue-number" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div>
                    <Person item={item} />
                    {state && i > 0 && (
                      <Review
                        item={item}
                        state={state}
                        onUse={() => acceptReviewed(item.id)}
                        onRemove={() => remove(item.id)}
                      />
                    )}
                  </div>
                  <div className="button-row">
                    <button
                      type="button"
                      aria-label={`Move ${item.name || item.number} up`}
                      disabled={i === 0}
                      onClick={() => move(item.id, -1)}
                    >
                      Move up
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${item.name || item.number} down`}
                      disabled={i === queue.items.length - 1}
                      onClick={() => move(item.id, 1)}
                    >
                      Move down
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${item.name || item.number} from queue`}
                      onClick={() => remove(item.id)}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {queue.history.length > 0 && (
        <>
          <div className="page-heading">
            <h3>Outcomes</h3>
            <button type="button" onClick={clearOutcomes}>
              Clear outcomes
            </button>
          </div>
          <ul className="queue-outcomes">
            {queue.history.map((h) => (
              <li className="panel" key={`${h.id}-${h.at}`}>
                <strong>{h.name || formatNumber(h.number)}</strong>
                {h.name && <span> · {formatNumber(h.number)}</span>}
                <p className="muted small">
                  {outcomeLabel(h.outcome)}
                  {h.duration ? ` · ${h.duration}s` : ''} ·{' '}
                  {new Date(h.at).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
