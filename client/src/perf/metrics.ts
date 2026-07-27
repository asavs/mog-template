/**
 * Client-side prediction deliberately makes local movement feel immediate, which
 * also means the renderer is the wrong place to measure reconciliation quality.
 * By render time, the authoritative snap has already been replayed and hidden
 * behind a decaying visual offset. This module records the pre-smoothing
 * correction magnitude at the reconciliation source, alongside frame cadence,
 * acknowledgement RTT, and authoritative-row arrival cadence.
 *
 * These hooks run for every rendered frame and network arrival, so their recording
 * path is allocation-free: every stream is a fixed Float64Array-backed TimedRing,
 * and input send times use a fixed power-of-two slot table instead of a Map.
 * Derivation may sort, but it writes through one preallocated scratch array and
 * mutates one persistent snapshot object. The intentionally flat numeric snapshot
 * can therefore be retained by HUD and trace consumers without creating garbage
 * or observing NaN values.
 */

import { TimedRing, burstiness } from './ring';

const DEFAULT_WINDOW_SECONDS = 5;
const DEFAULT_CAPACITY = 512;
const SENT_SLOT_COUNT = 1024;
const SENT_SLOT_MASK = SENT_SLOT_COUNT - 1;

/** One flat, all-numeric view of current netcode feel. */
export interface NetcodeSnapshot {
  fps: number;
  frameMsP50: number;
  frameMsP95: number;

  /** Reconciles per second over the window. */
  correctionsPerSecond: number;
  correctionMagnitudeLast: number;
  correctionMagnitudeP50: number;
  correctionMagnitudeP95: number;
  correctionMagnitudeMax: number;
  /** Current length of the renderer's decaying smoothing offset — the part of a correction still being hidden. */
  visualCorrectionOffsetLength: number;

  ackRttMsLast: number;
  ackRttMsP50: number;
  ackRttMsP95: number;

  /** Interval between authoritative transform-row arrivals. Should sit near the server tick period. */
  tickIntervalMsLast: number;
  tickIntervalMsP50: number;
  tickIntervalMsP95: number;
  /** p95/p50 of those intervals — 1 is metronomic, >2 means the stream arrives in bursts. */
  tickBurstiness: number;
  tickArrivalsPerSecond: number;

  sampleWindowSeconds: number;
  reconcileCount: number;
  transformArrivalCount: number;
  ackSampleCount: number;
}

export interface NetcodeMetricsOptions {
  /** Rolling window for every percentile/rate. Default 5. */
  windowSeconds?: number;
  /** Ring capacity per channel. Default 512 (>5s of 60fps frames is 300; 512 leaves headroom). */
  capacity?: number;
  /** Injectable clock for tests. Default () => performance.now(). */
  now?: () => number;
}

export class NetcodeMetrics {
  readonly snapshot: NetcodeSnapshot = {
    fps: 0,
    frameMsP50: 0,
    frameMsP95: 0,
    correctionsPerSecond: 0,
    correctionMagnitudeLast: 0,
    correctionMagnitudeP50: 0,
    correctionMagnitudeP95: 0,
    correctionMagnitudeMax: 0,
    visualCorrectionOffsetLength: 0,
    ackRttMsLast: 0,
    ackRttMsP50: 0,
    ackRttMsP95: 0,
    tickIntervalMsLast: 0,
    tickIntervalMsP50: 0,
    tickIntervalMsP95: 0,
    tickBurstiness: 0,
    tickArrivalsPerSecond: 0,
    sampleWindowSeconds: 0,
    reconcileCount: 0,
    transformArrivalCount: 0,
    ackSampleCount: 0,
  };

  readonly series: {
    readonly frameMs: TimedRing;
    readonly correctionMagnitude: TimedRing;
    readonly ackRttMs: TimedRing;
    readonly tickIntervalMs: TimedRing;
  };

  readonly windowSeconds: number;

  private readonly nowClock: () => number;
  private readonly scratch: Float64Array;
  private readonly transformArrivals: TimedRing;
  private readonly sentSeq = new Float64Array(SENT_SLOT_COUNT);
  private readonly sentAt = new Float64Array(SENT_SLOT_COUNT);
  private lastAckedSeq = -1;
  private lastTransformArrivalAt = -1;
  private visualCorrectionOffsetLength = 0;

