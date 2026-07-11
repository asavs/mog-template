import type { ReactNode } from 'react';
import { NetworkContext, type NetworkState } from './NetworkContext';

type NetworkProviderProps = {
  children: ReactNode;
  value: NetworkState;
};

export function NetworkProvider({ children, value }: NetworkProviderProps) {
  return (
    <NetworkContext.Provider value={value}>
      {children}
    </NetworkContext.Provider>
  );
}
