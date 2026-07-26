export type CastleCollisionPerfSnapshot = {
  queryHz: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  supportQueryHz: number;
  supportTotalMs: number;
  supportMaxMs: number;
  sweepQueryHz: number;
  sweepTotalMs: number;
  sweepMaxMs: number;
};

export type CastleCollisionQueryKind = 'support' | 'sweep';

type CastleCollisionPerfBucket = {
  queryCount: number;
  totalMs: number;
  maxMs: number;
};

let sampleStartedAt = typeof performance !== 'undefined' ? performance.now() : 0;
let queryCount = 0;
let totalMs = 0;
let maxMs = 0;
let lastMs = 0;
const buckets: Record<CastleCollisionQueryKind, CastleCollisionPerfBucket> = {
  support: { queryCount: 0, totalMs: 0, maxMs: 0 },
  sweep: { queryCount: 0, totalMs: 0, maxMs: 0 },
};

export function recordCastleCollisionQuery(elapsedMs: number, kind: CastleCollisionQueryKind) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
  queryCount += 1;
  totalMs += elapsedMs;
  maxMs = Math.max(maxMs, elapsedMs);
  lastMs = elapsedMs;
  const bucket = buckets[kind];
  bucket.queryCount += 1;
  bucket.totalMs += elapsedMs;
  bucket.maxMs = Math.max(bucket.maxMs, elapsedMs);
}

export function sampleCastleCollisionPerf(now = performance.now()): CastleCollisionPerfSnapshot {
  const elapsedSeconds = Math.max(0.001, (now - sampleStartedAt) / 1000);
  const snapshot = {
    queryHz: queryCount / elapsedSeconds,
    totalMs,
    maxMs,
    lastMs,
    supportQueryHz: buckets.support.queryCount / elapsedSeconds,
    supportTotalMs: buckets.support.totalMs,
    supportMaxMs: buckets.support.maxMs,
    sweepQueryHz: buckets.sweep.queryCount / elapsedSeconds,
    sweepTotalMs: buckets.sweep.totalMs,
    sweepMaxMs: buckets.sweep.maxMs,
  };
  sampleStartedAt = now;
  queryCount = 0;
  totalMs = 0;
  maxMs = 0;
  buckets.support.queryCount = 0;
  buckets.support.totalMs = 0;
  buckets.support.maxMs = 0;
  buckets.sweep.queryCount = 0;
  buckets.sweep.totalMs = 0;
  buckets.sweep.maxMs = 0;
  return snapshot;
}
