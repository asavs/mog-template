/**
 * Compares a fresh trace summary against a checked-in baseline summary.
 *
 * Tolerances are derived from the baseline's own measured noise (mean/stddev
 * across its frames, path length actually traveled), not hand-picked
 * constants — so replacing the baseline file (`--update-baseline`) also
 * recalibrates what counts as "within noise" without touching this code.
 * Only the *sensitivity* knobs below (how many stddevs, what % of path
 * length) are fixed constants; the actual expected values never are.
 */
import type { PhaseSummary, TraceSummary } from './trace-stats';

export type ToleranceConfig = {
  /** How many standard deviations of the baseline's own spread count as noise. */
  stddevMultiplier: number;
  /** Position drift tolerance, as a fraction of the distance actually traveled in that phase. */
  positionTolerancePct: number;
  /** Minimum position tolerance in world units, for phases with little/no movement. */
  positionFloor: number;
  /** Frame-to-frame jump tolerance, as a multiple of the baseline's own max observed jump. */
  jumpMultiplier: number;
  /** Minimum jump tolerance in world units. */
  jumpFloor: number;
  /**
   * Minimum absolute headroom added to error/offset bands, for phases where
   * baseline stddev is ~0 (e.g. stationary phases like cast/attack/idle).
   * Those phases still show small residual correction-error noise between
   * runs (observed ~0.03 on otherwise-identical code) even with no movement,
   * so the floor needs to clear that, not just guard against literal zero.
   */
  errFloor: number;
};

export const DEFAULT_TOLERANCE: ToleranceConfig = {
  stddevMultiplier: Number(process.env.QA_TOLERANCE_STDDEV_MULTIPLIER ?? 3),
  positionTolerancePct: 0.25,
  positionFloor: 0.1,
  jumpMultiplier: 2,
  jumpFloor: 0.5,
  errFloor: 0.05,
};

export type ComparisonFailure = {
  phase: string;
  metric: string;
  baseline: number;
  candidate: number;
  allowed: number;
};

function checkPhase(phase: string, base: PhaseSummary, cand: PhaseSummary, t: ToleranceConfig): ComparisonFailure[] {
  const failures: ComparisonFailure[] = [];

  const posAllowed = Math.max(t.positionFloor, t.positionTolerancePct * base.pathLength);
  const posDelta = Math.abs(cand.netDisplacement - base.netDisplacement);
  if (posDelta > posAllowed) {
    failures.push({ phase, metric: 'netDisplacement', baseline: base.netDisplacement, candidate: cand.netDisplacement, allowed: posAllowed });
  }

  const corrAllowed = base.meanCorrErr + t.stddevMultiplier * base.stddevCorrErr + t.errFloor;
  if (cand.meanCorrErr > corrAllowed) {
    failures.push({ phase, metric: 'meanCorrectionError', baseline: base.meanCorrErr, candidate: cand.meanCorrErr, allowed: corrAllowed });
  }

  const offsetAllowed = base.meanOffset + t.stddevMultiplier * base.stddevOffset + t.errFloor;
  if (cand.meanOffset > offsetAllowed) {
    failures.push({ phase, metric: 'meanOffset', baseline: base.meanOffset, candidate: cand.meanOffset, allowed: offsetAllowed });
  }

  const jumpAllowed = Math.max(t.jumpFloor, t.jumpMultiplier * base.maxFrameDelta);
  if (cand.maxFrameDelta > jumpAllowed) {
    failures.push({ phase, metric: 'maxFrameDelta', baseline: base.maxFrameDelta, candidate: cand.maxFrameDelta, allowed: jumpAllowed });
  }

  return failures;
}

export function compareToBaseline(
  candidate: TraceSummary,
  baseline: TraceSummary,
  tolerance: ToleranceConfig = DEFAULT_TOLERANCE,
): ComparisonFailure[] {
  const failures: ComparisonFailure[] = [];

  for (const [phase, base] of Object.entries(baseline)) {
    const cand = candidate[phase];
    if (!cand) {
      failures.push({ phase, metric: 'presence', baseline: base.frames, candidate: 0, allowed: 1 });
      continue;
    }
    failures.push(...checkPhase(phase, base, cand, tolerance));
  }

  return failures;
}

export function formatFailures(characterClass: string, failures: ComparisonFailure[]): string {
  const lines = [`[compare-baseline] ${characterClass}: ${failures.length} phase metric(s) outside baseline tolerance:`];
  for (const f of failures) {
    lines.push(
      `  ${f.phase}.${f.metric}: candidate=${f.candidate.toFixed(4)} baseline=${f.baseline.toFixed(4)} allowed<=${f.allowed.toFixed(4)}`,
    );
  }
  return lines.join('\n');
}
