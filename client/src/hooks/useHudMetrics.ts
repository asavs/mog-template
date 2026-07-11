import { useEffect, useState, type MutableRefObject } from 'react';
import {
  createMetrics,
  updateRates,
  type NetMetrics,
  type TransformSnapshot,
} from '../netcode';

type UseHudMetricsOptions = {
  metricsRef: MutableRefObject<NetMetrics>;
  snapshotBuffersRef: MutableRefObject<Map<string, TransformSnapshot[]>>;
};

export function useHudMetrics({ metricsRef, snapshotBuffersRef }: UseHudMetricsOptions) {
  const [hudMetrics, setHudMetrics] = useState<NetMetrics>(() => createMetrics());

  useEffect(() => {
    const interval = window.setInterval(() => {
      const metrics = metricsRef.current;
      const now = performance.now();
      updateRates(metrics, now);

      let newestSnapshotAt = 0;
      let totalBufferLength = 0;
      let bufferCount = 0;
      for (const buffer of snapshotBuffersRef.current.values()) {
        if (buffer.length > 0) {
          newestSnapshotAt = Math.max(newestSnapshotAt, buffer[buffer.length - 1].receivedAt);
          totalBufferLength += buffer.length;
          bufferCount += 1;
        }
      }

      metrics.latestSnapshotAgeMs = newestSnapshotAt > 0 ? now - newestSnapshotAt : 0;
      metrics.avgBufferLength = bufferCount > 0 ? totalBufferLength / bufferCount : 0;
      setHudMetrics({ ...metrics });
    }, 500);

    return () => window.clearInterval(interval);
  }, [metricsRef, snapshotBuffersRef]);

  return hudMetrics;
}
