/**
 * Unit tests for the rubberband detector's own arithmetic.
 *
 * The live browser gate proves the detector fires on the real game; these prove it fires
 * for the RIGHT REASON, from hand-built traces where the answer is known — so a future
 * threshold tune can be checked in milliseconds instead of a 3-minute headed run, and so a
 * detector that quietly stops detecting anything cannot pass as "clean".
 *
 * The numbers each synthetic trace is built from are the ones measured live on
 * `public/v2/essential-template` and after the fix; see `input-churn.ts`'s threshold docs.
 */
import { describe, expect, it } from 'vitest';
import {
  CHURN_CADENCES_MS,
  CHURN_MAX_SPEED,
  checkChurn,
  churnPhases,
  frameJumpAllowance,
  summarizeChurnPhase,
} from './input-churn';
import type { ReconcileRecord, TraceRecord, Vec3 } from './trace-types';

const FRAME_MS = 1000 / 60;
const TICK_MS = 50;

function reconcile(overrides: Partial<ReconcileRecord> = {}): ReconcileRecord {
  return {
    predictedPosition: { x: 0, y: 0, z: 0 },
    visualOffset: { x: 0, y: 0, z: 0 },
    serverPosition: { x: 0, y: 0, z: 0 },
    serverTick: '1',
    ackClientTick: 0,
    predictTickCounter: 0,
    pendingTicks: 4,
    corrections: 0,
    lastCorrectionMagnitude: 0,
    lastCorrectionSnapped: false,
    lastCorrectionDropped: 0,
    lastCorrectionReplayed: 4,
    ...overrides,
  };
}

/**
 * A trace of `frames` frames at `FRAME_MS`, where the rendered position advances in whole
 * 50ms sim-tick quanta — the shape the real client actually produces (see the module doc's
 * note on the fixed-tick staircase), not a smooth ramp.
 */
function walkTrace(phase: string, frames: number, speed = CHURN_MAX_SPEED): TraceRecord[] {
  const records: TraceRecord[] = [];
  for (let i = 0; i < frames; i += 1) {
    const t = i * FRAME_MS;
    const ticksElapsed = Math.floor(t / TICK_MS);
    records.push({
      t,
      phase,
      simPosition: { x: 0, y: 0, z: -ticksElapsed * speed * (TICK_MS / 1000) },
      joined: true,
      remoteCount: 0,
      channels: null,
      reconcile: reconcile({ corrections: Math.floor(t / 200) }),
    });
  }
  return records;
}

function positionsOf(records: TraceRecord[]): Vec3[] {
  return records.map((r) => r.simPosition!);
}

describe('churnPhases', () => {
  it('emits a churn window and a post-release settle window per cadence', () => {
    const names = churnPhases().map((p) => p.name);
    expect(names).toEqual(
      CHURN_CADENCES_MS.flatMap((ms) => [`churn_${ms}ms`, `settle_${ms}ms`]),
    );
    // The settle window has to be its own phase, not a tail of the churn one — the whole
    // point is measuring the post-release window separately from the churn that preceded it.
    expect(churnPhases().every((p) => p.group === 'churn')).toBe(true);
  });
});

describe('frameJumpAllowance', () => {
  it('never allows less than one sim tick of travel, however short the frame', () => {
    // The predictor renders whole 50ms ticks, so a 1ms frame can legitimately show 0.3m.
    expect(frameJumpAllowance(1)).toBeGreaterThan(CHURN_MAX_SPEED * (TICK_MS / 1000));
    expect(frameJumpAllowance(0)).toBe(frameJumpAllowance(TICK_MS));
  });

  it('scales with the window once the window is longer than a tick', () => {
    expect(frameJumpAllowance(400)).toBeGreaterThan(frameJumpAllowance(200));
  });
});

