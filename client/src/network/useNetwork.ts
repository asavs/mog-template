import { useContext } from 'react';
import { NetworkContext } from './NetworkContext';

export function useNetwork() {
  const network = useContext(NetworkContext);
  if (!network) {
    throw new Error('useNetwork must be used within NetworkProvider');
  }
  return network;
}
