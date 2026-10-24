import React, { useEffect, useState } from 'react';
import { formatNumber } from '../formatNumber';
import { setupService, SID_RE, CONSOLE_NUMBERS_URL, CONSOLE_BUY_URL } from './setupService';

// Settings → Twilio account (accepted TWP-9 piece 2): Account → Number →
// Review → Connected. It only talks to the desktop bridge; the Auth Token a
// person types is sent for saving in server/.env and is never shown again.

const STEPS = [
  ['account', 'Account'],
  ['number', 'Number'],
  ['review', 'Review'],
  ['connected', 'Connected'],
];

const STATUS_LABEL = {
  done: 'Done',
  unchanged: 'Unchanged',
  skipped: 'Left unchanged',
  failed: 'Failed',
  pending: 'Not run',
};

const ACTION_LABEL = {
  create: 'Create',
  update: 'Update',
  replace: 'Replace?',
  unchanged: 'Unchanged',
  unavailable: 'Not available',
  info: 'Saved',
};

function capabilityText(c) {
  const parts = [];
  if (c.voice) parts.push('Calls');
  if (c.sms) parts.push('Texts');
  if (c.mms) parts.push('Photos');
  return parts.length ? parts.join(' · ') : 'No calling or texting';
}

function routeText(route, noun) {
  if (route.state === 'operator') return `${noun} go to Operator`;
  if (route.state === 'blank') return `${noun}: not set`;
  if (route.state === 'stale') return `${noun} go to an Operator application that no longer exists`;
  return `${noun} go to ${route.description}`;
}

function openConsole(url) {
  const open = window.operator?.app?.openExternal;
  if (open) open(url).catch(() => {});
}

