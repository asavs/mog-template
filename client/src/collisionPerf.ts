export type CastleCollisionPerfSnapshot = {
  queryHz: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
};

let sampleStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
let queryCount = 0;
let totalMs = 0;
let maxMs = 0;
let lastMs = 0;

export function recordCastleCollisionQuery(elapsedMs: number) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
  queryCount += 1;
  totalMs += elapsedMs;
  maxMs = Math.max(maxMs, elapsedMs);
  lastMs = elapsedMs;
}

export function sampleCastleCollisionPerf(now = performance.now()): CastleCollisionPerfSnapshot {
  const elapsedSeconds = Math.max(0.001, (now - sampleStartedAt) / 1000);
  const snapshot = {
    queryHz: queryCount / elapsedSeconds,
    totalMs,
    maxMs,
    lastMs,
  };
  sampleStartedAt = now;
  queryCount = 0;
  totalMs = 0;
  maxMs = 0;
  return snapshot;
}
