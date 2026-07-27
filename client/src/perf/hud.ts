/**
 * Netcode trouble is temporal: a useful overlay must reveal cadence and spikes,
 * not merely print a latest value. This HUD therefore paints the retained rings
 * directly into one dependency-free canvas. The canvas has fixed CSS dimensions,
 * a once-scaled HiDPI backing store, and fixed positioning outside document flow,
 * which keeps the diagnostic itself from causing layout thrash.
 *
 * The underlying recorder remains allocation-free on every frame and network row:
 * fixed Float64Array rings accept samples in place, percentile derivation reuses
 * caller-owned scratch, and one long-lived snapshot is mutated by refreshes. The
 * HUD redraws only around 10 Hz and walks each TimedRing directly rather than
 * collecting points into arrays. It also treats optional server tick statistics
 * structurally so this diagnostic can ship before, after, or without that table.
 */

import { debugBindingFor } from '../input/keymap';
import { isEditableTarget } from '../input/intents';
import type { NetcodeMetrics, NetcodeSnapshot } from './metrics';
import type { TimedRing } from './ring';

const HUD_WIDTH = 360;
const HUD_HEIGHT = 232;
const SPARKLINE_X = 92;
const SPARKLINE_WIDTH = 110;
const SPARKLINE_HEIGHT = 14;
const ROW_START_Y = 48;
const ROW_STEP = 32;
const REDRAW_INTERVAL_MS = 100;
const CORRECTION_SPIKE_METRES = 0.25;
const DURATION_KEY = /duration|ms/i;

const COLOR = {
  background: 'rgba(10, 14, 20, 0.92)',
  border: 'rgba(255, 255, 255, 0.16)',
  text: '#d7dee9',
  dim: '#687282',
  good: '#66d17a',
  warning: '#f0b84b',
  bad: '#ff5964',
  spike: '#ff3045',
  baseline: 'rgba(255, 255, 255, 0.13)',
} as const;

export interface PerfHudHandle {
  dispose(): void;
  setVisible(visible: boolean): void;
  toggle(): void;
  readonly visible: boolean;
}

export interface PerfHudOptions {
  metrics: NetcodeMetrics;
  /**
   * Reaches the live game store, probed structurally for a server-side tick-stats table.
   * A getter rather than the store itself because the store object is REPLACED when the
   * connection attaches, and returns `unknown` on purpose: the tick-stats table is being
   * added by a separate change and may not exist in this build — the HUD must render fine
   * without it.
   */
  store?: () => unknown;
  /** Defaults to the global document. */
  documentRef?: Document;
  /** Start hidden (default true — F3 reveals it). */
  startHidden?: boolean;
}

class NoopPerfHudHandle implements PerfHudHandle {
  get visible(): boolean {
    return false;
  }

  dispose(): void {}

  setVisible(): void {}

  toggle(): void {}
}

const NOOP_HANDLE: PerfHudHandle = new NoopPerfHudHandle();

class SparklinePainter {
  private context: CanvasRenderingContext2D | undefined;
  private tMin = 0;
  private windowMs = 1;
  private x = 0;
  private y = 0;
  private width = 0;
  private height = 0;
  private minimum = Number.POSITIVE_INFINITY;
  private maximum = Number.NEGATIVE_INFINITY;
  private sampleCount = 0;
  private hasLinePoint = false;
  private lineColor: string = COLOR.text;
  private spikeThreshold = Number.POSITIVE_INFINITY;

  private readonly collectExtents = (_t: number, value: number): void => {
    if (value < this.minimum) {
      this.minimum = value;
    }
    if (value > this.maximum) {
      this.maximum = value;
    }
    this.sampleCount += 1;
  };

  private readonly plotSample = (t: number, value: number): void => {
    const context = this.context;
    if (context === undefined) {
      return;
    }

    const sampleX = this.x + clamp01((t - this.tMin) / this.windowMs) * this.width;
    if (value >= this.spikeThreshold) {
      if (this.hasLinePoint) {
        context.stroke();
      }
      context.beginPath();
      context.strokeStyle = COLOR.spike;
      context.moveTo(sampleX, this.y);
      context.lineTo(sampleX, this.y + this.height);
      context.stroke();
      context.beginPath();
      context.strokeStyle = this.lineColor;
      this.hasLinePoint = false;
      return;
    }

    const range = this.maximum - this.minimum;
    const normalized = range > 0 ? (value - this.minimum) / range : 0.5;
    const sampleY = this.y + this.height - normalized * this.height;
    if (this.hasLinePoint) {
      context.lineTo(sampleX, sampleY);
    } else {
      context.moveTo(sampleX, sampleY);
      this.hasLinePoint = true;
    }
  };

