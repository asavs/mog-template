import type { RunData, TraceRecord } from './trace-types';

export function hasVideo(run: RunData): boolean {
  return !!run.meta.video?.file && !!run.meta.time;
}

export function videoOffsetSeconds(run: RunData, traceTimestampMs: number): number | null {
  const time = run.meta.time;
  const video = run.meta.video;
  if (!time || !video) return null;

  const traceWallTimeMs =
    time.collectorWallTimeMs + (traceTimestampMs - time.collectorPerformanceNowMs);
  return (traceWallTimeMs - video.startedWallTimeMs) / 1000;
}

export function formatVideoOffset(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const abs = Math.abs(seconds);
  const minutes = Math.floor(abs / 60);
  const remainder = abs - minutes * 60;
  return `${sign}${minutes}:${remainder.toFixed(1).padStart(4, '0')}`;
}

export function formatVideoAt(run: RunData, traceTimestampMs: number): string {
  const offset = videoOffsetSeconds(run, traceTimestampMs);
  return offset === null ? '' : `video ${formatVideoOffset(offset)}`;
}

export function firstFrameInPhase(run: RunData, phase: string): TraceRecord | undefined {
  return run.frames.find((f) => f.phase === phase);
}