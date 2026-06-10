import React, { createContext, useContext } from 'react';
import { useSmsClient } from '../hooks/useSmsClient';

const SmsContext = createContext(null);

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
