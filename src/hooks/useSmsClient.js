import { useEffect, useState, useCallback, useRef } from 'react';
import { SmsService } from '../services/smsService';

/**
 * useSmsClient
 * Singleton SmsService bound to component lifecycle. Mirrors the
 * voice service hook: subscribes to the snapshot, exposes action
 * callbacks, cleans up on unmount.
 *
 * Calls start() on mount and stop() on unmount. If the App already
 * has a configured account (i.e. voice is registered), the SMS
 * service will start polling immediately and surface existing
 * conversations in the panel.
 */
export function useSmsClient() {
  const serviceRef = useRef(null);
  if (!serviceRef.current) {
    serviceRef.current = new SmsService();
  }
  const service = serviceRef.current;

  const [snapshot, setSnapshot] = useState(service.snapshot());

  useEffect(() => {
    return service.subscribe(setSnapshot);
  }, [service]);

  useEffect(() => {
    // Start polling when the hook mounts. The service is idempotent
    // about start(), so a double-mount (StrictMode dev) is safe.
    service.start().catch(() => {
      // start() already records the error on the snapshot.
    });
    return () => {
      service.stop();
    };
  }, [service]);

  const refresh = useCallback(() => service._refresh(), [service]);
  const send = useCallback(
    (payload) => service.send(payload),
    [service]
  );
  const getThread = useCallback(
    (number) => service.getThread(number),
    [service]
  );
  const destroy = useCallback(() => service.destroy(), [service]);

  return {
    service,
    snapshot,
    refresh,
    send,
    getThread,
    destroy,
  };
}
