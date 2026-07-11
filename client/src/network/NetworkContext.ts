import { createContext, type MutableRefObject } from 'react';
import type { Identity } from 'spacetimedb';
import type { DbConnection } from '../generated';

export type NetworkState = {
  connected: boolean;
  connRef: MutableRefObject<DbConnection | null>;
  databaseName: string;
  forgetSavedConnection: () => void;
  hasSavedCharacter: boolean;
  identity: Identity | null;
};

export const NetworkContext = createContext<NetworkState | null>(null);
