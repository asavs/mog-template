import { describe, expect, it } from 'vitest';
import {
  checkConfigChannels,
  checkInvariants,
  type PhaseWithExpectation,
} from './invariants';
import type { TraceRecord } from './trace-types';
import type { PhaseSummary, TraceSummary } from './trace-stats';

const movement = {
  walkSpeed: 6,
  sprintMultiplier: 1.8,
  sprintSpeed: 10.8,
};

function phaseSummary(overrides: Partial<PhaseSummary>): PhaseSummary {
  return {
    phase: 'phase',
    frames: 90,
    pathLength: 0,
    netDisplacement: 0,
    maxFrameDelta: 0,
    meanCorrErr: 0,
    stddevCorrErr: 0,
    meanOffset: 0,
    stddevOffset: 0,
    ...overrides,
  };
}

function traceRecord(channels: Record<string, number> | null): TraceRecord {
  return {
    t: 0,
    phase: 'walk_forward',
    simPosition: null,
    renderPosition: null,
    visualOffset: null,
    offsetLength: null,
    cameraPosition: null,
    localServerTick: null,
    localCorrectionError: null,
    channels,
  };
}

function check(summary: TraceSummary, phases: PhaseWithExpectation[]) {
  return checkInvariants(summary, phases, movement);
}

describe('checkInvariants', () => {
  it('passes a walk phase within speed tolerance', () => {
    const failures = check(
      { walk_forward: phaseSummary({ phase: 'walk_forward', pathLength: 9.1, netDisplacement: 9.0 }) },
      [{ name: 'walk_forward', expect: { kind: 'linear-move', speed: 'walk', durationMs: 1500 } }],
    );

    expect(failures).toEqual([]);
  });

  it('fails a linear move that is clearly too slow', () => {
    const failures = check(
      { walk_forward: phaseSummary({ phase: 'walk_forward', pathLength: 5, netDisplacement: 5 }) },
      [{ name: 'walk_forward', expect: { kind: 'linear-move', speed: 'walk', durationMs: 1500 } }],
    );

    expect(failures).toEqual([
      expect.objectContaining({ phase: 'walk_forward', metric: 'netDisplacement' }),
    ]);
  });

  it('fails a diagonal walk that exceeds normalized walk speed', () => {
    const failures = check(
      { walk_forward_left: phaseSummary({ phase: 'walk_forward_left', pathLength: 12.7, netDisplacement: 12.7 }) },
      [{ name: 'walk_forward_left', expect: { kind: 'linear-move', speed: 'walk', durationMs: 1500 } }],
    );

    expect(failures).toEqual([
      expect.objectContaining({ phase: 'walk_forward_left', metric: 'netDisplacement' }),
    ]);
  });

  it('fails a linear move whose path is not straight enough', () => {
    // Right distance, wiggly path: net/path = 9/13 ≈ 0.69 < 0.75.
    const failures = check(
      { walk_forward: phaseSummary({ phase: 'walk_forward', pathLength: 13, netDisplacement: 9 }) },
      [{ name: 'walk_forward', expect: { kind: 'linear-move', speed: 'walk', durationMs: 1500 } }],
    );

    expect(failures).toEqual([
      expect.objectContaining({ phase: 'walk_forward', metric: 'straightness' }),
    ]);
  });

  it('skips the straightness check when expect.straight is false (jump phases)', () => {
    // Jump arc: 3D path much longer than net displacement, distance still right.
    const failures = check(
      { jump_while_moving: phaseSummary({ phase: 'jump_while_moving', pathLength: 8, netDisplacement: 6.1 }) },
      [{ name: 'jump_while_moving', expect: { kind: 'linear-move', speed: 'walk', durationMs: 1020, straight: false } }],
    );

    expect(failures).toEqual([]);
  });

  it('passes a curved max-speed phase below the configured distance cap', () => {
    const failures = check(
      { mv_n_turn: phaseSummary({ phase: 'mv_n_turn', pathLength: 9, netDisplacement: 4 }) },
      [{ name: 'mv_n_turn', expect: { kind: 'max-speed', speed: 'walk', durationMs: 1500 } }],
    );

    expect(failures).toEqual([]);
  });

  it('fails a max-speed phase above the configured distance cap', () => {
    const failures = check(
      { mv_n_turn: phaseSummary({ phase: 'mv_n_turn', pathLength: 13, netDisplacement: 13 }) },
      [{ name: 'mv_n_turn', expect: { kind: 'max-speed', speed: 'walk', durationMs: 1500 } }],
    );

    expect(failures).toEqual([
      expect.objectContaining({ phase: 'mv_n_turn', metric: 'netDisplacement' }),
    ]);
  });

  it('passes a stationary phase with near-zero displacement', () => {
    const failures = check(
      { cast_fireball: phaseSummary({ phase: 'cast_fireball', pathLength: 0.05, netDisplacement: 0.05 }) },
      [{ name: 'cast_fireball', expect: { kind: 'stationary' } }],
    );

    expect(failures).toEqual([]);
  });

  it('fails a stationary phase that drifted', () => {
    const failures = check(
      { cast_fireball: phaseSummary({ phase: 'cast_fireball', pathLength: 0.6, netDisplacement: 0.6 }) },
      [{ name: 'cast_fireball', expect: { kind: 'stationary' } }],
    );

    expect(failures).toEqual([
      expect.objectContaining({ phase: 'cast_fireball', metric: 'netDisplacement' }),
    ]);
  });
});

describe('checkConfigChannels', () => {
  it('fails when config_walkSpeed does not match the harness expectation', () => {
    const failures = checkConfigChannels([
      traceRecord({ config_walkSpeed: 7, config_sprintMultiplier: movement.sprintMultiplier }),
    ], movement);

    expect(failures).toEqual([
      expect.objectContaining({
        phase: 'trace',
        metric: 'config_walkSpeed',
        expected: movement.walkSpeed,
        actual: 7,
      }),
    ]);
  });

  it('fails distinctly when a required config channel is missing', () => {
    const failures = checkConfigChannels([
      traceRecord({ config_sprintMultiplier: movement.sprintMultiplier }),
    ], movement);

    expect(failures).toEqual([
      expect.objectContaining({
        phase: 'trace',
        metric: 'config_walkSpeed',
        detail: expect.stringContaining('was not observed'),
      }),
    ]);
  });
});

