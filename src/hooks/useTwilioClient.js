import { useEffect, useState, useCallback, useRef } from 'react';
import { TwilioService } from '../services/twilioService';

/**
 * useTwilioClient
 * Singleton TwilioService bound to component lifecycle.
 * Returns the service instance plus the current snapshot.
 */
export function useTwilioClient() {
  const serviceRef = useRef(null);
  if (!serviceRef.current) {
    serviceRef.current = new TwilioService();
  }
  const service = serviceRef.current;

  const [snapshot, setSnapshot] = useState(service.snapshot());

  useEffect(() => {
    return service.subscribe(setSnapshot);
  }, [service]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      service.destroy();
    };
  }, [service]);

  const placeCall = useCallback(
    (to) => service.placeCall({ to }),
    [service]
  );
  const hangup = useCallback(() => service.hangup(), [service]);
  const acceptIncoming = useCallback(() => service.acceptIncoming(), [service]);
  const rejectIncoming = useCallback(() => service.rejectIncoming(), [service]);
  const toggleMute = useCallback(() => service.toggleMute(), [service]);
  const sendDigits = useCallback((d) => service.sendDigits(d), [service]);
  const register = useCallback((id) => service.register(id), [service]);
  const destroy = useCallback(() => service.destroy(), [service]);

  return {
    service,
    snapshot,
    placeCall,
    hangup,
    acceptIncoming,
    rejectIncoming,
    toggleMute,
    sendDigits,
    register,
    destroy,
  };
}
