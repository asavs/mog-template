import { describe, expect, it } from 'vitest';
import { summarizeWsByPhase } from './perf-stats';
import type { PerfData, RunData, TraceRecord, WsMessageRecord } from './trace-types';

const frame = (t: number, phase: string): TraceRecord => ({
  t,
  phase,
  simPosition: null,
  renderPosition: null,
  visualOffset: null,
  offsetLength: null,
  cameraPosition: null,
  localServerTick: null,
  localCorrectionError: null,
  channels: null,
});

const ws = (t: number, phase: string, dir: 'in' | 'out', bytes: number): WsMessageRecord => ({
  t,
  phase,
  dir,
  bytes,
});

const makeRun = (frames: TraceRecord[], wsMessages: WsMessageRecord[]): RunData => {
  const perf: PerfData = {
    perfStartedAt: 0,
    longTasks: [],
    memorySamples: [],
    wsMessages,
    resources: [],
  };
  return {
    meta: { version: 2, characterClass: 'wizard', label: 'test', startedAt: '', clientUrl: '' },
    frames,
    events: [],
    perf,
  };
};

const byPhase = (rows: ReturnType<typeof summarizeWsByPhase>, phase: string) =>
  rows.find((r) => r.phase === phase)!;

describe('summarizeWsByPhase', () => {
  it('reports the idle→walk inbound rate delta an AFK observer sees (transform churn)', () => {
    // idle phase: 2s span (frames 1000→3000), 2 inbound frames → 1 Hz.
    // walk phase: 2s span (frames 3000→5000), 20 inbound frames → 10 Hz.
    const frames = [
      frame(1000, 'idle'),
      frame(3000, 'idle'),
      frame(3000, 'walk'),
      frame(5000, 'walk'),
    ];
    const idleWs = [ws(1500, 'idle', 'in', 40), ws(2500, 'idle', 'in', 40)];
    const walkWs = Array.from({ length: 20 }, (_, i) => ws(3050 + i * 90, 'walk', 'in', 60));
    const rows = summarizeWsByPhase(makeRun(frames, [...idleWs, ...walkWs]));

    expect(byPhase(rows, 'idle').inHz).toBeCloseTo(1, 5);
    expect(byPhase(rows, 'walk').inHz).toBeCloseTo(10, 5);
    // The #21 assertion is the delta: near-silent when the mover is idle.
    expect(byPhase(rows, 'walk').inHz).toBeGreaterThan(byPhase(rows, 'idle').inHz * 5);
  });

  it('reports outbound rate and bytes/sec (mover input send policy)', () => {
    const frames = [frame(0, 'idle'), frame(2000, 'idle'), frame(2000, 'walk'), frame(4000, 'walk')];
    const msgs = [
      ws(500, 'idle', 'out', 10), // 1 send in 2s → 0.5 Hz
      ...Array.from({ length: 40 }, (_, i) => ws(2010 + i * 49, 'walk', 'out', 25)), // 40 in 2s → 20 Hz
    ];
    const rows = summarizeWsByPhase(makeRun(frames, msgs));

    expect(byPhase(rows, 'idle').outHz).toBeCloseTo(0.5, 5);
    expect(byPhase(rows, 'walk').outHz).toBeCloseTo(20, 5);
    expect(byPhase(rows, 'walk').outBytesPerSec).toBeCloseTo((40 * 25) / 2, 5);
  });

  it('falls back to ws timestamps when a phase has too few frames to span', () => {
    // Only one frame in the phase → no frame span; use the ws t-range (1000ms).
    const frames = [frame(100, 'blip')];
    const msgs = [ws(100, 'blip', 'in', 5), ws(600, 'blip', 'in', 5), ws(1100, 'blip', 'in', 5)];
    const rows = summarizeWsByPhase(makeRun(frames, msgs));
    expect(byPhase(rows, 'blip').durationMs).toBeCloseTo(1000, 5);
    expect(byPhase(rows, 'blip').inHz).toBeCloseTo(3, 5);
  });

  it('includes ws-only phases that never produced a frame', () => {
    const rows = summarizeWsByPhase(
      makeRun([frame(0, 'idle')], [ws(0, 'ghost', 'in', 1), ws(1000, 'ghost', 'in', 1)]),
    );
    expect(byPhase(rows, 'ghost').inCount).toBe(2);
    expect(byPhase(rows, 'ghost').inHz).toBeCloseTo(2, 5);
  });

  it('yields zero rates (not NaN) when a phase has messages but no measurable span', () => {
    const rows = summarizeWsByPhase(makeRun([], [ws(500, 'single', 'in', 9)]));
    const row = byPhase(rows, 'single');
    expect(row.durationMs).toBe(0);
    expect(row.inHz).toBe(0);
    expect(Number.isNaN(row.inHz)).toBe(false);
  });
});