  constructor(options?: NetcodeMetricsOptions) {
    this.windowSeconds = options?.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
    if (!Number.isFinite(this.windowSeconds) || this.windowSeconds <= 0) {
      throw new RangeError('Netcode metrics window must be positive');
    }

    const capacity = options?.capacity ?? DEFAULT_CAPACITY;
    this.series = {
      frameMs: new TimedRing(capacity),
      correctionMagnitude: new TimedRing(capacity),
      ackRttMs: new TimedRing(capacity),
      tickIntervalMs: new TimedRing(capacity),
    };
    this.transformArrivals = new TimedRing(capacity);
    this.scratch = new Float64Array(capacity);
    this.nowClock = options?.now ?? defaultNow;
    this.sentSeq.fill(-1);
  }

  /** `dtSeconds` is the r3f frame delta. */
  recordFrame(dtSeconds: number, now?: number): void {
    const sampleTime = now ?? this.nowClock();
    this.series.frameMs.push(sampleTime, dtSeconds * 1000);
  }

  /** Called the instant an input with this sequence number goes on the wire. */
  recordInputSent(sequence: number, now?: number): void {
    const sampleTime = now ?? this.nowClock();
    const slot = sequence & SENT_SLOT_MASK;
    this.sentSeq[slot] = sequence;
    this.sentAt[slot] = sampleTime;
  }

  /** Called with `player_input_ack.lastInputSeq`. Repeats of an already-seen seq are ignored. */
  recordAck(lastInputSeq: number, now?: number): void {
    if (lastInputSeq <= 0 || lastInputSeq === this.lastAckedSeq) {
      return;
    }

    this.lastAckedSeq = lastInputSeq;
    const slot = lastInputSeq & SENT_SLOT_MASK;

    // A wrapped slot means more than 1024 inputs escaped acknowledgement. Dropping
    // that one RTT is safer than turning an unrelated send time into plausible data.
    if (this.sentSeq[slot] !== lastInputSeq) {
      return;
    }

    const sampleTime = now ?? this.nowClock();
    this.series.ackRttMs.push(sampleTime, sampleTime - this.sentAt[slot]);
    this.sentSeq[slot] = -1;
  }

  /** One reconcile happened; `correctionMagnitude` is the pre-smoothing distance in world units. */
  recordReconcile(correctionMagnitude: number, now?: number): void {
    const sampleTime = now ?? this.nowClock();
    this.series.correctionMagnitude.push(sampleTime, correctionMagnitude);
  }

  /** An authoritative transform row arrived (used for arrival-interval + burstiness). */
  recordTransformArrival(now?: number): void {
    const sampleTime = now ?? this.nowClock();
    if (this.lastTransformArrivalAt >= 0) {
      this.series.tickIntervalMs.push(
        sampleTime,
        sampleTime - this.lastTransformArrivalAt,
      );
    }

    this.lastTransformArrivalAt = sampleTime;
    this.transformArrivals.push(sampleTime, 1);
  }

  /** Current length of the renderer's smoothing offset. Pure state, not a ring. */
  setVisualCorrectionOffsetLength(length: number): void {
    this.visualCorrectionOffsetLength = length;
  }