describe('checkChurn', () => {
  it('fails a churn window in which the player never moved, instead of passing it', () => {
    // Every other bound is an upper bound, so a motionless run clears them all. This is the
    // shape a lost pointer lock produces, and it was passing as "clean" until this check
    // existed — see MIN_CHURN_PATH_METERS.
    const records = walkTrace('churn_150ms', 600, 0);
    const { failures } = checkChurn(records, { latencyMs: 100 });
    expect(failures.map((f) => f.check)).toContain('no-input');
  });

  it('does not demand movement of a settle window, where stillness is the point', () => {
    const records = walkTrace('settle_150ms', 200, 0);
    expect(checkChurn(records, { latencyMs: 100 }).failures.map((f) => f.check)).not.toContain('no-input');
  });

  it('passes a clean fixed-tick walk at full speed', () => {
    const { failures } = checkChurn(walkTrace('churn_150ms', 600));
    expect(failures).toEqual([]);
  });

  it('ignores phases outside the churn registry', () => {
    const { failures, stats } = checkChurn(walkTrace('walk_forward', 600));
    expect(stats).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('catches a teleport: a jump no window of that length could contain', () => {
    const records = walkTrace('churn_150ms', 600);
    // The 4.7m single-frame snap this detector found live on a stall resync.
    for (let i = 300; i < records.length; i += 1) records[i].simPosition!.x += 4.7;

    const { failures } = checkChurn(records);
    expect(failures.map((f) => f.check)).toContain('frame-jump');
    expect(failures.find((f) => f.check === 'frame-jump')!.actual).toBeGreaterThan(1);
  });

  it('exempts a teleport that is a stalled tab catching up, and still counts the stall', () => {
    const records = walkTrace('churn_150ms', 600);
    // Same 4.7m snap, but now preceded by a 1.33s frame gap — the measured stall. A client
    // that lost a second of simulation has a real error to repair and snapping is correct.
    for (let i = 300; i < records.length; i += 1) {
      records[i].t += 1334;
      records[i].simPosition!.x += 4.7;
    }

    const { failures, stats } = checkChurn(records);
    expect(failures.map((f) => f.check)).not.toContain('frame-jump');
    expect(stats[0].stalledFrames).toBe(1);
  });

  it('catches oscillation, which inflates path without inflating displacement', () => {
    const records = walkTrace('churn_150ms', 600);
    // Vibrate 0.25m side to side every frame: net displacement unchanged, path doubled.
    records.forEach((r, i) => { r.simPosition!.x += i % 2 === 0 ? 0.25 : -0.25; });

    const { failures } = checkChurn(records);
    expect(failures.map((f) => f.check)).toContain('path-inflation');
  });

  it('catches the rubberband itself: corrections that replay no predicted ticks', () => {
    const records = walkTrace('churn_150ms', 600);
    // The pre-fix signature — every correction discarded the whole in-flight buffer
    // (measured 135/135 and 163/163 at 0ms, 150/150 and 154/154 at 200ms).
    records.forEach((r, i) => {
      r.reconcile = reconcile({
        corrections: Math.floor(i / 10),
        lastCorrectionDropped: 63,
        lastCorrectionReplayed: 0,
        pendingTicks: 0,
      });
    });

    const { failures, stats } = checkChurn(records, { latencyMs: 100 });
    const lead = failures.filter((f) => f.check === 'prediction-lead');
    expect(lead).toHaveLength(1);
    expect(lead[0].actual).toBe(1);
    expect(stats[0].reconcile!.zeroReplayCorrections).toBe(stats[0].reconcile!.corrections);
  });

  it('does not read anything into a zero replay count on a sub-tick loopback socket', () => {
    // Same trace, no injected latency: the server really has processed everything the client
    // predicted, so replaying nothing is correct rather than a discarded prediction.
    const records = walkTrace('churn_150ms', 600);
    records.forEach((r, i) => {
      r.reconcile = reconcile({ corrections: Math.floor(i / 10), lastCorrectionReplayed: 0, pendingTicks: 0 });
    });
    expect(checkChurn(records, { latencyMs: 0 }).failures.filter((f) => f.check === 'prediction-lead')).toEqual([]);
  });

  it('catches the other end: a correction rebuilding seconds of prediction', () => {
    const records = walkTrace('churn_150ms', 600);
    // The steady-play signature — the ack sat below every buffered tick, so each correction
    // replayed the whole ~100-tick buffer onto the authoritative position.
    records.forEach((r, i) => {
      r.reconcile = reconcile({ corrections: Math.floor(i / 10), lastCorrectionReplayed: 100, pendingTicks: 100 });
    });

    const { failures } = checkChurn(records);
    const lead = failures.find((f) => f.check === 'prediction-lead' && f.actual === 100);
    expect(lead).toBeDefined();
  });

  it('accepts a healthy prediction lead — the RTT expressed in ticks', () => {
    const records = walkTrace('churn_150ms', 600);
    // 200ms one-way measured 8..10 ticks replayed, zero zero-replay corrections.
    records.forEach((r, i) => {
      r.reconcile = reconcile({ corrections: Math.floor(i / 10), lastCorrectionReplayed: 9, pendingTicks: 9 });
    });

    expect(checkChurn(records).failures.filter((f) => f.check === 'prediction-lead')).toEqual([]);
  });

  it('requires a settle window to be finished, not merely slow', () => {
    // Still drifting a full second after every key came up.
    const records = walkTrace('settle_150ms', 200, 1.5);
    const { failures } = checkChurn(records);
    expect(failures.map((f) => f.check)).toContain('settle');
  });

  it('passes a settle window that converges inside the grace and then parks', () => {
    const records: TraceRecord[] = [];
    for (let i = 0; i < 200; i += 1) {
      const t = i * FRAME_MS;
      // 0.3m of convergence, fully spent inside the grace window, then motionless.
      const converged = Math.min(t / 400, 1);
      records.push({
        t,
        phase: 'settle_150ms',
        simPosition: { x: 0.3 * converged, y: 0, z: 0 },
        joined: true,
        remoteCount: 0,
        channels: null,
        reconcile: reconcile({ corrections: 1 }),
      });
    }
    expect(checkChurn(records).failures).toEqual([]);
  });
});

describe('summarizeChurnPhase', () => {
  it('measures path along the rendered positions, not straight-line displacement', () => {
    const records = walkTrace('churn_150ms', 120);
    const stats = summarizeChurnPhase('churn_150ms', records);
    const positions = positionsOf(records);
    expect(stats.netDisplacement).toBeCloseTo(
      Math.hypot(
        positions[0].x - positions.at(-1)!.x,
        positions[0].y - positions.at(-1)!.y,
        positions[0].z - positions.at(-1)!.z,
      ),
      6,
    );
    expect(stats.pathLength).toBeGreaterThanOrEqual(stats.netDisplacement - 1e-9);
  });

  it('leaves reconcile stats undefined when the client published no reconciliation channel', () => {
    const records = walkTrace('churn_150ms', 120).map((r) => ({ ...r, reconcile: null }));
    expect(summarizeChurnPhase('churn_150ms', records).reconcile).toBeUndefined();
  });
});
