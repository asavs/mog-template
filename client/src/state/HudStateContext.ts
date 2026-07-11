import { createContext } from 'react';
import type { JoinPreferences } from '../authStorage';
import type { PlayerHealth } from '../generated/types';
import type { NetMetrics } from '../netcode';

export type HudState = {
  hudHealth?: PlayerHealth;
  hudMetrics: NetMetrics;
  isJoined: boolean;
  joinPreferences: JoinPreferences;
};

export const HudStateContext = createContext<HudState | null>(null);
