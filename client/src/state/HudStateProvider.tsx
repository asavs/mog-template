import { useMemo, type MutableRefObject, type ReactNode } from 'react';
import type { JoinPreferences } from '../authStorage';
import type { PlayerHealth } from '../generated/types';
import type { NetMetrics, TransformSnapshot } from '../netcode';
import { useHudMetrics } from '../hooks/useHudMetrics';
import { HudStateContext, type HudState } from './HudStateContext';

type HudStateProviderProps = {
  children: ReactNode;
  hudHealth?: PlayerHealth;
  isJoined: boolean;
  joinPreferences: JoinPreferences;
  metricsRef: MutableRefObject<NetMetrics>;
  snapshotBuffersRef: MutableRefObject<Map<string, TransformSnapshot[]>>;
};

export function HudStateProvider({
  children,
  hudHealth,
  isJoined,
  joinPreferences,
  metricsRef,
  snapshotBuffersRef,
}: HudStateProviderProps) {
  const hudMetrics = useHudMetrics({ metricsRef, snapshotBuffersRef });
  const value = useMemo<HudState>(() => ({
    hudHealth,
    hudMetrics,
    isJoined,
    joinPreferences,
  }), [
    hudHealth,
    hudMetrics,
    isJoined,
    joinPreferences,
  ]);

  return (
    <HudStateContext.Provider value={value}>
      {children}
    </HudStateContext.Provider>
  );
}
