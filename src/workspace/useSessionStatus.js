import { useEffect, useState } from 'react';

// The local service and tunnel status from the desktop bridge
// (main/services/session.js), refreshed every few seconds. Null until the
// first answer; { unsupported: true } where the bridge has no such call.
export function useSessionStatus(intervalMs = 5000) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    const api = window.operator && window.operator.session;
    if (!api || typeof api.status !== 'function') {
      setStatus({ unsupported: true });
      return undefined;
    }
    let alive = true;
    const read = async () => {
      try {
        const result = await api.status();
        if (!alive) return;
        setStatus(
          result && result.ok
            ? result
            : { error: (result && result.error) || 'Status unavailable' },
        );
      } catch (err) {
        if (alive) setStatus({ error: err.message || 'Status unavailable' });
      }
    };
    read();
    const timer = setInterval(read, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [intervalMs]);
  return status;
}
