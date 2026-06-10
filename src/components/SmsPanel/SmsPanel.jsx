// SmsPanel — chat-style SMS UI.
//
// Three regions inside a single dark panel:
//   - Left: conversation list (number, last body, direction indicator,
//     timestamp, message count)
//   - Right: thread view (bubbles, status indicators, auto-scroll)
//   - Bottom: composer (text input + send button + char counter)
//
// State (selected number, composer text) is local to the component. The
// service owns the data; the panel just renders it and routes user
// actions back through the service.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSms } from '../../contexts/SmsContext';

const MAX_BODY = 1600;
const POLL_WHILE_OPEN_MS = 3000; // matches service poll cadence

function formatTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatNumber(n) {
  // +155****0100 → +1 555 0100 (rough; no real formatting library)
  if (!n) return '';
  if (n.length <= 4) return n;
  // Keep + and country code, group the rest in 3s
  const plus = n.startsWith('+') ? '+' : '';
  const digits = n.replace(/^\+/, '');
  if (digits.length <= 4) return n;
  const cc = digits.slice(0, digits.length - 10);
  const tail = digits.slice(-10);
  const grouped = tail.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');
  return cc ? `${plus}${cc} ${grouped}` : grouped;
}

function ConversationList({ conversations, selected, onSelect, error }) {
  if (error) {
    return (
      <div className="sms-list error">
        <div className="sms-list-empty muted small">
          Could not load conversations.
        </div>
      </div>
    );
  }
  if (!conversations || conversations.length === 0) {
    return (
      <div className="sms-list empty">
        <div className="sms-list-empty muted small">
          No conversations yet. Send a message to start one.
        </div>
      </div>
    );
  }
  return (
    <div className="sms-list" role="listbox" aria-label="Conversations">
      {conversations.map((c) => {
        const isSelected = selected === c.number;
        return (
          <button
            key={c.number}
            type="button"
            role="option"
            aria-selected={isSelected}
            className={`sms-list-item${isSelected ? ' selected' : ''}`}
            onClick={() => onSelect(c.number)}
          >
            <div className="sms-list-row1">
              <span className="sms-list-number">{formatNumber(c.number)}</span>
              <span className="sms-list-time muted small">
                {formatTime(c.lastMessageAt)}
              </span>
            </div>
            <div className="sms-list-row2">
              <span
                className={`sms-list-direction ${c.lastDirection || ''}`}
                aria-hidden="true"
              >
                {c.lastDirection === 'outbound' ? '↗' : c.lastDirection === 'inbound' ? '↙' : '·'}
              </span>
              <span className="sms-list-preview">{c.lastBody || <span className="muted">(empty)</span>}</span>
              {c.messageCount > 1 && (
                <span className="sms-list-count muted small">{c.messageCount}</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// True if the thread has any outbound message whose status is not yet a
// terminal state (delivered / failed / undelivered). Used to decide
// whether to re-fetch the thread on each poll — if everything has
// settled, no need to keep polling.
function threadHasUnsettledOutbound(thread) {
  if (!thread || !Array.isArray(thread.messages)) return false;
  const SETTLED = new Set(['delivered', 'failed', 'undelivered']);
  for (const m of thread.messages) {
    if (m.direction === 'outbound' && m.status && !SETTLED.has(m.status)) {
      return true;
    }
  }
  return false;
}

function StatusBadge({ status }) {
  // Maps Twilio/local statuses to a short label + CSS class.
  // Unknown / absent status → nothing.
  if (!status) return null;
  const map = {
    sending: { label: 'sending', cls: 'pending' },
    sent: { label: 'sent', cls: 'sent' },
    queued: { label: 'queued', cls: 'pending' },
    delivered: { label: 'delivered', cls: 'delivered' },
    failed: { label: 'failed', cls: 'fail' },
    undelivered: { label: 'undelivered', cls: 'fail' },
    received: { label: '', cls: '' },
  };
  const m = map[status] || { label: status, cls: 'pending' };
  if (!m.label) return null;
  return <span className={`sms-status ${m.cls}`}>{m.label}</span>;
}

function ThreadView({ thread, loading, error }) {
  const scrollRef = useRef(null);
  useEffect(() => {
    // Auto-scroll to bottom when messages change.
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [thread]);

  if (loading) {
    return (
      <div className="sms-thread empty">
        <div className="muted small">Loading…</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="sms-thread empty">
        <div className="error small">{error}</div>
      </div>
    );
  }
  if (!thread || !thread.messages || thread.messages.length === 0) {
    return (
      <div className="sms-thread empty">
        <div className="muted small">
          No messages yet. Type below to start the conversation.
        </div>
      </div>
    );
  }
  return (
    <div className="sms-thread" ref={scrollRef}>
      {thread.messages.map((m) => (
        <div
          key={m.sid || `${m.at}-${m.body}`}
          className={`sms-bubble ${m.direction}`}
        >
          <div className="sms-bubble-body">{m.body}</div>
          <div className="sms-bubble-meta">
            <span className="muted small">{formatTime(m.at)}</span>
            {m.direction === 'outbound' && <StatusBadge status={m.status} />}
          </div>
        </div>
      ))}
    </div>
  );
}

function Composer({ onSend, disabled }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setErr(null);
    try {
      await onSend(trimmed);
      setText('');
    } catch (e) {
      setErr(e.message || 'send failed');
    } finally {
      setSending(false);
    }
  }, [text, sending, onSend]);

  const handleKey = useCallback(
    (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const remaining = MAX_BODY - text.length;
  const overLimit = text.length > MAX_BODY;

  return (
    <div className="sms-composer">
      {err && <div className="sms-composer-error small">{err}</div>}
      <div className="sms-composer-row">
        <textarea
          className="sms-composer-input"
          placeholder={disabled ? 'Select a conversation first' : 'Type a message…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          disabled={disabled || sending}
          rows={2}
          maxLength={MAX_BODY + 100 /* allow paste over, show counter */}
        />
        <button
          type="button"
          className="sms-composer-send"
          onClick={handleSend}
          disabled={disabled || sending || !text.trim() || overLimit}
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
      <div className="sms-composer-counter muted small">
        {text.length} / {MAX_BODY}
        {overLimit && (
          <span className="error">  · over by {text.length - MAX_BODY}</span>
        )}
        {!overLimit && remaining < 200 && (
          <span>  · {remaining} left</span>
        )}
      </div>
    </div>
  );
}

export function SmsPanel() {
  const { snapshot, send, getThread } = useSms();
  const [selected, setSelected] = useState(null);
  const [thread, setThread] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState(null);
  // Inline "new conversation" UI state. window.prompt is unsupported in
  // React, so we render a small input row at the top of the list instead.
  const [newMode, setNewMode] = useState(false);
  const [newNumber, setNewNumber] = useState('');
  const [newError, setNewError] = useState(null);
  const newInputRef = useRef(null);

  // When the conversation list changes (poll), auto-select the first one
  // if nothing is selected. Also: if the selected conversation's message
  // count went up, refresh the thread silently.
  useEffect(() => {
    if (!snapshot.conversations || snapshot.conversations.length === 0) {
      if (selected !== null) {
        setSelected(null);
        setThread(null);
      }
      return;
    }
    if (selected === null) {
      setSelected(snapshot.conversations[0].number);
    } else {
      const found = snapshot.conversations.find((c) => c.number === selected);
      if (!found) {
        // Selected conversation isn't in the list. Two cases:
        //   (a) User just clicked "+ New" with a number that's never
        //       been texted → thread is the synthesized empty one. Hold
        //       the selection; the first send will create the real
        //       conversation and the next poll will include it.
        //   (b) Conversation was deleted from the store → fall back to
        //       the first one in the list.
        const isUserPickedNew =
          thread &&
          Array.isArray(thread.messages) &&
          thread.messages.length === 0;
        if (!isUserPickedNew) {
          setSelected(snapshot.conversations[0].number);
          setThread(null);
        }
      } else if (
        thread &&
        thread.messages &&
        thread.messages.length > 0 &&
        (found.messageCount > thread.messages.length ||
          // Status callbacks update an existing message's status without
          // changing messageCount — refresh anyway so the badge updates.
          threadHasUnsettledOutbound(thread))
      ) {
        // New message arrived, OR an outbound message still has a
        // status that could update (queued -> sent -> delivered /
        // failed). Refresh the thread in the background.
        getThread(selected)
          .then((t) => setThread(t))
          .catch(() => {
            // Silent: don't blow away the existing view on transient error.
          });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.conversations]);

  // Load the thread whenever the selected number changes.
  useEffect(() => {
    if (!selected) {
      setThread(null);
      return;
    }
    let cancelled = false;
    setThreadLoading(true);
    setThreadError(null);
    getThread(selected)
      .then((t) => {
        if (cancelled) return;
        setThread(t);
      })
      .catch((e) => {
        if (cancelled) return;
        setThreadError(e.message || 'failed to load thread');
      })
      .finally(() => {
        if (cancelled) return;
        setThreadLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, getThread]);

  // When the user picks a conversation, also bump an immediate refresh
  // (the service will poll on its own, but the user expects zero latency).
  useEffect(() => {
    if (!selected) return;
    const t = setTimeout(() => {
      // The service's 3s poll will catch new messages; this is just to
      // make the click feel instant.
    }, POLL_WHILE_OPEN_MS);
    return () => clearTimeout(t);
  }, [selected]);

  const handleSend = useCallback(
    async (body) => {
      if (!selected) return;
      await send({ to: selected, body });
      // After send completes, refresh the open thread to show the new
      // outbound message with the real SID.
      try {
        const t = await getThread(selected);
        setThread(t);
      } catch (_) {
        // Non-fatal; the service's refresh will catch up.
      }
    },
    [selected, send, getThread]
  );

  // Inline "+ New" thread input. Replaces the prior window.prompt() call,
  // which throws in React ("prompt() is and will not be supported").
  const enterNewMode = useCallback(() => {
    setNewMode(true);
    setNewNumber('');
    setNewError(null);
    // Defer focus until the input is mounted.
    setTimeout(() => {
      if (newInputRef.current) newInputRef.current.focus();
    }, 0);
  }, []);

  const cancelNew = useCallback(() => {
    setNewMode(false);
    setNewNumber('');
    setNewError(null);
  }, []);

  const confirmNew = useCallback(() => {
    const digits = newNumber.replace(/[^0-9]/g, '');
    if (digits.length < 7 || digits.length > 15) {
      setNewError('Enter a valid phone number (7–15 digits).');
      return;
    }
    const e164 = '+' + digits;
    setSelected(e164);
    setNewMode(false);
    setNewNumber('');
    setNewError(null);
  }, [newNumber]);

  const onNewKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmNew();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelNew();
      }
    },
    [confirmNew, cancelNew]
  );

  return (
    <div className="sms-panel">
      <div className="sms-panel-header">
        <span className="sms-panel-title">Messages</span>
        <span className="spacer" />
        {!newMode && (
          <button type="button" className="link small" onClick={enterNewMode}>
            + New
          </button>
        )}
      </div>
      {newMode && (
        <div className="sms-new-row">
          <input
            ref={newInputRef}
            type="tel"
            className="sms-new-input"
            placeholder="+1 555 0100"
            value={newNumber}
            onChange={(e) => {
              setNewNumber(e.target.value);
              if (newError) setNewError(null);
            }}
            onKeyDown={onNewKeyDown}
            aria-label="New conversation phone number"
          />
          <button
            type="button"
            className="sms-new-confirm"
            onClick={confirmNew}
            disabled={!newNumber.trim()}
          >
            OK
          </button>
          <button type="button" className="sms-new-cancel" onClick={cancelNew}>
            Cancel
          </button>
          {newError && <div className="sms-new-error small">{newError}</div>}
        </div>
      )}
      <div className="sms-panel-body">
        <div className="sms-panel-list">
          <ConversationList
            conversations={snapshot.conversations}
            selected={selected}
            onSelect={setSelected}
            error={snapshot.lastError}
          />
        </div>
        <div className="sms-panel-main">
          <div className="sms-panel-thread-header">
            {selected ? (
              <span className="sms-panel-thread-number">
                {formatNumber(selected)}
              </span>
            ) : (
              <span className="muted small">No conversation selected</span>
            )}
          </div>
          <ThreadView
            thread={thread}
            loading={threadLoading}
            error={threadError}
          />
          <Composer onSend={handleSend} disabled={!selected} />
        </div>
      </div>
    </div>
  );
}
