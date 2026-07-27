import { describe, expect, it } from 'vitest';
import { NetcodeMetrics, type NetcodeSnapshot } from './metrics';

/**
 * Every recorder takes an explicit `now`, so these tests drive the clock directly rather than
 * faking timers — the same reason the class accepts an injectable clock at all.
 */
function metrics(windowSeconds = 5): NetcodeMetrics {
  return new NetcodeMetrics({ windowSeconds, capacity: 64 });
}

/** The exact channel set `window.__mogGame.netcode` publishes and the harness copies. */
const SNAPSHOT_KEYS: readonly string[] = [
  'ackRttMsLast',
  'ackRttMsP50',
  'ackRttMsP95',
  'ackSampleCount',
  'correctionMagnitudeLast',
  'correctionMagnitudeMax',
  'correctionMagnitudeP50',
  'correctionMagnitudeP95',
  'correctionsPerSecond',
  'fps',
  'frameMsP50',
  'frameMsP95',
  'reconcileCount',
  'sampleWindowSeconds',
  'tickArrivalsPerSecond',
  'tickBurstiness',
  'tickIntervalMsLast',
  'tickIntervalMsP50',
  'tickIntervalMsP95',
  'transformArrivalCount',
  'visualCorrectionOffsetLength',
];

describe('NetcodeMetrics snapshot shape', () => {
  it('publishes a flat, all-numeric, all-finite channel set', () => {
    // This is the contract the QA harness copies generically into trace channels: anything
    // non-numeric or NaN here would land in a report as a broken series.
    const m = metrics();
    const snapshot = m.refreshSnapshot(0);

    expect(Object.keys(snapshot).sort()).toEqual([...SNAPSHOT_KEYS].sort());
    for (const [key, value] of Object.entries(snapshot)) {
      expect(typeof value, key).toBe('number');
      expect(Number.isFinite(value), key).toBe(true);
    }
  });

  it('mutates one persistent object rather than returning a fresh one', () => {
    // Consumers (the HUD, the __mogGame publisher) hold this reference across frames.
    const m = metrics();
    const first = m.refreshSnapshot(0);
    const second = m.refreshSnapshot(100);
    expect(second).toBe(first);
    expect(m.snapshot).toBe(first);
  });

  it('stays finite when every channel is empty', () => {
    const snapshot: NetcodeSnapshot = metrics().refreshSnapshot(12_345);
    expect(snapshot.fps).toBe(0);
    expect(snapshot.tickBurstiness).toBe(0);
    expect(snapshot.ackRttMsP95).toBe(0);
    expect(snapshot.sampleWindowSeconds).toBe(5);
  });
});

describe('ack round-trip time', () => {
  it('joins an ack back to the send instant of the same sequence', () => {
    const m = metrics();
    m.recordInputSent(1, 100);
    m.recordAck(1, 180);

    const snapshot = m.refreshSnapshot(200);
    expect(snapshot.ackRttMsLast).toBe(80);
    expect(snapshot.ackSampleCount).toBe(1);
  });

  it('ignores a republished ack for a sequence already measured', () => {
    // player_input_ack re-publishes on its own cadence; counting each republish would both
    // inflate the sample count and report a growing, fictional RTT.
    const m = metrics();
    m.recordInputSent(1, 100);
    m.recordAck(1, 180);
    m.recordAck(1, 500);
    m.recordAck(1, 900);

    const snapshot = m.refreshSnapshot(1000);
    expect(snapshot.ackSampleCount).toBe(1);
    expect(snapshot.ackRttMsLast).toBe(80);
  });

  it('drops rather than fabricates an RTT for a sequence it never saw sent', () => {
    const m = metrics();
    m.recordAck(7, 180);
    expect(m.refreshSnapshot(200).ackSampleCount).toBe(0);
  });

  it('drops a measurement whose send slot was overwritten by wraparound', () => {
    // Slots are indexed by `sequence & 1023`. Sequence 1025 collides with sequence 1; reporting
    // sequence 1's send time as if it were 1025's would look plausible and be pure fiction.
    const m = metrics();
    m.recordInputSent(1, 100);
    m.recordAck(1025, 180);
    expect(m.refreshSnapshot(200).ackSampleCount).toBe(0);

    // The uncollided case still measures normally. (A later sequence, because acks are
    // monotonic — re-acking 1025 would be dropped as a repeat, not re-measured.)
    m.recordInputSent(1026, 300);
    m.recordAck(1026, 340);
    expect(m.refreshSnapshot(400).ackRttMsLast).toBe(40);
  });

  it('ignores a non-positive sequence', () => {
    const m = metrics();
    m.recordInputSent(0, 100);
    m.recordAck(0, 180);
    expect(m.refreshSnapshot(200).ackSampleCount).toBe(0);
  });

  it('reports p50/p95 across the window', () => {
    const m = metrics();
    for (let index = 0; index < 4; index += 1) {
      const sequence = index + 1;
      m.recordInputSent(sequence, 1000 + index);
      m.recordAck(sequence, 1000 + index + (index + 1) * 10); // 10, 20, 30, 40 ms
    }

    const snapshot = m.refreshSnapshot(1100);
    expect(snapshot.ackRttMsP50).toBeCloseTo(25, 6);
    expect(snapshot.ackRttMsP95).toBeCloseTo(38.5, 6);
  });
});

