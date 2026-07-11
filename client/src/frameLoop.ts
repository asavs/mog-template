export function frameLoopAdvanceTimeSeconds(timestampMs: number, firstFrameTimestampMs: number): number {
  return Math.max(0, (timestampMs - firstFrameTimestampMs) / 1000);
}
