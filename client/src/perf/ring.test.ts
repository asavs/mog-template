import { describe, expect, it } from 'vitest';
import { TimedRing, burstiness, percentileOfSorted } from './ring';

/** Fills `ring` with (t, value) pairs one millisecond apart starting at `startT`. */
function fill(ring: TimedRing, values: readonly number[], startT = 0): void {
  values.forEach((value, index) => ring.push(startT + index, value));
}

describe('percentileOfSorted', () => {
  it('interpolates linearly between order statistics', () => {
    const sorted = Float64Array.from([1, 2, 3, 4]);
    expect(percentileOfSorted(sorted, 4, 0)).toBe(1);
    expect(percentileOfSorted(sorted, 4, 1)).toBe(4);
    // rank = (4-1)*0.5 = 1.5 → halfway between the 2nd and 3rd values.
    expect(percentileOfSorted(sorted, 4, 0.5)).toBeCloseTo(2.5, 10);
    expect(percentileOfSorted(sorted, 4, 0.95)).toBeCloseTo(3.85, 10);
  });

  it('respects `count` rather than the buffer length, so a scratch tail is ignored', () => {
    // A scratch array reused across calls keeps stale values past `count` — reading them
    // would silently corrupt every percentile after the first.
    const scratch = Float64Array.from([1, 2, 999, 999]);
    expect(percentileOfSorted(scratch, 2, 1)).toBe(2);
  });

  it('returns NaN for an empty window and the lone value for a single sample', () => {
    expect(percentileOfSorted(Float64Array.from([]), 0, 0.5)).toBeNaN();
    expect(percentileOfSorted(Float64Array.from([7]), 1, 0.95)).toBe(7);
  });
});

describe('burstiness', () => {
  it('is 1 for an even stream and grows with the p95 tail', () => {
    expect(burstiness(50, 50)).toBe(1);
    expect(burstiness(50, 150)).toBe(3);
  });

  it('is NaN rather than Infinity when there is nothing to divide by', () => {
    expect(burstiness(0, 50)).toBeNaN();
    expect(burstiness(Number.NaN, 50)).toBeNaN();
    expect(burstiness(50, Number.NaN)).toBeNaN();
  });
});

describe('TimedRing', () => {
  it('rejects a nonsensical capacity instead of silently never recording', () => {
    expect(() => new TimedRing(0)).toThrow(RangeError);
    expect(() => new TimedRing(1.5)).toThrow(RangeError);
  });

  it('caps at capacity and keeps the newest samples when it wraps', () => {
    const ring = new TimedRing(4);
    fill(ring, [1, 2, 3, 4, 5, 6]);

    expect(ring.length).toBe(4);
    expect(ring.capacity).toBe(4);
    expect(ring.latest()).toBe(6);

    // Oldest-first after wrapping — the two earliest samples are gone, not reordered.
    const seen: number[] = [];
    ring.forEachSince(Number.NEGATIVE_INFINITY, (_t, value) => void seen.push(value));
    expect(seen).toEqual([3, 4, 5, 6]);
  });

  it('reports NaN rather than a stale or zero reading when empty', () => {
    const ring = new TimedRing(4);
    expect(ring.latest()).toBeNaN();
    expect(ring.latestSince(0)).toBeNaN();
    expect(ring.maxSince(0)).toBeNaN();
    expect(ring.percentileSince(0, 0.5, new Float64Array(4))).toBeNaN();
    expect(ring.countSince(0)).toBe(0);
    expect(ring.ratePerSecond(0, 1000)).toBe(0);
  });

  it('windows every derivation by tMin', () => {
    const ring = new TimedRing(8);
    // Values 1..6 at t = 0,1,2,3,4,5.
    fill(ring, [1, 2, 3, 4, 5, 6]);

    expect(ring.countSince(3)).toBe(3); // t = 3,4,5
    expect(ring.maxSince(3)).toBe(6);
    expect(ring.maxSince(Number.NEGATIVE_INFINITY)).toBe(6);
    expect(ring.percentileSince(3, 0.5, new Float64Array(8))).toBeCloseTo(5, 10);
    // Outside the window the whole set is still visible.
    expect(ring.percentileSince(0, 0.5, new Float64Array(8))).toBeCloseTo(3.5, 10);

    const seen: number[] = [];
    ring.forEachSince(4, (_t, value) => void seen.push(value));
    expect(seen).toEqual([5, 6]);
  });

  it('latestSince hides a newest sample that has aged out of the window', () => {
    // The reason this exists: a correction from a minute ago must not keep reading as "current"
    // on a live HUD just because nothing has happened since.
    const ring = new TimedRing(4);
    ring.push(1000, 0.42);
    expect(ring.latestSince(500)).toBe(0.42);
    expect(ring.latestSince(2000)).toBeNaN();
    // `latest()` deliberately still reports it — the windowing is the caller's choice.
    expect(ring.latest()).toBe(0.42);
  });

  it('sorts only the live prefix of the scratch buffer', () => {
    // A shared scratch array is reused across channels; a sort that touched the whole buffer
    // would mix a previous channel's leftovers into this channel's percentile.
    const ring = new TimedRing(8);
    fill(ring, [3, 1, 2]);
    const scratch = new Float64Array(8).fill(999);
    expect(ring.percentileSince(0, 1, scratch)).toBe(3);
    expect(ring.percentileSince(0, 0, scratch)).toBe(1);
  });

  it('refuses a scratch buffer too small to hold a full window', () => {
    const ring = new TimedRing(8);
    fill(ring, [1, 2, 3]);
    expect(() => ring.percentileSince(0, 0.5, new Float64Array(4))).toThrow(RangeError);
  });

  it('measures rate over the observed span, not the whole nominal window', () => {
    const ring = new TimedRing(16);
    // 5 samples spanning t=1000..2000, sampled at t=2000 with a window opening at t=1000.
    for (let index = 0; index < 5; index += 1) ring.push(1000 + index * 250, 1);
    // Oldest matched sample is at t=1000, so the observed span is the full 1000ms.
    expect(ring.ratePerSecond(1000, 2000)).toBeCloseTo(5, 10);
    // Halving the window to the last 500ms leaves 3 samples over 500ms.
    expect(ring.ratePerSecond(1500, 2000)).toBeCloseTo(6, 10);
  });

  it('clear() drops history without reallocating the ring', () => {
    const ring = new TimedRing(4);
    fill(ring, [1, 2, 3]);
    ring.clear();
    expect(ring.length).toBe(0);
    expect(ring.latest()).toBeNaN();
    ring.push(10, 5);
    expect(ring.length).toBe(1);
    expect(ring.latest()).toBe(5);
  });

  it('does not allocate on the recording path', () => {
    // The whole point of the fixed backing arrays: recording during a hitch must not create
    // garbage that perturbs the very frame times being measured. Proxy for that here: pushing
    // far past capacity never grows the structure.
    const ring = new TimedRing(32);
    for (let index = 0; index < 10_000; index += 1) ring.push(index, index);
    expect(ring.length).toBe(32);
    expect(ring.latest()).toBe(9_999);
  });
});
