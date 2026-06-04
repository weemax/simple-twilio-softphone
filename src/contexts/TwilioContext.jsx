import React, { createContext, useContext } from 'react';
import { useTwilioClient } from '../hooks/useTwilioClient';

const TwilioContext = createContext(null);

export function TwilioProvider({ children }) {
  const client = useTwilioClient();
  return (
    <TwilioContext.Provider value={client}>{children}</TwilioContext.Provider>
  );
}

export function useTwilio() {
  const ctx = useContext(TwilioContext);
  if (!ctx) {
    throw new Error('useTwilio must be used inside <TwilioProvider>');
  }
  return ctx;
}
