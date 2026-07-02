import React, { createContext, useContext } from 'react';
import { useSmsClient } from '../hooks/useSmsClient';

// Exported so tests can mount a mock provider without spinning up the
// real useSmsClient. App code should prefer useSms() over the raw
// context object.
export const SmsContext = createContext(null);

export function SmsProvider({ children }) {
  const client = useSmsClient();
  return (
    <SmsContext.Provider value={client}>{children}</SmsContext.Provider>
  );
}

export function useSms() {
  const ctx = useContext(SmsContext);
  if (!ctx) {
    throw new Error('useSms must be used inside <SmsProvider>');
  }
  return ctx;
}
