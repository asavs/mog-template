import type { TraceRecord } from './trace-types';
import type { TraceSummary } from './trace-stats';
import {
  DEFAULT_INVARIANT_EXPECTATIONS,
  type InvariantExpectations,
} from './expectations';

export type PhaseExpectation =
  | {
      kind: 'linear-move';
      speed: 'walk' | 'sprint';
      durationMs: number;
      /**
       * Set false to skip the path-straightness check. Jump phases need this:
       * the vertical parabola inflates 3D pathLength while net vertical
       * displacement is ~0, so even a perfectly straight horizontal move
       * reads ~0.80 straightness (observed in the checked-in baselines).
       */
      straight?: boolean;
    }
  | { kind: 'max-speed'; speed: 'walk' | 'sprint'; durationMs: number }
  | { kind: 'stationary' };

export type InvariantFailure = {
  phase: string;
  metric: string;
  detail: string;
  expected: number;
  actual: number;
  allowed: number;
};

export type PhaseWithExpectation = {
  name: string;
  expect?: PhaseExpectation;
};

const LINEAR_MOVE_TOLERANCE_FLOOR = 0.3;
const LINEAR_MOVE_TOLERANCE_PCT = 0.2;
// Straightness = netDisplacement / pathLength. pathLength integrates per-frame
// prediction/correction jitter, so even a clean straight-line hold lands well
// below 1.0 (worst observed in checked-in baselines: 0.8143 for a plain
// walk_forward). 0.75 keeps headroom over real traces while still catching
// rubber-banding, which scores far lower.
const MIN_LINEAR_STRAIGHTNESS = 0.75;
// jump_idle is annotated stationary but real traces drift a little on landing
// (observed 0.309 in the checked-in wizard baseline); 0.5 clears that noise
// while still catching genuine sliding.
const STATIONARY_DISPLACEMENT_FLOOR = 0.5;

function expectedSpeed(speed: 'walk' | 'sprint', expectations: InvariantExpectations): number {
  return speed === 'sprint' ? expectations.sprintSpeed : expectations.walkSpeed;
}

function firstChannelValue(trace: TraceRecord[], key: string): number | undefined {
  for (const record of trace) {
    const value = record.channels?.[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

export function checkConfigChannels(
  trace: TraceRecord[],
  expectations: InvariantExpectations = DEFAULT_INVARIANT_EXPECTATIONS,
): InvariantFailure[] {
  const checks: Array<[key: string, expected: number]> = [
    ['config_walkSpeed', expectations.walkSpeed],
    ['config_sprintMultiplier', expectations.sprintMultiplier],
  ];
  const failures: InvariantFailure[] = [];

  for (const [key, expected] of checks) {
    const actual = firstChannelValue(trace, key);
    if (actual === undefined) {
      failures.push({
        phase: 'trace',
        metric: key,
        detail: key + ' channel was not observed in window.__gameDebug',
        expected,
        actual: Number.NaN,
        allowed: 0,
      });
      continue;
    }

    if (actual !== expected) {
      failures.push({
        phase: 'trace',
        metric: key,
        detail: key + ' from the client build does not match the harness expectation',
        expected,
        actual,
        allowed: 0,
      });
    }
  }

  return failures;
}

export function checkInvariants(
  summary: TraceSummary,
  phases: ReadonlyArray<PhaseWithExpectation>,
  expectations: InvariantExpectations = DEFAULT_INVARIANT_EXPECTATIONS,
): InvariantFailure[] {
  const failures: InvariantFailure[] = [];

  for (const phase of phases) {
    if (!phase.expect) continue;

    const phaseSummary = summary[phase.name];
    if (!phaseSummary) {
      failures.push({
        phase: phase.name,
        metric: 'presence',
        detail: 'phase was selected but no trace summary was recorded',
        expected: 1,
        actual: 0,
        allowed: 0,
      });
      continue;
    }

    if (phase.expect.kind === 'stationary') {
      if (phaseSummary.netDisplacement > STATIONARY_DISPLACEMENT_FLOOR) {
        failures.push({
          phase: phase.name,
          metric: 'netDisplacement',
          detail: 'stationary phase drifted beyond the allowed floor',
          expected: 0,
          actual: phaseSummary.netDisplacement,
          allowed: STATIONARY_DISPLACEMENT_FLOOR,
        });
      }
      continue;
    }

    const expectedDistance = expectedSpeed(phase.expect.speed, expectations) * (phase.expect.durationMs / 1000);
    const allowed = Math.max(LINEAR_MOVE_TOLERANCE_FLOOR, LINEAR_MOVE_TOLERANCE_PCT * expectedDistance);
    const delta =
      phase.expect.kind === 'max-speed'
        ? phaseSummary.netDisplacement - expectedDistance
        : Math.abs(phaseSummary.netDisplacement - expectedDistance);
    if (delta > allowed) {
      failures.push({
        phase: phase.name,
        metric: 'netDisplacement',
        detail:
          phase.expect.kind === 'max-speed'
            ? phase.expect.speed + ' phase exceeded the config-derived distance ceiling'
            : phase.expect.speed + ' phase moved outside config-derived distance tolerance',
        expected: expectedDistance,
        actual: phaseSummary.netDisplacement,
        allowed,
      });
    }

    if (
      phase.expect.kind === 'linear-move' &&
      phase.expect.straight !== false &&
      phaseSummary.pathLength > 0
    ) {
      const straightness = phaseSummary.netDisplacement / phaseSummary.pathLength;
      if (straightness < MIN_LINEAR_STRAIGHTNESS) {
        failures.push({
          phase: phase.name,
          metric: 'straightness',
          detail: 'single-direction movement path was not straight enough',
          expected: MIN_LINEAR_STRAIGHTNESS,
          actual: straightness,
          allowed: MIN_LINEAR_STRAIGHTNESS,
        });
      }
    }
  }

  return failures;
}

export function formatInvariantFailures(characterClass: string, failures: InvariantFailure[]): string {
  const lines = ['[invariants] ' + characterClass + ': ' + failures.length + ' invariant check(s) failed:'];
  for (const f of failures) {
    lines.push(
      '  ' + f.phase + '.' + f.metric + ': actual=' + f.actual.toFixed(4) + ' expected=' + f.expected.toFixed(4) + ' allowed=' + f.allowed.toFixed(4) + ' (' + f.detail + ')'
    );
  }
  return lines.join('\n');
}