  draw(
    context: CanvasRenderingContext2D,
    ring: TimedRing,
    tMin: number,
    windowMs: number,
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
    spikeThreshold = Number.POSITIVE_INFINITY,
  ): void {
    this.context = context;
    this.tMin = tMin;
    this.windowMs = windowMs;
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.minimum = Number.POSITIVE_INFINITY;
    this.maximum = Number.NEGATIVE_INFINITY;
    this.sampleCount = 0;
    this.hasLinePoint = false;
    this.lineColor = color;
    this.spikeThreshold = spikeThreshold;

    ring.forEachSince(tMin, this.collectExtents);

    context.lineWidth = 1;
    if (this.sampleCount === 0) {
      context.beginPath();
      context.strokeStyle = COLOR.baseline;
      context.moveTo(x, y + height - 0.5);
      context.lineTo(x + width, y + height - 0.5);
      context.stroke();
      return;
    }

    context.beginPath();
    context.strokeStyle = color;
    ring.forEachSince(tMin, this.plotSample);
    if (this.hasLinePoint) {
      context.stroke();
    }
  }
}

/** Mounts a fixed-position netcode instrumentation canvas. */
export function mountPerfHud(options: PerfHudOptions): PerfHudHandle {
  const documentRef =
    options.documentRef ??
    (typeof document === 'undefined' ? undefined : document);
  if (documentRef === undefined) {
    return NOOP_HANDLE;
  }

  const windowRef =
    documentRef.defaultView ??
    (typeof window === 'undefined' ? undefined : window);
  if (windowRef === undefined) {
    return NOOP_HANDLE;
  }

  const canvas = documentRef.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context === null) {
    return NOOP_HANDLE;
  }

  const pixelRatio = windowRef.devicePixelRatio || 1;
  canvas.width = Math.round(HUD_WIDTH * pixelRatio);
  canvas.height = Math.round(HUD_HEIGHT * pixelRatio);
  canvas.style.width = `${HUD_WIDTH}px`;
  canvas.style.height = `${HUD_HEIGHT}px`;
  canvas.style.position = 'fixed';
  canvas.style.right = '12px';
  canvas.style.bottom = '12px';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '2147483000';
  canvas.style.opacity = '0.92';
  canvas.setAttribute('aria-hidden', 'true');
  context.scale(pixelRatio, pixelRatio);

  let visible = !(options.startHidden ?? true);
  let disposed = false;
  let animationFrame = 0;
  let lastDrawAt = 0;
  const sparklinePainter = new SparklinePainter();
  canvas.style.display = visible ? 'block' : 'none';
  documentRef.body.appendChild(canvas);

  const setVisible = (nextVisible: boolean): void => {
    if (disposed || visible === nextVisible) {
      return;
    }
    visible = nextVisible;
    canvas.style.display = visible ? 'block' : 'none';
    if (visible) {
      lastDrawAt = 0;
    }
  };

  const toggle = (): void => {
    setVisible(!visible);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as {
      isContentEditable?: boolean;
      tagName?: string;
    } | null;
    if (isEditableTarget(target)) {
      return;
    }
    if (debugBindingFor(event.code) === 'perfHud') {
      toggle();
      event.preventDefault();
    }
  };

  const draw = (timestamp: number): void => {
    const snapshot = options.metrics.refreshSnapshot(timestamp);
    const windowMs = options.metrics.windowSeconds * 1000;
    const tMin = timestamp - windowMs;

    context.clearRect(0, 0, HUD_WIDTH, HUD_HEIGHT);
    drawPanel(context);
    drawTitle(context, options.metrics.windowSeconds);

    const fpsColor =
      snapshot.fps === 0
        ? COLOR.dim
        : snapshot.fps < 50
          ? COLOR.bad
          : snapshot.fps < 58
            ? COLOR.warning
            : COLOR.good;
    drawMetricRow(
      context,
      sparklinePainter,
      0,
      'fps',
      snapshot.fps.toFixed(0),
      fpsColor,
      options.metrics.series.frameMs,
      tMin,
      windowMs,
    );

    const tickColor =
      snapshot.tickIntervalMsP50 === 0
        ? COLOR.dim
        : snapshot.tickBurstiness < 1.5
          ? COLOR.good
          : snapshot.tickBurstiness < 2.5
            ? COLOR.warning
            : COLOR.bad;
    drawMetricRow(
      context,
      sparklinePainter,
      1,
      'tick ms',
      `${snapshot.tickIntervalMsLast.toFixed(0)}  ${snapshot.tickIntervalMsP50.toFixed(0)}/${snapshot.tickIntervalMsP95.toFixed(0)} ms`,
      tickColor,
      options.metrics.series.tickIntervalMs,
      tMin,
      windowMs,
    );

    const ackColor =
      snapshot.ackSampleCount === 0
        ? COLOR.dim
        : snapshot.ackRttMsLast < 80
          ? COLOR.good
          : snapshot.ackRttMsLast < 150
            ? COLOR.warning
            : COLOR.bad;
    drawMetricRow(
      context,
      sparklinePainter,
      2,
      'ack rtt',
      `${snapshot.ackRttMsLast.toFixed(0)}  ${snapshot.ackRttMsP50.toFixed(0)}/${snapshot.ackRttMsP95.toFixed(0)} ms`,
      ackColor,
      options.metrics.series.ackRttMs,
      tMin,
      windowMs,
    );

    const correctionColor =
      snapshot.reconcileCount === 0
        ? COLOR.dim
        : snapshot.correctionMagnitudeMax >= CORRECTION_SPIKE_METRES
          ? COLOR.bad
          : COLOR.good;
    drawMetricRow(
      context,
      sparklinePainter,
      3,
      'corr m',
      `${snapshot.correctionMagnitudeLast.toFixed(3)}  p95 ${snapshot.correctionMagnitudeP95.toFixed(3)} m`,
      correctionColor,
      options.metrics.series.correctionMagnitude,
      tMin,
      windowMs,
      CORRECTION_SPIKE_METRES,
    );

    drawMetricRow(
      context,
      sparklinePainter,
      4,
      'corr /s',
      `${snapshot.correctionsPerSecond.toFixed(1)} /s`,
      COLOR.text,
      undefined,
      tMin,
      windowMs,
    );
    drawTickStatsRow(context, snapshot, options.store?.());
  };

  const animate = (timestamp: number): void => {
    if (disposed) {
      return;
    }

    animationFrame = windowRef.requestAnimationFrame(animate);
    if (!visible || timestamp - lastDrawAt < REDRAW_INTERVAL_MS) {
      return;
    }

    lastDrawAt = timestamp;
    draw(timestamp);
  };

  windowRef.addEventListener('keydown', onKeyDown, true);
  animationFrame = windowRef.requestAnimationFrame(animate);

  return {
    get visible(): boolean {
      return visible;
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      windowRef.removeEventListener('keydown', onKeyDown, true);
      windowRef.cancelAnimationFrame(animationFrame);
      canvas.remove();
    },
    setVisible,
    toggle,
  };
}

