import React, { useState, useEffect } from 'react';

const SID_RE = /^AC[a-f0-9]{32}$/i;
const TOKEN_RE = /^[a-f0-9]{32}$/i;

function classifySid(s) {
  if (!s) return null;
  return SID_RE.test(s.trim()) ? 'valid' : 'invalid';
}

function classifyToken(t) {
  if (!t) return null;
  return TOKEN_RE.test(t.trim()) ? 'valid' : 'invalid';
}

export function AccountConfig({ onConfigured, onCancel }) {
  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [identity, setIdentity] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [storageStatus, setStorageStatus] = useState(null);
  const [existing, setExisting] = useState({
    hasSid: false,
    hasToken: false,
  });

  useEffect(() => {
    (async () => {
      try {
        const cfg = await window.operator.config.get();
        const sid = cfg && typeof cfg === 'object' ? cfg.accountSid : null;
        const ident = cfg && typeof cfg === 'object' ? cfg.identity : null;
        const sidStr = typeof sid === 'string' ? sid : '';
        const identStr = typeof ident === 'string' ? ident : '';
        const available = await window.operator.invoke('secrets:available');
        const token = await window.operator.secrets.get('twilioAuthToken');
        setAccountSid(sidStr);
        setIdentity(
          identStr || `operator-${Math.random().toString(36).slice(2, 10)}`
        );
        setStorageStatus(available ? 'encrypted' : 'plaintext-fallback');
        setExisting({ hasSid: Boolean(sidStr), hasToken: Boolean(token) });
      } catch (err) {
        setError(err.message);
      }
    })();
  }, []);

  const sidClass = classifySid(accountSid);
  const tokenClass = classifyToken(authToken);
  const canSave =
    sidClass === 'valid' &&
    (tokenClass === 'valid' || (existing.hasToken && !authToken)) &&
    identity.trim().length > 0;

  async function handleSave(e) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await window.operator.config.set('accountSid', accountSid.trim());
      await window.operator.config.set('identity', identity.trim());
      if (authToken.trim()) {
        const res = await window.operator.secrets.set(
          'twilioAuthToken',
          authToken.trim()
        );
        setStorageStatus(res.encrypted ? 'encrypted' : 'plaintext-fallback');
      }
      setExisting({ hasSid: true, hasToken: true });
      setAuthToken(''); // clear from form; token is in safeStorage now
      if (onConfigured) onConfigured();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    setBusy(true);
    setError(null);
    try {
      await window.operator.config.clear('accountSid');
      await window.operator.config.clear('identity');
      await window.operator.secrets.clear('twilioAuthToken');
      setAccountSid('');
      setAuthToken('');
      setIdentity('');
      setExisting({ hasSid: false, hasToken: false });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account-config">
      <h2>Twilio Account</h2>
      <p className="muted">
        Enter your Twilio credentials to enable calling. They are stored using
        the operating system's encrypted credential store
        {storageStatus === 'encrypted'
          ? ' (active).'
          : storageStatus === 'plaintext-fallback'
          ? ' (fallback: plaintext file — set up a keyring for full security).'
          : '…'}
      </p>

      <form onSubmit={handleSave}>
        <label>
          Account SID
          <input
            type="text"
            value={accountSid}
            onChange={(e) => setAccountSid(e.target.value)}
            placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            autoComplete="off"
            spellCheck="false"
          />
          {sidClass === 'invalid' && (
            <small className="error">Doesn't look like a Twilio Account SID.</small>
          )}
        </label>

        <label>
          Auth Token {existing.hasToken && <span className="muted">(saved)</span>}
          <input
            type="password"
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder={
              existing.hasToken
                ? '•••••••• (leave blank to keep current)'
                : '32-character token from console.twilio.com'
            }
            autoComplete="off"
            spellCheck="false"
          />
          {tokenClass === 'invalid' && (
            <small className="error">Auth Token should be 32 hex characters.</small>
          )}
        </label>

        <label>
          Client Identity
          <input
            type="text"
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
            placeholder="operator-username"
            spellCheck="false"
          />
          <small className="muted">
            Used for the capability token. Choose anything; a name works fine.
          </small>
        </label>

        {error && <div className="alert">{error}</div>}

        <div className="row">
          <button type="submit" disabled={!canSave || busy}>
            {busy ? 'Saving…' : existing.hasToken && !authToken ? 'Update' : 'Save'}
          </button>
          {existing.hasSid && (
            <button
              type="button"
              className="secondary"
              onClick={handleClear}
              disabled={busy}
            >
              Clear
            </button>
          )}
          {onCancel && (
            <button
              type="button"
              className="secondary"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
