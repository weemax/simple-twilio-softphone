import { useCallback, useEffect, useState } from 'react';
import { setupService } from './setupService';

// What the service knows about the Twilio connection (presence of each
// credential, never a value), refreshed every few seconds so a launch-time
// repair shows up. Null until the first answer; { ok: false, ... } when the
// service cannot be asked.
export function useSetupStatus(intervalMs = 10000) {
  const [status, setStatus] = useState(null);
  const refresh = useCallback(async () => {
    const answer = await setupService.status();
    setStatus(answer);
    return answer;
  }, []);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const answer = await setupService.status();
      if (alive) setStatus(answer);
    };
    read();
    const timer = setInterval(read, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [intervalMs]);
  return { status, refresh };
}
