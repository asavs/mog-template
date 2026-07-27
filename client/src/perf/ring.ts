/**
 * Performance telemetry is most useful when it can stay enabled during the exact
 * hitch or packet burst being investigated. That makes garbage created by the
 * recorder self-defeating: an innocent growing array can perturb the frame times
 * it is meant to explain. This module therefore stores timestamps and values in
 * fixed Float64Array rings and overwrites old history when full. Recording is an
 * allocation-free indexed write.
 *
 * Derivation is deliberately separated from recording. Percentiles copy into a
 * caller-owned scratch buffer and sort that prefix in place, so even the more
 * expensive path avoids temporary arrays. The explicit iteration callback keeps
 * consumers such as the canvas HUD from materializing point collections while
 * still preserving oldest-first traversal.
 */

function sortPrefix(values: Float64Array, count: number): void {
  for (let root = Math.floor(count / 2) - 1; root >= 0; root -= 1) {
    siftDown(values, root, count);
  }

  for (let end = count - 1; end > 0; end -= 1) {
    const first = values[0];
    values[0] = values[end];
    values[end] = first;
    siftDown(values, 0, end);
  }
}

function siftDown(values: Float64Array, root: number, count: number): void {
  let current = root;

  while (true) {
    const left = current * 2 + 1;
    if (left >= count) {
      return;
    }

    const right = left + 1;
    let largest = left;
    if (right < count && values[right] > values[left]) {
      largest = right;
    }

    if (values[current] >= values[largest]) {
      return;
    }

    const held = values[current];
    values[current] = values[largest];
    values[largest] = held;
    current = largest;
  }
}

/** Fixed-capacity ring of (timestamp, value) pairs. Overwrites oldest on overflow. */
export class TimedRing {
  readonly capacity: number;

  private readonly times: Float64Array;
  private readonly values: Float64Array;
  private head = 0;
  private sampleCount = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('TimedRing capacity must be a positive integer');
    }

    this.capacity = capacity;
    this.times = new Float64Array(capacity);
    this.values = new Float64Array(capacity);
  }

  /** Live sample count (<= capacity). */
  get length(): number {
    return this.sampleCount;
  }

  /** Allocation-free. `t` is a monotonic ms timestamp (performance.now()). */
  push(t: number, value: number): void {
    this.times[this.head] = t;
    this.values[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.sampleCount < this.capacity) {
      this.sampleCount += 1;
    }
  }

  /** Newest sample's value, or NaN when empty. */
  latest(): number {
    if (this.sampleCount === 0) {
      return Number.NaN;
    }

    const newest = (this.head + this.capacity - 1) % this.capacity;
    return this.values[newest];
  }

  /**
   * Newest sample's value, but only when it still falls inside the window — otherwise NaN.
   * `latest()` alone would keep reporting a correction that landed a minute ago as if it
   * were current, which is exactly the misreading a feel-test HUD must not invite. Samples
   * arrive in nondecreasing time order, so the newest is the only candidate and this stays O(1).
   */
  latestSince(tMin: number): number {
    if (this.sampleCount === 0) {
      return Number.NaN;
    }

    const newest = (this.head + this.capacity - 1) % this.capacity;
    return this.times[newest] >= tMin ? this.values[newest] : Number.NaN;
  }

  /** How many samples have t >= tMin. */
  countSince(tMin: number): number {
    let matched = 0;
    let index = this.oldestIndex();

    for (let offset = 0; offset < this.sampleCount; offset += 1) {
      if (this.times[index] >= tMin) {
        matched += 1;
      }
      index = (index + 1) % this.capacity;
    }

    return matched;
  }

  /** countSince(tMin) divided by the observed window, in Hz. 0 when empty. */
  ratePerSecond(tMin: number, now: number): number {
    let matched = 0;
    let oldestMatched = Number.POSITIVE_INFINITY;
    let index = this.oldestIndex();

    for (let offset = 0; offset < this.sampleCount; offset += 1) {
      const sampleTime = this.times[index];
      if (sampleTime >= tMin) {
        matched += 1;
        if (sampleTime < oldestMatched) {
          oldestMatched = sampleTime;
        }
      }
      index = (index + 1) % this.capacity;
    }

    if (matched === 0) {
      return 0;
    }

    const observedStart = Math.max(tMin, oldestMatched);
    const observedMs = now - observedStart;
    return observedMs > 0 ? matched * 1000 / observedMs : 0;
  }

  /**
   * Linear-interpolated percentile of the values with t >= tMin. `q` in [0,1].
   * Copies into `scratch` (length must be >= capacity) and sorts it IN PLACE —
   * no allocation. Returns NaN when the window is empty.
   */
  percentileSince(tMin: number, q: number, scratch: Float64Array): number {
    if (scratch.length < this.capacity) {
      throw new RangeError('Percentile scratch must be at least the ring capacity');
    }

    let copied = 0;
    let index = this.oldestIndex();

    for (let offset = 0; offset < this.sampleCount; offset += 1) {
      if (this.times[index] >= tMin) {
        scratch[copied] = this.values[index];
        copied += 1;
      }
      index = (index + 1) % this.capacity;
    }

    if (copied === 0) {
      return Number.NaN;
    }

    sortPrefix(scratch, copied);
    return percentileOfSorted(scratch, copied, q);
  }

  /** Largest value with t >= tMin, or NaN when empty. */
  maxSince(tMin: number): number {
    let maximum = Number.NEGATIVE_INFINITY;
    let matched = false;
    let index = this.oldestIndex();

    for (let offset = 0; offset < this.sampleCount; offset += 1) {
      if (this.times[index] >= tMin) {
        matched = true;
        if (this.values[index] > maximum) {
          maximum = this.values[index];
        }
      }
      index = (index + 1) % this.capacity;
    }

    return matched ? maximum : Number.NaN;
  }

  /** Oldest-first iteration over samples with t >= tMin. `fn` must not allocate. */
  forEachSince(tMin: number, fn: (t: number, value: number) => void): void {
    let index = this.oldestIndex();

    for (let offset = 0; offset < this.sampleCount; offset += 1) {
      const sampleTime = this.times[index];
      if (sampleTime >= tMin) {
        fn(sampleTime, this.values[index]);
      }
      index = (index + 1) % this.capacity;
    }
  }

  /** Drops every sample. */
  clear(): void {
    this.head = 0;
    this.sampleCount = 0;
  }

  private oldestIndex(): number {
    return (this.head + this.capacity - this.sampleCount) % this.capacity;
  }
}

/**
 * p95/p50 — how spiky a stream of intervals is. 1 = perfectly even. NaN-safe:
 * returns NaN if either input is NaN or p50 is 0.
 */
export function burstiness(p50: number, p95: number): number {
  if (Number.isNaN(p50) || Number.isNaN(p95) || p50 === 0) {
    return Number.NaN;
  }

  return p95 / p50;
}

/** Linear-interpolated percentile of `sorted[0..count)`, ascending. Exported for direct testing. */
export function percentileOfSorted(
  sorted: Float64Array,
  count: number,
  q: number,
): number {
  if (count <= 0) {
    return Number.NaN;
  }
  if (count > sorted.length) {
    throw new RangeError('Percentile count exceeds the source length');
  }
  if (count === 1) {
    return sorted[0];
  }

  const quantile = Math.min(1, Math.max(0, q));
  const rank = (count - 1) * quantile;
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  return lower + (upper - lower) * (rank - lowerIndex);
}