function drawPanel(context: CanvasRenderingContext2D): void {
  const radius = 8;
  context.beginPath();
  context.moveTo(radius, 0);
  context.lineTo(HUD_WIDTH - radius, 0);
  context.quadraticCurveTo(HUD_WIDTH, 0, HUD_WIDTH, radius);
  context.lineTo(HUD_WIDTH, HUD_HEIGHT - radius);
  context.quadraticCurveTo(
    HUD_WIDTH,
    HUD_HEIGHT,
    HUD_WIDTH - radius,
    HUD_HEIGHT,
  );
  context.lineTo(radius, HUD_HEIGHT);
  context.quadraticCurveTo(0, HUD_HEIGHT, 0, HUD_HEIGHT - radius);
  context.lineTo(0, radius);
  context.quadraticCurveTo(0, 0, radius, 0);
  context.closePath();
  context.fillStyle = COLOR.background;
  context.fill();
  context.strokeStyle = COLOR.border;
  context.lineWidth = 1;
  context.stroke();
}

function drawTitle(
  context: CanvasRenderingContext2D,
  windowSeconds: number,
): void {
  context.font = '11px ui-monospace, Menlo, Consolas, monospace';
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  context.fillStyle = COLOR.text;
  context.fillText('perf  F3', 14, 20);
  context.textAlign = 'right';
  context.fillStyle = COLOR.dim;
  context.fillText(`rolling ${windowSeconds.toFixed(1)}s`, HUD_WIDTH - 14, 20);
}