  /** Recomputes every derived number into the persistent snapshot and returns it (same object). */
  refreshSnapshot(now?: number): NetcodeSnapshot {
    const sampleTime = now ?? this.nowClock();
    const tMin = sampleTime - this.windowSeconds * 1000;
    const frameP50 = this.series.frameMs.percentileSince(tMin, 0.5, this.scratch);
    const frameP95 = this.series.frameMs.percentileSince(tMin, 0.95, this.scratch);
    const correctionP50 = this.series.correctionMagnitude.percentileSince(
      tMin,
      0.5,
      this.scratch,
    );
    const correctionP95 = this.series.correctionMagnitude.percentileSince(
      tMin,
      0.95,
      this.scratch,
    );
    const ackP50 = this.series.ackRttMs.percentileSince(tMin, 0.5, this.scratch);
    const ackP95 = this.series.ackRttMs.percentileSince(tMin, 0.95, this.scratch);
    const tickP50 = this.series.tickIntervalMs.percentileSince(
      tMin,
      0.5,
      this.scratch,
    );
    const tickP95 = this.series.tickIntervalMs.percentileSince(
      tMin,
      0.95,
      this.scratch,
    );

    this.snapshot.fps = this.finiteOrZero(
      frameP50 > 0 ? 1000 / frameP50 : 0,
    );
    this.snapshot.frameMsP50 = this.finiteOrZero(frameP50);
    this.snapshot.frameMsP95 = this.finiteOrZero(frameP95);
    this.snapshot.correctionsPerSecond = this.finiteOrZero(
      this.series.correctionMagnitude.ratePerSecond(tMin, sampleTime),
    );
    this.snapshot.correctionMagnitudeLast = this.finiteOrZero(
      this.series.correctionMagnitude.latestSince(tMin),
    );
    this.snapshot.correctionMagnitudeP50 = this.finiteOrZero(correctionP50);
    this.snapshot.correctionMagnitudeP95 = this.finiteOrZero(correctionP95);
    this.snapshot.correctionMagnitudeMax = this.finiteOrZero(
      this.series.correctionMagnitude.maxSince(tMin),
    );
    this.snapshot.visualCorrectionOffsetLength = this.finiteOrZero(
      this.visualCorrectionOffsetLength,
    );
    this.snapshot.ackRttMsLast = this.finiteOrZero(
      this.series.ackRttMs.latestSince(tMin),
    );
    this.snapshot.ackRttMsP50 = this.finiteOrZero(ackP50);
    this.snapshot.ackRttMsP95 = this.finiteOrZero(ackP95);
    this.snapshot.tickIntervalMsLast = this.finiteOrZero(
      this.series.tickIntervalMs.latestSince(tMin),
    );
    this.snapshot.tickIntervalMsP50 = this.finiteOrZero(tickP50);
    this.snapshot.tickIntervalMsP95 = this.finiteOrZero(tickP95);
    this.snapshot.tickBurstiness = this.finiteOrZero(
      burstiness(tickP50, tickP95),
    );
    this.snapshot.tickArrivalsPerSecond = this.finiteOrZero(
      this.transformArrivals.ratePerSecond(tMin, sampleTime),
    );
    this.snapshot.sampleWindowSeconds = this.finiteOrZero(this.windowSeconds);
    this.snapshot.reconcileCount =
      this.series.correctionMagnitude.countSince(tMin);
    this.snapshot.transformArrivalCount =
      this.transformArrivals.countSince(tMin);
    this.snapshot.ackSampleCount = this.series.ackRttMs.countSince(tMin);

    return this.snapshot;
  }

  reset(): void {
    this.series.frameMs.clear();
    this.series.correctionMagnitude.clear();
    this.series.ackRttMs.clear();
    this.series.tickIntervalMs.clear();
    this.transformArrivals.clear();
    this.sentSeq.fill(-1);
    this.lastAckedSeq = -1;
    this.lastTransformArrivalAt = -1;
    this.visualCorrectionOffsetLength = 0;

    this.snapshot.fps = 0;
    this.snapshot.frameMsP50 = 0;
    this.snapshot.frameMsP95 = 0;
    this.snapshot.correctionsPerSecond = 0;
    this.snapshot.correctionMagnitudeLast = 0;
    this.snapshot.correctionMagnitudeP50 = 0;
    this.snapshot.correctionMagnitudeP95 = 0;
    this.snapshot.correctionMagnitudeMax = 0;
    this.snapshot.visualCorrectionOffsetLength = 0;
    this.snapshot.ackRttMsLast = 0;
    this.snapshot.ackRttMsP50 = 0;
    this.snapshot.ackRttMsP95 = 0;
    this.snapshot.tickIntervalMsLast = 0;
    this.snapshot.tickIntervalMsP50 = 0;
    this.snapshot.tickIntervalMsP95 = 0;
    this.snapshot.tickBurstiness = 0;
    this.snapshot.tickArrivalsPerSecond = 0;
    this.snapshot.sampleWindowSeconds = 0;
    this.snapshot.reconcileCount = 0;
    this.snapshot.transformArrivalCount = 0;
    this.snapshot.ackSampleCount = 0;
  }

  private finiteOrZero(value: number): number {
    return Number.isFinite(value) ? value : 0;
  }
}

function defaultNow(): number {
  return performance.now();
}

/** The instance the running game records into. Tests construct their own. */
export const sharedNetcodeMetrics = new NetcodeMetrics();
