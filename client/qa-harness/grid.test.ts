import { describe, expect, it } from 'vitest';
import {
  aggregateGridSummaries,
  gridJitterMs,
  gridRunLabel,
  parseBurstSpec,
  parseGridLatencies,
  summarizeGridRun,
} from './grid';
import { effectiveProfileAt } from './net-proxy';
import type { RunData, TraceRecord } from './trace-types';

function frame(t: number, phase: string, x: number, corr: number, offset: number): TraceRecord {
  return {
    t,
    phase,
    simPosition: { x, y: 0, z: 0 },
    renderPosition: { x, y: 0, z: 0 },
    visualOffset: { x: offset, y: 0, z: 0 },
    offsetLength: offset,
    cameraPosition: { x: 0, y: 0, z: 0 },
    localServerTick: String(t),
    localCorrectionError: corr,
    channels: null,
  };
}

function run(characterClass: 'wizard' | 'paladin', frames: TraceRecord[]): RunData {
  return {
    meta: {
      version: 2,
      characterClass,
      label: 'grid-l60',
      startedAt: '2026-01-01T00:00:00.000Z',
      clientUrl: 'http://localhost:5173/?qa',
    },
    frames,
    events: [],
  };
}

describe('grid helpers', () => {
  it('parses default and custom latency cells', () => {
    // '' (not undefined) exercises the default-cells path deterministically:
    // an explicit undefined would fall back to reading QA_GRID_LATENCIES from
    // the test runner's own environment.
    expect(parseGridLatencies('')).toEqual([0, 60, 150, 300]);
    expect(parseGridLatencies('0,30, 120')).toEqual([0, 30, 120]);
  });

  it('rejects invalid latency specs', () => {
    expect(() => parseGridLatencies('0,-1')).toThrow(/QA_GRID_LATENCIES/);
    expect(() => parseGridLatencies('10.5')).toThrow(/QA_GRID_LATENCIES/);
    expect(() => parseGridLatencies('abc')).toThrow(/QA_GRID_LATENCIES/);
  });

  it('formats labels and proportional jitter', () => {
    expect(gridRunLabel(150)).toBe('grid-l150');
    expect(gridRunLabel(60, { delayMs: 300, durationMs: 500, periodMs: 3000 })).toBe('grid-l60-b300x500@3000');
    expect(gridJitterMs(0)).toBe(0);
    expect(gridJitterMs(150)).toBe(15);
  });

  it('parses burst specs', () => {
    // '' (not undefined) exercises the no-burst default deterministically,
    // independent of the runner's own QA_GRID_BURST.
    expect(parseBurstSpec('')).toBeUndefined();
    expect(parseBurstSpec('300x500@3000')).toEqual({ periodMs: 3000, durationMs: 500, delayMs: 300 });
    expect(() => parseBurstSpec('300x500')).toThrow(/QA_GRID_BURST/);
    expect(() => parseBurstSpec('abc')).toThrow(/QA_GRID_BURST/);
    expect(() => parseBurstSpec('300x5000@3000')).toThrow(/cannot exceed/);
    expect(() => parseBurstSpec('300x0@0')).toThrow(/positive/);
  });

  it('resolves the effective profile inside and outside burst windows', () => {
    const profile = {
      delayMs: 60,
      jitterMs: 6,
      burst: { periodMs: 3000, durationMs: 500, delayMs: 300 },
    };
    // In the burst window: burst delay, base jitter (no burst jitter given).
    expect(effectiveProfileAt(profile, 0).delayMs).toBe(300);
    expect(effectiveProfileAt(profile, 499).delayMs).toBe(300);
    expect(effectiveProfileAt(profile, 499).jitterMs).toBe(6);
    // Outside: base profile.
    expect(effectiveProfileAt(profile, 500).delayMs).toBe(60);
    expect(effectiveProfileAt(profile, 2999).delayMs).toBe(60);
    // Next period's window.
    expect(effectiveProfileAt(profile, 3000).delayMs).toBe(300);
    expect(effectiveProfileAt(profile, 3400).delayMs).toBe(300);
    expect(effectiveProfileAt(profile, 3500).delayMs).toBe(60);
    // No burst configured: identity.
    const flat = { delayMs: 60, jitterMs: 6 };
    expect(effectiveProfileAt(flat, 123)).toBe(flat);
  });

  it('aggregates the real summarizeByPhase metric fields across cells', () => {
    const low = summarizeGridRun(0, run('wizard', [
      frame(0, 'walk_forward', 0, 0.1, 0.2),
      frame(16, 'walk_forward', 1, 0.3, 0.4),
    ]));
    const high = summarizeGridRun(150, run('wizard', [
      frame(0, 'walk_forward', 0, 0.2, 0.3),
      frame(16, 'walk_forward', 2, 0.4, 0.5),
    ]));

    expect(aggregateGridSummaries([high, low])).toEqual([
      {
        latencyMs: 0,
        characterClass: 'wizard',
        phase: 'walk_forward',
        netDisplacement: 1,
        maxFrameDelta: 1,
        meanCorrErr: 0.2,
        meanOffset: 0.30000000000000004,
      },
      {
        latencyMs: 150,
        characterClass: 'wizard',
        phase: 'walk_forward',
        netDisplacement: 2,
        maxFrameDelta: 2,
        meanCorrErr: 0.30000000000000004,
        meanOffset: 0.4,
      },
    ]);
  });
});