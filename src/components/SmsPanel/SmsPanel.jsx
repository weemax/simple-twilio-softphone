// TWP-9 piece 3: recipient-owned drafts, truthful text messaging and retained reading position.
import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
} from 'react';
import { useSms } from '../../contexts/SmsContext';
import { useWorkspace } from '../../workspace/WorkspaceContext';
import {
  inboundIds,
  messageKey,
  normalizePhone,
  smsEstimate,
  unreadCount,
  uncertainAttempts,
} from '../../workspace/model';
import { ConfirmDialog } from '../../workspace/ConfirmDialog';
import { formatNumber } from '../../formatNumber';

const MAX_BODY = 1600;
const EMPTY_CONVERSATIONS = [];
const NEAR_BOTTOM_PX = 80;
const failed = (status) => ['failed', 'undelivered'].includes(status);
const formatTime = (at) =>
  at
    ? new Date(at).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
const formatDate = (at) =>
  at
    ? new Date(at).toLocaleDateString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : '';

function StatusBadge({ status }) {
  if (!status || status === 'received') return null;
  return (
    <span
      className={`sms-status ${failed(status) ? 'fail' : status === 'delivered' ? 'delivered' : 'pending'}`}
    >
      {status === 'unknown' ? 'Unknown outcome' : status}
    </span>
  );
}