function drawMetricRow(
  context: CanvasRenderingContext2D,
  sparklinePainter: SparklinePainter,
  row: number,
  label: string,
  value: string,
  color: string,
  ring: TimedRing | undefined,
  tMin: number,
  windowMs: number,
  spikeThreshold = Number.POSITIVE_INFINITY,
): void {
  const centerY = ROW_START_Y + row * ROW_STEP;
  context.font = '11px ui-monospace, Menlo, Consolas, monospace';
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  context.fillStyle = COLOR.dim;
  context.fillText(label, 14, centerY);

  if (ring !== undefined) {
    sparklinePainter.draw(
      context,
      ring,
      tMin,
      windowMs,
      SPARKLINE_X,
      centerY - SPARKLINE_HEIGHT / 2,
      SPARKLINE_WIDTH,
      SPARKLINE_HEIGHT,
      color,
      spikeThreshold,
    );
  }

  context.textAlign = 'right';
  context.fillStyle = color;
  context.fillText(value, HUD_WIDTH - 14, centerY);
}

function drawTickStatsRow(
  context: CanvasRenderingContext2D,
  snapshot: NetcodeSnapshot,
  store: unknown,
): void {
  const centerY = ROW_START_Y + 5 * ROW_STEP;
  const fields = probeTickStats(store);

  context.font = '11px ui-monospace, Menlo, Consolas, monospace';
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  context.fillStyle = COLOR.dim;
  context.fillText('tick_stats', 14, centerY);
  context.textAlign = 'right';
  context.fillStyle =
    fields === undefined || snapshot.transformArrivalCount === 0
      ? COLOR.dim
      : COLOR.text;
  context.fillText(fields ?? '—', HUD_WIDTH - 14, centerY);
}

function probeTickStats(store: unknown): string | undefined {
  try {
    if (typeof store !== 'object' || store === null) {
      return undefined;
    }

    // This structural probe intentionally avoids importing the generated store
    // schema, so the HUD never compile-depends on the separate tick-stats change.
    const candidate = store as { tickStats?: unknown };
    if (!(candidate.tickStats instanceof Map)) {
      return undefined;
    }

    let lastValue: unknown;
    for (const value of candidate.tickStats.values()) {
      lastValue = value;
    }
    if (typeof lastValue !== 'object' || lastValue === null) {
      return undefined;
    }

    const record = lastValue as Record<string, unknown>;
    let selectedOne = '';
    let selectedTwo = '';
    let selectedThree = '';
    let rendered = '';
    let count = 0;

    for (const key in record) {
      if (
        Object.prototype.hasOwnProperty.call(record, key) &&
        DURATION_KEY.test(key)
      ) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          rendered += `${count === 0 ? '' : '  '}${key}=${value.toFixed(2)}`;
          if (count === 0) {
            selectedOne = key;
          } else if (count === 1) {
            selectedTwo = key;
          } else {
            selectedThree = key;
          }
          count += 1;
          if (count === 3) {
            return rendered;
          }
        }
      }
    }

    for (const key in record) {
      if (
        Object.prototype.hasOwnProperty.call(record, key) &&
        key !== selectedOne &&
        key !== selectedTwo &&
        key !== selectedThree
      ) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          rendered += `${count === 0 ? '' : '  '}${key}=${value.toFixed(2)}`;
          count += 1;
          if (count === 3) {
            break;
          }
        }
      }
    }

    return count === 0 ? undefined : rendered;
  } catch {
    return undefined;
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