describe('authoritative arrival cadence', () => {
  it('measures the interval between arrivals, establishing a baseline on the first', () => {
    const m = metrics();
    m.recordTransformArrival(1000);
    // Nothing to measure from yet — one arrival is not an interval.
    expect(m.refreshSnapshot(1000).tickIntervalMsLast).toBe(0);

    m.recordTransformArrival(1050);
    m.recordTransformArrival(1100);
    const snapshot = m.refreshSnapshot(1100);
    expect(snapshot.tickIntervalMsLast).toBe(50);
    expect(snapshot.transformArrivalCount).toBe(3);
  });

  it('scores an even 20Hz stream as non-bursty and a stalled-then-flooded stream as bursty', () => {
    const even = metrics();
    for (let index = 0; index <= 20; index += 1) even.recordTransformArrival(1000 + index * 50);
    const evenSnapshot = even.refreshSnapshot(2000);
    expect(evenSnapshot.tickIntervalMsP50).toBeCloseTo(50, 6);
    expect(evenSnapshot.tickBurstiness).toBeCloseTo(1, 6);
    expect(evenSnapshot.tickArrivalsPerSecond).toBeGreaterThan(15);

    const bursty = metrics();
    let t = 1000;
    bursty.recordTransformArrival(t);
    // A 400ms stall, then nine rows delivered back-to-back — the classic bad-netcode shape.
    t += 400;
    bursty.recordTransformArrival(t);
    for (let index = 0; index < 9; index += 1) {
      t += 2;
      bursty.recordTransformArrival(t);
    }
    const burstySnapshot = bursty.refreshSnapshot(t);
    expect(burstySnapshot.tickIntervalMsP50).toBeCloseTo(2, 6);
    expect(burstySnapshot.tickBurstiness).toBeGreaterThan(10);
  });
});

describe('corrections and frames', () => {
  it('summarizes correction magnitude and rate over the window', () => {
    const m = metrics();
    m.recordReconcile(0.1, 1000);
    m.recordReconcile(0.5, 1500);
    m.recordReconcile(0.3, 2000);

    const snapshot = m.refreshSnapshot(2000);
    expect(snapshot.reconcileCount).toBe(3);
    expect(snapshot.correctionMagnitudeLast).toBeCloseTo(0.3, 10);
    expect(snapshot.correctionMagnitudeMax).toBeCloseTo(0.5, 10);
    expect(snapshot.correctionMagnitudeP50).toBeCloseTo(0.3, 10);
    expect(snapshot.correctionsPerSecond).toBeGreaterThan(0);
  });

  it('ages a stale correction out instead of reporting it as current', () => {
    const m = metrics();
    m.recordReconcile(0.9, 1000);
    expect(m.refreshSnapshot(2000).correctionMagnitudeLast).toBeCloseTo(0.9, 10);

    // Well past the 5s window: nothing has been corrected recently, and the HUD must say so.
    const stale = m.refreshSnapshot(60_000);
    expect(stale.correctionMagnitudeLast).toBe(0);
    expect(stale.correctionMagnitudeMax).toBe(0);
    expect(stale.reconcileCount).toBe(0);
  });

  it('derives fps from the median frame time so one stall does not crater the reading', () => {
    const m = metrics();
    for (let index = 0; index < 60; index += 1) m.recordFrame(1 / 60, 1000 + index * 16.67);
    m.recordFrame(0.5, 2000); // one catastrophic 500ms frame

    const snapshot = m.refreshSnapshot(2000);
    expect(snapshot.fps).toBeCloseTo(60, 0);
    // A single outlier in 61 samples sits above the 95th percentile, so even the tail stays
    // calm — this is the intended robustness, not a blind spot: see the next test.
    expect(snapshot.frameMsP95).toBeCloseTo(16.67, 1);
  });

  it('surfaces sustained stalls in the p95 tail while the median stays healthy', () => {
    const m = metrics();
    for (let index = 0; index < 60; index += 1) m.recordFrame(1 / 60, 1000 + index * 16.67);
    // ~8% of the window stalling is a real hitch, and the tail must say so.
    for (let index = 0; index < 5; index += 1) m.recordFrame(0.5, 2000 + index);

    const snapshot = m.refreshSnapshot(2010);
    expect(snapshot.frameMsP50).toBeCloseTo(16.67, 1);
    expect(snapshot.frameMsP95).toBeGreaterThan(400);
  });

  it('passes the visual correction offset through as plain current state', () => {
    const m = metrics();
    m.setVisualCorrectionOffsetLength(0.25);
    expect(m.refreshSnapshot(0).visualCorrectionOffsetLength).toBeCloseTo(0.25, 10);
  });
});

describe('reset', () => {
  it('clears history, pending sends, and the published snapshot', () => {
    const m = metrics();
    m.recordFrame(1 / 60, 100);
    m.recordReconcile(0.4, 100);
    m.recordTransformArrival(100);
    m.recordTransformArrival(150);
    m.recordInputSent(1, 100);
    m.refreshSnapshot(200);

    m.reset();
    const snapshot = m.refreshSnapshot(200);
    expect(snapshot.reconcileCount).toBe(0);
    expect(snapshot.transformArrivalCount).toBe(0);
    expect(snapshot.fps).toBe(0);

    // The pre-reset send must not be matchable afterwards.
    m.recordAck(1, 300);
    expect(m.refreshSnapshot(300).ackSampleCount).toBe(0);
  });
});