function ThreadView({
  thread,
  loading,
  error,
  active,
  position,
  onPosition,
  jump,
  onResend,
  pinToLatestKey,
}) {
  const savedPosition = useRef(position);
  savedPosition.current = position;
  const ref = useRef(null),
    lastNumber = useRef(null),
    following = useRef(true),
    lastPin = useRef(pinToLatestKey),
    lastJump = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !thread || loading || !active) return;
    if (lastNumber.current !== thread.number) {
      lastNumber.current = thread.number;
      following.current = savedPosition.current?.following ?? true;
      el.scrollTop = following.current
        ? el.scrollHeight
        : savedPosition.current?.top || 0;
    }
    const pin = lastPin.current !== pinToLatestKey;
    lastPin.current = pinToLatestKey;
    if (jump?.number === thread.number && lastJump.current !== jump.id) {
      const target = Array.from(el.querySelectorAll('[data-message-id]')).find(
        (n) => n.dataset.messageId === jump.sid,
      );
      if (target) {
        target.scrollIntoView?.({ block: 'center' });
        target.focus({ preventScroll: true });
        following.current = false;
        lastJump.current = jump.id;
      }
    } else if (pin || following.current) {
      el.scrollTop = el.scrollHeight;
      following.current = true;
    }
  }, [thread, loading, active, jump, pinToLatestKey]);
  let lastDay = '';
  return (
    <div
      className={`sms-thread${!thread?.messages?.length ? ' empty' : ''}`}
      ref={ref}
      aria-label="Message history"
      onScroll={() => {
        const el = ref.current;
        if (!active || !el) return;
        following.current =
          el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
        onPosition({ top: el.scrollTop, following: following.current });
      }}
    >
      {loading && !thread && <p className="muted">Loading…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!error && !loading && !thread?.messages?.length && (
        <p className="muted small">
          No messages yet. Type below to start the conversation.
        </p>
      )}
      {(thread?.messages || []).map((m) => {
        const day = formatDate(m.at),
          showDay = day !== lastDay;
        lastDay = day;
        return (
          <React.Fragment key={messageKey(m)}>
            {showDay && <div className="sms-day">{day}</div>}
            <div
              tabIndex={-1}
              data-message-id={messageKey(m)}
              className={`sms-bubble ${m.direction}${jump?.sid === messageKey(m) ? ' search-hit' : ''}`}
            >
              <div className="sms-bubble-body">{m.body}</div>
              <div className="sms-bubble-meta">
                <time
                  dateTime={new Date(m.at).toISOString()}
                  title={new Date(m.at).toLocaleString()}
                >
                  {formatTime(m.at)}
                </time>
                {m.direction === 'outbound' && (
                  <StatusBadge status={m.status} />
                )}
              </div>
              {failed(m.status) && (
                <div className="sms-failure">
                  <span>
                    {m.error ||
                      'The provider reported that this message did not deliver.'}
                  </span>
                  <button type="button" onClick={() => onResend(m)}>
                    Review resend
                  </button>
                </div>
              )}
              {m.status === 'unknown' && (
                <p className="small">
                  The result is unknown. Check the provider’s message log before
                  sending this text again.
                </p>
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function Composer({
  number,
  name,
  text,
  onText,
  onSend,
  disabled,
  sending,
  uncertain,
  error,
}) {
  const estimate = smsEstimate(text),
    over = text.length > MAX_BODY;
  const attempts = uncertainAttempts(uncertain);
  const blocked = attempts.some((a) => a.body === text.trim());
  return (
    <div className="sms-composer">
      <label className="small muted" htmlFor="message-draft">
        Message draft{number ? ` for ${name || formatNumber(number)}` : ''}
      </label>
      {error && (
        <p className="sms-composer-error small" role="alert">
          {error}
        </p>
      )}
      {attempts.map((a) => (
        <p key={`${a.at}:${a.body}`} className="alert small" role="status">
          Unknown outcome: “{a.body}”. Your draft is retained. Check the
          provider’s message log; this text cannot be resent here while its
          outcome is unknown.
        </p>
      ))}
      <div className="sms-composer-row">
        <textarea
          id="message-draft"
          className="sms-composer-input"
          placeholder={
            disabled ? 'Select a conversation first' : 'Type a message…'
          }
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              if (!disabled && !sending && !over && !blocked && text.trim())
                onSend();
            }
          }}
          disabled={disabled || sending}
          rows={2}
          maxLength={MAX_BODY + 100}
        />
        <button
          type="button"
          className="sms-composer-send"
          onClick={onSend}
          disabled={disabled || sending || !text.trim() || over || blocked}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      <div className="sms-composer-counter muted small">
        {text.length} / {MAX_BODY} · {estimate.encoding} · {estimate.segments}{' '}
        SMS segment{estimate.segments === 1 ? '' : 's'}
        {over && (
          <span className="error"> · over by {text.length - MAX_BODY}</span>
        )}
      </div>
      {estimate.segments > 1 && (
        <p className="segment-warning small">
          This text uses multiple SMS segments. Your provider may charge for
          each segment; sender-specific limits can differ.
        </p>
      )}
      <p className="muted small composer-help">
        Enter sends · Shift+Enter adds a line
      </p>
    </div>
  );
}

export function SmsPanel({ active = true, onCall = () => {} }) {
  const { snapshot, send, getThread, clearThread } = useSms();
  const { data, update, nameFor } = useWorkspace();
  const selected = data.selected;
  const [thread, setThread] = useState(null),
    [loading, setLoading] = useState(false),
    [threadError, setThreadError] = useState('');
  const [newMode, setNewMode] = useState(false),
    [newNumber, setNewNumber] = useState(''),
    [newError, setNewError] = useState('');
  const [query, setQuery] = useState(''),
    [showArchived, setShowArchived] = useState(false),
    [jump, setJump] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false),
    [clearing, setClearing] = useState(false),
    [clearError, setClearError] = useState('');
  const [sending, setSending] = useState({}),
    [sendErrors, setSendErrors] = useState({}),
    [resend, setResend] = useState(null),
    [pin, setPin] = useState(0);
  const autoSelected = useRef(false);
  const pending = useRef(new Set()),
    input = useRef(null),
    selectedRef = useRef(selected);
  selectedRef.current = selected;
  const conversations = snapshot.conversations || EMPTY_CONVERSATIONS;
  const select = useCallback(
    (number, hit = null) => {
      update((d) => ({ ...d, selected: number }));
      setNewMode(false);
      setNewError('');
      if (hit) setJump({ number, sid: messageKey(hit), id: Date.now() });
      else setJump(null);
    },
    [update],
  );
  useEffect(() => {
    if (selected) autoSelected.current = true;
    if (!autoSelected.current && !selected && conversations.length) {
      autoSelected.current = true;
      select(conversations[0].number);
    }
  }, [selected, conversations, select]);
  useEffect(() => {
    if (!selected) {
      setThread(null);
      return;
    }
    let cancelled = false;
    setThread((t) => (t?.number === selected ? t : null));
    setLoading(true);
    setThreadError('');
    getThread(selected)
      .then((t) => {
        if (!cancelled) {
          setThread(t);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setThreadError(e.message || 'Could not load messages.');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selected, conversations, getThread]);
  useEffect(() => {
    setConfirmClear(false);
    setClearError('');
    setResend(null);
  }, [selected]);
  useEffect(() => {
    if (newMode) input.current?.focus();
  }, [newMode]);
  // Reading is local, and only a visible open thread marks its inbound messages read.
  const markRead = useCallback(() => {
    if (
      !active ||
      !selected ||
      document.visibilityState === 'hidden' ||
      !data.seeded
    )
      return;
    // A selected number is not proof the history loaded: mark only rendered messages.
    if (loading || thread?.number !== selected) return;
    const ids = inboundIds(thread);
    if (ids.some((id) => !(data.readIds[selected] || []).includes(id)))
      update((d) => ({
        ...d,
        readIds: { ...d.readIds, [selected]: ids },
      }));
  }, [active, selected, loading, thread, data, update]);
  useEffect(() => {
    markRead();
    document.addEventListener('visibilitychange', markRead);
    return () => document.removeEventListener('visibilitychange', markRead);
  }, [markRead]);
  // A late authoritative status can resolve an earlier transport timeout, but never triggers a resend.
  useEffect(() => {
    const settled = (n, a) =>
      conversations
        .find((c) => c.number === n)
        ?.messages?.some(
          (m) =>
            m.direction === 'outbound' &&
            m.body === a.body &&
            m.at >= a.at &&
            ['sent', 'queued', 'delivered', 'failed', 'undelivered'].includes(
              m.status,
            ),
        );
    if (
      Object.entries(data.uncertain).some(([n, entries]) =>
        uncertainAttempts(entries).some((a) => settled(n, a)),
      )
    ) {
      update((d) => ({
        ...d,
        uncertain: Object.fromEntries(
          Object.entries(d.uncertain)
            .map(([n, entries]) => [
              n,
              uncertainAttempts(entries).filter((a) => !settled(n, a)),
            ])
            .filter(([, entries]) => entries.length),
        ),
      }));
    }
  }, [conversations, data.uncertain, update]);

  async function sendText(number, body) {
    if (pending.current.has(number)) return;
    if (
      uncertainAttempts(data.uncertain[number]).some((a) => a.body === body)
    ) {
      setSendErrors((s) => ({
        ...s,
        [number]:
          'This text has an unknown result. Check the provider’s message log before resending.',
      }));
      return;
    }
    pending.current.add(number);
    setSending((s) => ({ ...s, [number]: true }));
    setSendErrors((s) => ({ ...s, [number]: '' }));
    const attempt = { body, at: Date.now() };
    const removeAttempt = (d) => {
      const uncertain = { ...d.uncertain };
      uncertain[number] = uncertainAttempts(uncertain[number]).filter(
        (a) => a.at !== attempt.at || a.body !== body,
      );
      if (!uncertain[number].length) delete uncertain[number];
      return uncertain;
    };
    update((d) => ({
      ...d,
      uncertain: {
        ...d.uncertain,
        [number]: [...uncertainAttempts(d.uncertain[number]), attempt],
      },
    }));
    try {
      await send({ to: number, body });
      update((d) => {
        const uncertain = removeAttempt(d);
        return {
          ...d,
          uncertain,
          drafts: {
            ...d.drafts,
            [number]:
              d.drafts[number]?.trim() === body ? '' : d.drafts[number] || '',
          },
        };
      });
      if (selectedRef.current === number) {
        setPin((k) => k + 1);
        try {
          const refreshed = await getThread(number);
          if (selectedRef.current === number) setThread(refreshed);
        } catch (_) {
          /* A failed refresh does not undo an acknowledged send. */
        }
      }
    } catch (e) {
      if (e.outcome === 'failed')
        update((d) => ({ ...d, uncertain: removeAttempt(d) }));
      setSendErrors((s) => ({
        ...s,
        [number]:
          e.outcome === 'failed'
            ? e.message
            : 'The send result is unknown. Nothing will be resent automatically.',
      }));
      try {
        const t = await getThread(number);
        if (selectedRef.current === number) setThread(t);
      } catch (_) {}
    } finally {
      pending.current.delete(number);
      setSending((s) => ({ ...s, [number]: false }));
    }
  }
  function confirmNew() {
    const n = normalizePhone(newNumber);
    if (!n) {
      setNewError(
        'Enter a valid international phone number, including + and country code.',
      );
      return;
    }
    update((d) => ({ ...d, archived: { ...d.archived, [n]: false } }));
    select(n);
    setNewNumber('');
  }
  async function clear() {
    const n = selected;
    if (!n || clearing) return;
    setClearing(true);
    setClearError('');
    try {
      const t = await clearThread(n);
      if (selectedRef.current === n)
        setThread(t || { number: n, messages: [] });
      setConfirmClear(false);
    } catch (e) {
      setClearError(e.message || 'Could not clear local history.');
    } finally {
      setClearing(false);
    }
  }
  const term = query.trim().toLowerCase();
  const list = conversations.filter(
    (c) => Boolean(data.archived[c.number]) === showArchived,
  );
  const matches = list
    .map((c) => ({
      c,
      hits: term
        ? (c.messages || []).filter((m) => m.body.toLowerCase().includes(term))
        : [],
    }))
    .filter(
      ({ c, hits }) =>
        !term ||
        `${nameFor(c.number)} ${c.number}`.toLowerCase().includes(term) ||
        hits.length,
    );
  const ourNumber = snapshot.smsFrom || snapshot.callerId;
  const currentThread = thread?.number === selected ? thread : null;
  const text = data.drafts[selected] || '';
  return (
    <section
      className={`sms-panel${selected ? ' has-selection' : ''}`}
      aria-label="Messages"
    >
      <div className="sms-panel-header">
        <h2 className="sms-panel-title">Messages</h2>
        {ourNumber && (
          <span className="sms-panel-from small">
            <span className="muted">Your number </span>
            {formatNumber(ourNumber)}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="link small"
          onClick={() => {
            setNewMode(true);
            setNewNumber('');
            setNewError('');
          }}
        >
          + New
        </button>
      </div>
      {newMode && (
        <div className="sms-new-row">
          <label className="field">
            Contact or international number
            <input
              ref={input}
              className="sms-new-input"
              type="tel"
              list="message-contacts"
              value={newNumber}
              onChange={(e) => {
                setNewNumber(e.target.value);
                setNewError('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  confirmNew();
                } else if (e.key === 'Escape') setNewMode(false);
              }}
              aria-label="New conversation phone number"
              placeholder="+1 202 555 0101"
            />
          </label>
          <datalist id="message-contacts">
            {data.contacts.map((c) => (
              <option key={c.id} value={c.number}>
                {c.name}
              </option>
            ))}
          </datalist>
          <button
            type="button"
            className="sms-new-confirm"
            onClick={confirmNew}
            disabled={!newNumber.trim()}
          >
            OK
          </button>
          <button
            type="button"
            className="sms-new-cancel"
            onClick={() => setNewMode(false)}
          >
            Cancel
          </button>
          {newError && (
            <p className="sms-new-error small" role="alert">
              {newError}
            </p>
          )}
        </div>
      )}
      <div className="sms-panel-body">
        <div className="sms-panel-list">
          <label className="field inbox-search">
            Search messages
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name, number or message text"
            />
          </label>
          <button
            type="button"
            className="archive-filter"
            aria-pressed={showArchived}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? 'Show inbox' : 'Show archived'}
          </button>
          {snapshot.lastError && (
            <p className="error small" role="alert">
              Could not update messages. Stored messages remain visible.
            </p>
          )}
          {!list.length && (
            <div className="sms-list-empty muted small">
              {showArchived
                ? 'No archived conversations.'
                : 'No conversations yet. Send a message to start one.'}
            </div>
          )}
          <div className="sms-list" aria-label="Conversations">
            {matches.map(({ c, hits }) => (
              <div key={c.number}>
                <button
                  type="button"
                  className={`sms-list-item${selected === c.number ? ' selected' : ''}`}
                  aria-pressed={selected === c.number}
                  onClick={() => select(c.number, hits[0])}
                >
                  <div className="sms-list-row1">
                    <span className="sms-list-number">
                      {nameFor(c.number) || formatNumber(c.number)}
                    </span>
                    <span className="sms-list-time muted small">
                      {formatDate(c.lastMessageAt)}
                    </span>
                  </div>
                  {nameFor(c.number) && (
                    <div className="muted small">{formatNumber(c.number)}</div>
                  )}
                  <div className="sms-list-row2">
                    <span className="sms-list-preview">
                      {data.drafts[c.number]
                        ? `Draft: ${data.drafts[c.number]}`
                        : c.lastBody || '(empty)'}
                    </span>
                    {data.seeded && unreadCount(c, data) > 0 && (
                      <span
                        className="badge"
                        aria-label={`${unreadCount(c, data)} unread`}
                      >
                        {unreadCount(c, data)}
                      </span>
                    )}
                  </div>
                </button>
                {hits.map((m) => (
                  <button
                    type="button"
                    className="search-result"
                    key={messageKey(m)}
                    onClick={() => select(c.number, m)}
                  >
                    {m.body}
                    <span className="muted small">
                      {' '}
                      · {formatDate(m.at)} {formatTime(m.at)}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          {term && !matches.length && (
            <p className="muted small">
              No matches in {showArchived ? 'archived' : 'inbox'} history.
            </p>
          )}
        </div>
        <div className="sms-panel-main">
          <div className="sms-panel-thread-header">
            <button
              type="button"
              className="thread-back"
              onClick={() => update((d) => ({ ...d, selected: null }))}
            >
              Back to conversations
            </button>
            {selected ? (
              <div>
                <strong className="sms-panel-thread-number">
                  {nameFor(selected) || formatNumber(selected)}
                </strong>
                {nameFor(selected) && (
                  <div className="muted small">{formatNumber(selected)}</div>
                )}
              </div>
            ) : (
              <span className="muted small">No conversation selected</span>
            )}
            <span className="spacer" />
            {selected && (
              <div className="button-row">
                <button type="button" onClick={() => onCall(selected)}>
                  Call
                </button>
                <button
                  type="button"
                  onClick={() =>
                    update((d) => ({
                      ...d,
                      archived: {
                        ...d.archived,
                        [selected]: !d.archived[selected],
                      },
                    }))
                  }
                >
                  {data.archived[selected] ? 'Restore' : 'Archive'}
                </button>
                {!!currentThread?.messages?.length &&
                  !loading &&
                  (confirmClear ? (
                    <span className="sms-thread-clear-prompt">
                      <span className="muted small">Clear local history?</span>
                      <button
                        type="button"
                        className="danger"
                        onClick={clear}
                        disabled={clearing}
                      >
                        Clear
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmClear(false)}
                        disabled={clearing}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label="Clear messages in this thread"
                      onClick={() => setConfirmClear(true)}
                    >
                      Clear local history
                    </button>
                  ))}
              </div>
            )}
          </div>
          {data.archived[selected] && (
            <p className="muted small archive-notice">
              Archived · message history is preserved.
            </p>
          )}
          {clearError && (
            <p className="sms-thread-clear-error error small" role="alert">
              {clearError}
            </p>
          )}
          <ThreadView
            thread={currentThread}
            loading={loading}
            error={threadError}
            active={active}
            position={data.scroll[selected]}
            onPosition={(p) =>
              update((d) => ({ ...d, scroll: { ...d.scroll, [selected]: p } }))
            }
            jump={jump}
            onResend={(m) => setResend({ number: selected, message: m })}
            pinToLatestKey={pin}
          />
          <Composer
            key={selected || 'none'}
            number={selected}
            name={nameFor(selected)}
            text={text}
            onText={(value) =>
              update((d) => ({
                ...d,
                drafts: { ...d.drafts, [selected]: value },
              }))
            }
            onSend={() => sendText(selected, text.trim())}
            disabled={!selected}
            sending={Boolean(sending[selected])}
            uncertain={data.uncertain[selected]}
            error={sendErrors[selected]}
          />
        </div>
      </div>
      {resend && (
        <ConfirmDialog
          title="Resend failed message?"
          confirmLabel="Resend message"
          disabled={Boolean(sending[resend.number])}
          onCancel={() => setResend(null)}
          onConfirm={() => {
            const r = resend;
            setResend(null);
            sendText(r.number, r.message.body);
          }}
        >
          <p>
            {nameFor(resend.number)} {formatNumber(resend.number)}
          </p>
          <blockquote>{resend.message.body}</blockquote>
          <p>
            The provider confirmed this message failed. Resending creates
            another billable message.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