export function TwilioSetup({ status, fallbackIdentity, onConnected, onRefresh }) {
  const [step, setStep] = useState('account');
  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [identity, setIdentity] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [numbers, setNumbers] = useState([]);
  const [more, setMore] = useState(false);
  const [numberSid, setNumberSid] = useState('');
  const [review, setReview] = useState(null);
  const [replace, setReplace] = useState({});
  const [result, setResult] = useState(null);
  const [repairNote, setRepairNote] = useState('');

  // Fill the form once from what server/.env already holds (never the token).
  useEffect(() => {
    if (prefilled || !status || status.ok === false) return;
    setAccountSid(status.accountSid || '');
    setPublicBaseUrl(status.publicBaseUrl || '');
    setIdentity(
      status.identity || fallbackIdentity || `operator-${Math.random().toString(36).slice(2, 10)}`,
    );
    if (status.connected) setStep('connected');
    setPrefilled(true);
  }, [status, prefilled, fallbackIdentity]);

  if (!status) return <p role="status">Checking your Twilio setup…</p>;
  if (status.ok === false || status.available === false) {
    return (
      <div className="panel" role="alert">
        <h3>Twilio account</h3>
        <p>
          {status.error ||
            'Setup is not available: the local service has no server/.env to save to.'}
        </p>
        <button type="button" onClick={onRefresh}>
          Try again
        </button>
      </div>
    );
  }

  const fromSession = status.publicBaseUrlSource === 'environment';
  const sidProblem = accountSid && !SID_RE.test(accountSid.trim());
  const needsToken = !status.hasAuthToken && !authToken.trim();
  const input = () => ({
    accountSid: accountSid.trim(),
    authToken: authToken.trim(),
    publicBaseUrl: fromSession ? '' : publicBaseUrl.trim(),
    identity: identity.trim(),
  });

  async function checkAccount(e) {
    e && e.preventDefault();
    setBusy(true);
    setError(null);
    const answer = await setupService.check(input());
    setBusy(false);
    if (!answer.ok) {
      setError({ kind: answer.kind, message: answer.error });
      return;
    }
    setNumbers(answer.numbers);
    setMore(Boolean(answer.more));
    setNumberSid((current) => {
      if (answer.numbers.some((n) => n.sid === current)) return current;
      const saved = answer.numbers.find((n) => n.current);
      return saved ? saved.sid : '';
    });
    setStep('number');
  }

  async function reviewChanges() {
    setBusy(true);
    setError(null);
    setReplace({});
    const answer = await setupService.review({ ...input(), numberSid });
    setBusy(false);
    if (!answer.ok) {
      setError({ kind: answer.kind, message: answer.error });
      return;
    }
    setReview(answer);
    setStep('review');
  }

  async function connect() {
    setBusy(true);
    setError(null);
    const agreed = {};
    for (const row of review ? review.rows : []) {
      if (row.foreign && replace[row.id]) agreed[row.id] = row.fingerprint;
    }
    const answer = await setupService.connect({ ...input(), numberSid, replace: agreed });
    setBusy(false);
    if (answer.steps) {
      setResult(answer);
      setStep('connected');
      if (answer.ok) {
        setAuthToken('');
        const next = await onRefresh();
        onConnected && onConnected(next);
      }
      return;
    }
    setError({ kind: answer.kind, message: answer.error });
  }

  async function checkNow() {
    setBusy(true);
    setRepairNote('');
    const answer = await setupService.repair();
    await onRefresh();
    setBusy(false);
    if (!answer.ok) setRepairNote(answer.error || 'The check did not finish.');
    else if (answer.changes && answer.changes.length) setRepairNote(`Repaired: ${answer.changes.join(' ')}`);
    else setRepairNote('Everything Operator owns is in place. Nothing needed repair.');
  }

  const errorBox = error && (
    <div className="alert" role="alert">
      <strong>
        {error.kind === 'invalid-credentials'
          ? 'Sign-in not accepted'
          : error.kind === 'unreachable'
            ? 'Twilio could not be reached'
            : 'This did not finish'}
      </strong>
      <div>{error.message}</div>
    </div>
  );

  return (
    <div className="panel twilio-setup">
      <h3>Twilio account</h3>
      <ol className="setup-steps" aria-label="Setup steps">
        {STEPS.map(([id, label]) => (
          <li key={id} aria-current={step === id ? 'step' : undefined} className={step === id ? 'active' : ''}>
            {label}
          </li>
        ))}
      </ol>

      {step === 'account' && (
        <form onSubmit={checkAccount} className="setup-form">
          <p className="muted small">
            Operator keeps your Twilio credentials in the local service&apos;s server/.env file, readable only by you.
            The window never shows a saved Auth Token again. Check account makes one read-only request.
          </p>
          <label className="field">
            Account SID
            <input
              type="text"
              value={accountSid}
              onChange={(e) => setAccountSid(e.target.value)}
              placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              autoComplete="off"
              spellCheck="false"
            />
            {sidProblem && <small className="error">This does not look like a Twilio Account SID.</small>}
          </label>
          <label className="field">
            Auth Token {status.hasAuthToken && <span className="muted">(saved in server/.env)</span>}
            <input
              type="password"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              placeholder={status.hasAuthToken ? 'Leave blank to keep the saved token' : 'From console.twilio.com → Account → API keys & tokens'}
              autoComplete="off"
              spellCheck="false"
            />
            <small className="muted">
              Twilio uses the primary Auth Token to sign every call and text it sends here, so the service needs it to check them.
            </small>
          </label>
          <label className="field">
            Public address
            {fromSession ? (
              <>
                <output>{status.publicBaseUrl}</output>
                <small className="muted">From this session&apos;s tunnel. It is not saved.</small>
              </>
            ) : (
              <>
                <input
                  type="url"
                  value={publicBaseUrl}
                  onChange={(e) => setPublicBaseUrl(e.target.value)}
                  placeholder="https://your-name.ngrok-free.app"
                  autoComplete="off"
                  spellCheck="false"
                />
                <small className="muted">
                  The https address Twilio calls to reach this computer. npm run phone fills this in for you.
                </small>
              </>
            )}
          </label>
          <label className="field">
            Identity
            <input type="text" value={identity} onChange={(e) => setIdentity(e.target.value)} spellCheck="false" />
            <small className="muted">One name for this app: it registers with it, and incoming calls ring it.</small>
          </label>
          {errorBox}
          <div className="button-row">
            <button type="submit" className="primary" disabled={busy || !accountSid.trim() || sidProblem || needsToken}>
              {busy ? 'Checking…' : 'Check account'}
            </button>
            {status.connected && (
              <button type="button" onClick={() => setStep('connected')} disabled={busy}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      {step === 'number' && (
        <div className="setup-form">
          <p>
            Choose the one number Operator uses for calls and texts. Operator changes only that number&apos;s settings and never buys numbers.
          </p>
          {!numbers.length && (
            <div className="notice" role="status">
              <strong>This account has no numbers.</strong> Operator does not buy numbers. Add one in the Twilio console,
              then come back and check the account again.
              <div className="button-row">
                <button type="button" onClick={() => openConsole(CONSOLE_BUY_URL)}>
                  Open the Twilio console to add a number
                </button>
              </div>
            </div>
          )}
          <fieldset className="number-list" disabled={busy}>
            <legend>Your Twilio numbers</legend>
            {numbers.map((n) => (
              <label key={n.sid} className="number-choice">
                <input type="radio" name="number" checked={numberSid === n.sid} onChange={() => setNumberSid(n.sid)} />
                <span>
                  <strong>{formatNumber(n.e164)}</strong>
                  {n.current && <span className="badge"> current</span>}
                  <span className="muted small"> · {capabilityText(n.capabilities)}</span>
                  <span className="muted small route-line">{routeText(n.voice, 'Calls')}</span>
                  <span className="muted small route-line">{routeText(n.sms, 'Texts')}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {more && <p className="muted small">Only the first 1000 numbers are shown.</p>}
          {numbers.length > 0 && (
            <p className="muted small">
              None suitable?{' '}
              <button type="button" className="link" onClick={() => openConsole(CONSOLE_NUMBERS_URL)}>
                Manage numbers in the Twilio console
              </button>
              , then choose Check account again.
            </p>
          )}
          {errorBox}
          <div className="button-row">
            <button type="button" onClick={() => setStep('account')} disabled={busy}>
              Back
            </button>
            <button type="button" className="primary" onClick={reviewChanges} disabled={busy || !numberSid}>
              {busy ? 'Reading…' : 'Review changes'}
            </button>
          </div>
        </div>
      )}

      {step === 'review' && review && (
        <div className="setup-form">
          <p>
            Nothing has changed yet. Operator will make exactly these changes to {formatNumber(review.number.e164)} and its own
            key and application, and nothing else in your account.
          </p>
          <ul className="review-rows">
            {review.rows.map((row) => (
              <li key={row.id} className={`review-row ${row.action}`}>
                <div className="review-head">
                  <strong>{row.label}</strong>
                  <span className="badge">{ACTION_LABEL[row.action] || row.action}</span>
                </div>
                <p>{row.detail}</p>
                {row.changes && row.changes.length > 0 && (
                  <ul className="small">
                    {row.changes.map((c) => (
                      <li key={c.field}>
                        {c.field}: {c.from} → {c.to}
                      </li>
                    ))}
                  </ul>
                )}
                {row.notes &&
                  row.notes.map((n) => (
                    <p key={n} className="muted small">
                      {n}
                    </p>
                  ))}
                {row.foreign && (
                  <label className="replace-choice">
                    <input
                      type="checkbox"
                      checked={Boolean(replace[row.id])}
                      onChange={(e) => setReplace((r) => ({ ...r, [row.id]: e.target.checked }))}
                    />{' '}
                    Replace where {row.id === 'voice' ? 'calls' : 'texts'} go now ({row.current}) with Operator
                  </label>
                )}
              </li>
            ))}
          </ul>
          {errorBox}
          <div className="button-row">
            <button type="button" onClick={() => setStep('number')} disabled={busy}>
              Back
            </button>
            <button type="button" className="primary" onClick={connect} disabled={busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      )}

      {step === 'connected' && (
        <div className="setup-form">
          {result ? (
            <>
              {result.ok ? (
                <p role="status">
                  <strong>Connected.</strong> Each step is listed below.
                </p>
              ) : (
                <div className="alert" role="alert">
                  <strong>
                    {result.steps.find((s) => s.id === result.failedStep)?.label || 'A step'} did not finish.
                  </strong>
                  <div>{result.error}</div>
                  <div className="muted small">
                    Steps that finished stay finished. Retry continues from here and creates nothing twice.
                  </div>
                </div>
              )}
              <ol className="result-steps">
                {result.steps.map((s) => (
                  <li key={s.id} className={s.status}>
                    <strong>{s.label}</strong> <span className="badge">{STATUS_LABEL[s.status] || s.status}</span>
                    {s.detail && <div className="small">{s.detail}</div>}
                  </li>
                ))}
              </ol>
              {result.warnings && result.warnings.length > 0 && (
                <ul className="small repair-notes" aria-label="Notes">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <dl className="connection-list">
              <dt>Number</dt>
              <dd>{status.number ? formatNumber(status.number) : 'Not chosen'}</dd>
              <dt>Identity</dt>
              <dd>{status.identity || 'Not set'}</dd>
              <dt>Account SID</dt>
              <dd>{status.accountSid || 'Not set'}</dd>
              <dt>Auth Token</dt>
              <dd>{status.hasAuthToken ? 'Saved in server/.env' : 'Not saved'}</dd>
            </dl>
          )}
          {repairNote && <p role="status">{repairNote}</p>}
          {errorBox}
          <div className="button-row">
            {result && !result.ok && (
              <button type="button" className="primary" onClick={connect} disabled={busy}>
                {busy ? 'Retrying…' : 'Retry'}
              </button>
            )}
            {result && !result.ok && (
              <button type="button" onClick={() => setStep('review')} disabled={busy}>
                Back to review
              </button>
            )}
            {(!result || result.ok) && (
              <>
                <button type="button" onClick={() => { setResult(null); setStep('account'); }} disabled={busy}>
                  Change number
                </button>
                <button type="button" onClick={checkNow} disabled={busy}>
                  {busy ? 'Checking…' : 'Check connection now'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
