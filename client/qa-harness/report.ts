/**
 * Renders one harness run (optionally overlaid with a reference run) as a
 * self-contained HTML report: verdict, per-phase summary table, time-series
 * charts of correction error and visual offset with phase bands and input
 * markers, and a top-down path plot. Static SVG only — no scripts, no
 * external requests — so a report file is a durable, shareable artifact.
 *
 * Generated automatically at the end of every `qa:harness` run; regenerate
 * or compare any two stored runs with:
 *
 *   npm run qa:report -- runs/<run>.ndjson [--against runs/<other>.ndjson] [--out <file>.html]
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RunData, TraceRecord } from './trace-types';
import { readRun } from './trace-io';
import { summarizeByPhase, type TraceSummary } from './trace-stats';
import type { ComparisonFailure } from './compare-baseline';
import type { InvariantFailure } from './invariants';
import { perfReportSection } from './perf-report';
import { firstFrameInPhase, formatVideoAt, formatVideoOffset, hasVideo, videoOffsetSeconds } from './video-time';

export type ReportOptions = {
  reference?: RunData;
  structuralIssues?: string[];
  /** Baseline comparison result; undefined = comparison did not run. */
  comparison?: ComparisonFailure[];
  invariantFailures?: InvariantFailure[];
};

// ---------------------------------------------------------------------------
// Small helpers

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmt = (v: number | undefined, digits = 3) =>
  v === undefined || Number.isNaN(v) ? '—' : v.toFixed(digits);

type Pt = { x: number; y: number };

function linScale(domain: [number, number], range: [number, number]) {
  const d = domain[1] - domain[0] || 1;
  return (v: number) => range[0] + ((v - domain[0]) / d) * (range[1] - range[0]);
}

/** Even-stride downsample so polylines stay under ~maxPts points. */
function downsample<T>(items: T[], maxPts: number): T[] {
  if (items.length <= maxPts) return items;
  const stride = Math.ceil(items.length / maxPts);
  const out = items.filter((_, i) => i % stride === 0);
  if (out[out.length - 1] !== items[items.length - 1]) out.push(items[items.length - 1]);
  return out;
}

type PhaseSpan = { name: string; t0: number; t1: number };

function phaseVideoWindow(run: RunData, span: PhaseSpan): string {
  const start = videoOffsetSeconds(run, span.t0);
  const end = videoOffsetSeconds(run, span.t1);
  if (start === null || end === null) return '';
  return `video ${formatVideoOffset(start)}-${formatVideoOffset(end)}`;
}

function phaseSpans(frames: TraceRecord[]): PhaseSpan[] {
  const spans: PhaseSpan[] = [];
  for (const f of frames) {
    const last = spans[spans.length - 1];
    if (!last || last.name !== f.phase) spans.push({ name: f.phase, t0: f.t, t1: f.t });
    else last.t1 = f.t;
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Time-series chart (one metric over the run, phase bands, input markers)

type SeriesSpec = {
  title: string;
  /** Extracts the metric from a frame; null values are skipped. */
  value: (f: TraceRecord) => number | null;
  digits: number;
};

const CHART_W = 880;
const CHART_H = 250;
const M = { l: 52, r: 14, t: 10, b: 46 }; // bottom includes the event strip
const EVENT_STRIP_H = 16;

function seriesPoints(frames: TraceRecord[], spec: SeriesSpec, t0: number): Pt[] {
  const pts: Pt[] = [];
  for (const f of frames) {
    const v = spec.value(f);
    if (v !== null && !Number.isNaN(v)) pts.push({ x: (f.t - t0) / 1000, y: v });
  }
  return pts;
}

function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const step = Math.pow(10, Math.floor(Math.log10(max / count)));
  const err = max / count / step;
  const mult = err >= 5 ? 10 : err >= 2 ? 5 : err >= 1 ? 2 : 1;
  const s = step * mult;
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += s) ticks.push(v);
  return ticks;
}

function timeSeriesChart(
  spec: SeriesSpec,
  candidate: RunData,
  reference: RunData | undefined,
): string {
  const t0 = candidate.frames[0]?.t ?? 0;
  const cand = seriesPoints(candidate.frames, spec, t0);
  const refT0 = reference?.frames[0]?.t ?? 0;
  const ref = reference ? seriesPoints(reference.frames, spec, refT0) : [];

  // X spans the whole run (not just where this metric had values), so all
  // charts in a report share one time axis and align with the phase bands.
  const durOf = (frames: TraceRecord[]) =>
    frames.length >= 2 ? (frames[frames.length - 1].t - frames[0].t) / 1000 : 0;
  const xMax = Math.max(durOf(candidate.frames), reference ? durOf(reference.frames) : 0, 1);
  const peak = Math.max(0, ...cand.map((p) => p.y), ...ref.map((p) => p.y));
  const flat = peak <= 0;
  const yMax = flat ? 1 : peak * 1.08;
  const x = linScale([0, xMax], [M.l, CHART_W - M.r]);
  const y = linScale([0, yMax], [CHART_H - M.b, M.t]);
  const plotBottom = CHART_H - M.b;

  const line = (pts: Pt[]) =>
    downsample(pts, 1400).map((p) => `${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');

  // Phase bands: alternating neutral wash, vertical label at each band start.
  const bands = phaseSpans(candidate.frames)
    .map((s, i) => {
      const bx0 = x((s.t0 - t0) / 1000);
      const bx1 = x((s.t1 - t0) / 1000);
      const wash = i % 2 === 1 ? `<rect x="${bx0.toFixed(1)}" y="${M.t}" width="${(bx1 - bx0).toFixed(1)}" height="${plotBottom - M.t}" class="band"/>` : '';
      const label = `<text x="${(bx0 + 4).toFixed(1)}" y="${M.t + 4}" class="band-label" transform="rotate(90 ${(bx0 + 4).toFixed(1)} ${M.t + 4})">${esc(s.name)}</text>`;
      return `<g><title>${esc(s.name)}: ${((s.t0 - t0) / 1000).toFixed(1)}s – ${((s.t1 - t0) / 1000).toFixed(1)}s</title>${wash}${label}</g>`;
    })
    .join('');

  // Input markers: a tick strip under the x-axis; presses taller than releases.
  const ticks = candidate.events
    .filter((e) => e.kind !== 'phase')
    .map((e) => {
      const ex = x((e.t - t0) / 1000);
      if (ex < M.l || ex > CHART_W - M.r) return '';
      const press = e.kind === 'keydown' || e.kind === 'mousedown';
      const h = press ? EVENT_STRIP_H - 4 : (EVENT_STRIP_H - 4) / 2;
      return `<line x1="${ex.toFixed(1)}" y1="${plotBottom + 4}" x2="${ex.toFixed(1)}" y2="${(plotBottom + 4 + h).toFixed(1)}" class="event-tick${press ? ' press' : ''}"><title>${esc(e.kind)} ${esc(e.detail)} @ ${((e.t - t0) / 1000).toFixed(2)}s</title></line>`;
    })
    .join('');

  const decimalsFor = (ticks: number[]) => {
    const step = ticks.length >= 2 ? ticks[1] - ticks[0] : 1;
    return step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
  };

  const yTickVals = flat ? [0] : niceTicks(yMax);
  const yDec = decimalsFor(yTickVals);
  const yTicks = yTickVals
    .map((v) => {
      const ty = y(v);
      return `<line x1="${M.l}" y1="${ty.toFixed(1)}" x2="${CHART_W - M.r}" y2="${ty.toFixed(1)}" class="grid"/>` +
        `<text x="${M.l - 6}" y="${(ty + 3).toFixed(1)}" class="tick" text-anchor="end">${v.toFixed(yDec)}</text>`;
    })
    .join('');
  const flatNote = flat
    ? `<text x="${(M.l + (CHART_W - M.r)) / 2}" y="${(M.t + plotBottom) / 2}" class="tick" text-anchor="middle">${cand.length === 0 ? 'no data recorded for this metric' : 'flat at 0 for this run'}</text>`
    : '';
  const xTickVals = niceTicks(xMax, 8);
  const xDec = decimalsFor(xTickVals);
  const xTicks = xTickVals
    .map((v) => `<text x="${x(v).toFixed(1)}" y="${plotBottom + EVENT_STRIP_H + 18}" class="tick" text-anchor="middle">${v.toFixed(xDec)}s</text>`)
    .join('');

  const legend = reference
    ? `<div class="legend"><span><span class="swatch" style="background:var(--series-1)"></span>this run (${esc(candidate.meta.label)})</span>` +
      `<span><span class="swatch swatch-dashed" style="background:var(--series-2)"></span>reference (${esc(reference.meta.label)})</span></div>`
    : '';

  return `
  <figure>
    <figcaption>${esc(spec.title)}</figcaption>
    ${legend}
    <svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img" aria-label="${esc(spec.title)} over time">
      ${bands}
      ${yTicks}
      <line x1="${M.l}" y1="${plotBottom}" x2="${CHART_W - M.r}" y2="${plotBottom}" class="axis"/>
      ${ref.length > 0 ? `<polyline points="${line(ref)}" class="series series-ref"/>` : ''}
      ${cand.length > 0 ? `<polyline points="${line(cand)}" class="series series-cand"/>` : ''}
      ${flatNote}
      ${ticks}
      ${xTicks}
    </svg>
  </figure>`;
}

// ---------------------------------------------------------------------------
// Top-down path plot (sim X/Z, time encoded light→dark, phase starts labeled)

const PATH_W = 460;
const PATH_H = 400;

function pathPlot(run: RunData): string {
  const pts = run.frames
    .filter((f) => f.simPosition)
    .map((f) => ({ x: f.simPosition!.x, y: f.simPosition!.z, t: f.t, phase: f.phase }));
  if (pts.length < 2) return '';

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  // Equal aspect: one world-units-per-pixel scale for both axes.
  const halfSpan = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1) / 2 * 1.15;
  const px = linScale([cx - halfSpan, cx + halfSpan], [10, PATH_W - 10]);
  const py = linScale([cy - halfSpan, cy + halfSpan], [PATH_H - 10, 10]);

  // Time runs light→dark along the sequential ramp (--ramp-0 … --ramp-8).
  const drawn = downsample(pts, 900);
  const segments = drawn
    .slice(1)
    .map((p, i) => {
      const a = drawn[i];
      const rampIdx = Math.min(8, Math.floor((i / Math.max(1, drawn.length - 2)) * 9));
      return `<line x1="${px(a.x).toFixed(1)}" y1="${py(a.y).toFixed(1)}" x2="${px(p.x).toFixed(1)}" y2="${py(p.y).toFixed(1)}" stroke="var(--ramp-${rampIdx})" stroke-width="2" stroke-linecap="round"/>`;
    })
    .join('');

  // Many phases start at (nearly) the same spot — e.g. spawn, or the
  // stationary combat casts — so labels are stacked downward whenever they
  // would land on an already-placed one.
  const placed: Array<{ x: number; y: number }> = [];
  const labels = phaseSpans(run.frames)
    .map((s) => {
      const f = run.frames.find((fr) => fr.phase === s.name && fr.simPosition);
      if (!f?.simPosition) return '';
      const lx = px(f.simPosition.x);
      const dotY = py(f.simPosition.z);
      let ly = dotY - 4;
      while (placed.some((p) => Math.abs(p.x - lx) < 110 && Math.abs(p.y - ly) < 11)) ly += 11;
      placed.push({ x: lx, y: ly });
      return `<g><title>${esc(s.name)} starts here</title><circle cx="${lx.toFixed(1)}" cy="${dotY.toFixed(1)}" r="3" class="phase-dot"/>` +
        `<text x="${(lx + 5).toFixed(1)}" y="${ly.toFixed(1)}" class="band-label">${esc(s.name)}</text></g>`;
    })
    .join('');

  return `
  <figure>
    <figcaption>Top-down path (sim X/Z) — line runs light→dark from start to end; dots mark phase starts</figcaption>
    <svg viewBox="0 0 ${PATH_W} ${PATH_H}" role="img" aria-label="Top-down movement path">
      ${segments}
      ${labels}
    </svg>
  </figure>`;
}

// ---------------------------------------------------------------------------
// Game-state channels (dynamic — whatever the client published; see
// useQaGameDebug.ts). Channels that varied get a chart; constant ones are
// listed compactly so a report doesn't drown in flat lines.

function channelsSection(candidate: RunData, reference: RunData | undefined): string {
  const keys = [...new Set(candidate.frames.flatMap((f) => Object.keys(f.channels ?? {})))].sort();
  if (keys.length === 0) return '';

  const constants: string[] = [];
  const charts: string[] = [];
  for (const key of keys) {
    const values = candidate.frames
      .map((f) => f.channels?.[key])
      .filter((v): v is number => typeof v === 'number');
    if (values.length === 0) continue;
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (min === max) {
      constants.push(`<li><code>${esc(key)}</code> constant at ${fmt(min, Number.isInteger(min) ? 0 : 3)}</li>`);
      continue;
    }
    const digits = values.every((v) => Number.isInteger(v)) ? 0 : 3;
    charts.push(
      timeSeriesChart(
        { title: `Game state: ${key}`, value: (f) => f.channels?.[key] ?? null, digits },
        candidate,
        reference,
      ),
    );
  }

  const constantsBlock = constants.length > 0
    ? `<section><h2>Constant game-state channels</h2><ul class="issues">${constants.join('')}</ul></section>`
    : '';
  return charts.join('') + constantsBlock;
}

// ---------------------------------------------------------------------------
// Per-phase summary table

function summaryTable(
  candidate: RunData,
  candSummary: TraceSummary,
  refSummary: TraceSummary | undefined,
  failingPhases: Set<string>,
): string {
  const phases = Object.keys(candSummary);
  const firstFail = phases.findIndex((p) => failingPhases.has(p));
  const spans = new Map(phaseSpans(candidate.frames).map((span) => [span.name, span]));
  const showVideo = hasVideo(candidate);

  const rows = phases
    .map((phase, i) => {
      const c = candSummary[phase];
      const r = refSummary?.[phase];
      const failed = failingPhases.has(phase);
      const tainted = firstFail >= 0 && i > firstFail && !failed;
      const status = failed
        ? '<span class="chip chip-fail">✕ failed</span>'
        : tainted
          ? '<span class="chip chip-tainted">⚠ after first failure</span>'
          : '<span class="chip chip-ok">✓</span>';
      const cell = (cv: number, rv: number | undefined, digits: number) =>
        r !== undefined && rv !== undefined
          ? `${fmt(cv, digits)} <span class="ref-val">(ref ${fmt(rv, digits)})</span>`
          : fmt(cv, digits);
      const videoCell = showVideo
        ? `<td>${esc(spans.has(phase) ? phaseVideoWindow(candidate, spans.get(phase)!) : '')}</td>`
        : '';
      return `<tr${failed ? ' class="row-fail"' : ''}>
        <td>${esc(phase)}</td><td>${status}</td>${videoCell}
        <td class="num">${c.frames}</td>
        <td class="num">${cell(c.pathLength, r?.pathLength, 2)}</td>
        <td class="num">${cell(c.netDisplacement, r?.netDisplacement, 2)}</td>
        <td class="num">${cell(c.maxFrameDelta, r?.maxFrameDelta, 3)}</td>
        <td class="num">${cell(c.meanCorrErr, r?.meanCorrErr, 4)}</td>
        <td class="num">${cell(c.meanOffset, r?.meanOffset, 4)}</td>
      </tr>`;
    })
    .join('');

  return `<table>
    <thead><tr><th>phase</th><th>status</th>${showVideo ? '<th>video window</th>' : ''}<th class="num">frames</th><th class="num">path len</th><th class="num">net disp</th><th class="num">max Δ/frame</th><th class="num">mean corr err</th><th class="num">mean offset</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ---------------------------------------------------------------------------
// Whole document

export function generateReport(candidate: RunData, opts: ReportOptions = {}): string {
  const { reference, structuralIssues = [], comparison, invariantFailures = [] } = opts;
  const candSummary = summarizeByPhase(candidate.frames);
  const refSummary = reference ? summarizeByPhase(reference.frames) : undefined;

  const failingPhases = new Set<string>([
    ...(comparison ?? []).map((f) => f.phase),
    ...invariantFailures.map((f) => f.phase),
    ...structuralIssues.map((s) => s.split('@')[0]),
  ]);

  const frames = candidate.frames;
  const durationS = frames.length >= 2 ? (frames[frames.length - 1].t - frames[0].t) / 1000 : 0;
  const fps = durationS > 0 ? frames.length / durationS : 0;

  const failed = failingPhases.size > 0;
  const verdict = failed
    ? '<span class="chip chip-fail">✕ FAIL</span>'
    : comparison === undefined
      ? '<span class="chip chip-none">— no baseline compared</span>'
      : '<span class="chip chip-ok">✓ PASS</span>';

  const issuesBlock = structuralIssues.length > 0
    ? `<section><h2>Structural issues</h2><ul class="issues">${structuralIssues.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></section>`
    : '';
  const videoBlock = candidate.meta.video?.file
    ? `<section><h2>Video</h2><video src="${esc(candidate.meta.video.file)}" controls preload="metadata"></video></section>`
    : '';
  const showVideo = hasVideo(candidate);
  const comparisonBlock = (comparison ?? []).length > 0
    ? `<section><h2>Baseline drift</h2><table><thead><tr><th>phase</th>${showVideo ? '<th>video</th>' : ''}<th>metric</th><th class="num">baseline</th><th class="num">this run</th><th class="num">allowed ≤</th></tr></thead><tbody>${comparison!
        .map((f) => {
          const frame = firstFrameInPhase(candidate, f.phase);
          const videoCell = showVideo ? `<td>${frame ? esc(formatVideoAt(candidate, frame.t)) : ''}</td>` : '';
          return `<tr class="row-fail"><td>${esc(f.phase)}</td>${videoCell}<td>${esc(f.metric)}</td><td class="num">${fmt(f.baseline, 4)}</td><td class="num">${fmt(f.candidate, 4)}</td><td class="num">${fmt(f.allowed, 4)}</td></tr>`;
        })
        .join('')}</tbody></table></section>`
    : '';

  const invariantBlock = invariantFailures.length > 0
    ? `<section><h2>Invariant failures</h2><table><thead><tr><th>phase</th><th>metric</th><th>detail</th><th class="num">expected</th><th class="num">actual</th><th class="num">allowed</th></tr></thead><tbody>${invariantFailures
        .map((f) => `<tr class="row-fail"><td>${esc(f.phase)}</td><td>${esc(f.metric)}</td><td>${esc(f.detail)}</td><td class="num">${fmt(f.expected, 4)}</td><td class="num">${fmt(f.actual, 4)}</td><td class="num">${fmt(f.allowed, 4)}</td></tr>`)
        .join('')}</tbody></table></section>`
    : '';
  const charts = [
    timeSeriesChart({ title: 'Local correction error (server disagreement with prediction)', value: (f) => f.localCorrectionError, digits: 4 }, candidate, reference),
    timeSeriesChart({ title: 'Visual offset length (render smoothing distance)', value: (f) => f.offsetLength, digits: 4 }, candidate, reference),
  ].join('');

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA run — ${esc(candidate.meta.characterClass)} · ${esc(candidate.meta.label)}</title>
<style>
  :root {
    --surface-1: #fcfcfb; --page: #f9f9f7;
    --ink-1: #0b0b0b; --ink-2: #52514e; --ink-muted: #898781;
    --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6; --series-2: #1baf7a;
    --status-good: #0ca30c; --status-critical: #d03b3b;
    --band: rgba(11,11,11,0.035);
    --ramp-0:#86b6ef; --ramp-1:#6da7ec; --ramp-2:#5598e7; --ramp-3:#3987e5; --ramp-4:#2a78d6;
    --ramp-5:#256abf; --ramp-6:#1c5cab; --ramp-7:#184f95; --ramp-8:#104281;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface-1: #1a1a19; --page: #0d0d0d;
      --ink-1: #ffffff; --ink-2: #c3c2b7; --ink-muted: #898781;
      --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
      --series-1: #3987e5; --series-2: #199e70;
      --band: rgba(255,255,255,0.045);
      --ramp-0:#104281; --ramp-1:#184f95; --ramp-2:#1c5cab; --ramp-3:#256abf; --ramp-4:#2a78d6;
      --ramp-5:#3987e5; --ramp-6:#5598e7; --ramp-7:#6da7ec; --ramp-8:#86b6ef;
    }
  }
  body { background: var(--page); color: var(--ink-1); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px; }
  main { max-width: 960px; margin: 0 auto; display: grid; gap: 20px; }
  section, figure { background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin: 0; }
  h1 { font-size: 18px; margin: 0; } h2 { font-size: 14px; margin: 0 0 10px; color: var(--ink-2); }
  header .meta { color: var(--ink-2); margin-top: 4px; }
  figcaption { color: var(--ink-2); margin-bottom: 8px; }
  svg { width: 100%; height: auto; display: block; }
  video { width: 100%; max-height: 70vh; display: block; background: #000; border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; overflow-x: auto; display: block; }
  th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
  th { color: var(--ink-muted); font-weight: 500; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .ref-val { color: var(--ink-muted); }
  .grid { stroke: var(--grid); stroke-width: 1; } .axis { stroke: var(--axis); stroke-width: 1; }
  .tick, .band-label { fill: var(--ink-muted); font-size: 9px; }
  .band { fill: var(--band); }
  .series { fill: none; stroke-width: 2; stroke-linejoin: round; }
  .series-cand { stroke: var(--series-1); }
  .series-ref { stroke: var(--series-2); stroke-dasharray: 5 4; }
  .event-tick { stroke: var(--ink-muted); stroke-width: 1; opacity: .55; }
  .event-tick.press { stroke-width: 1.5; opacity: .9; }
  .phase-dot { fill: var(--ink-2); }
  .legend { display: flex; gap: 16px; color: var(--ink-2); margin-bottom: 8px; }
  .swatch { display: inline-block; width: 14px; height: 3px; vertical-align: middle; margin-right: 6px; border-radius: 2px; }
  .chip { border-radius: 10px; padding: 1px 8px; font-size: 12px; white-space: nowrap; }
  .chip-ok { color: var(--status-good); border: 1px solid var(--status-good); }
  .chip-fail { color: var(--status-critical); border: 1px solid var(--status-critical); }
  .chip-tainted, .chip-none { color: var(--ink-muted); border: 1px solid var(--axis); }
  .row-fail td { background: color-mix(in srgb, var(--status-critical) 6%, transparent); }
  .issues li { color: var(--ink-2); }
</style>
<main>
  <header>
    <h1>QA run — ${esc(candidate.meta.characterClass)} · ${esc(candidate.meta.label)} ${verdict}</h1>
    <div class="meta">${esc(candidate.meta.startedAt)} · ${frames.length} frames · ${durationS.toFixed(1)}s · ${fps.toFixed(0)} fps avg${reference ? ` · compared against ${esc(reference.meta.label)} (${esc(reference.meta.startedAt)})` : ''}</div>
  </header>
  ${videoBlock}
  ${issuesBlock}
  ${invariantBlock}
  ${comparisonBlock}
  <section><h2>Per-phase summary${refSummary ? ' — reference values in gray' : ''}</h2>${summaryTable(candidate, candSummary, refSummary, failingPhases)}</section>
  ${charts}
  ${channelsSection(candidate, reference)}
  ${perfReportSection(candidate)}
  ${pathPlot(candidate)}
</main>
`;
}

export function writeReport(outPath: string, candidate: RunData, opts: ReportOptions = {}): string {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `<!doctype html>\n<html lang="en">\n${generateReport(candidate, opts)}</html>\n`);
  return outPath;
}

// ---------------------------------------------------------------------------
// CLI: npm run qa:report -- <run.(ndjson|json)> [--against <run>] [--out <file>]

export function runReportCli() {
  // vite-node strips its own binary, the script path, and `--` from argv,
  // so everything after slice(2) is user arguments.
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const readFlag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const against = readFlag('--against');
  const out = readFlag('--out');
  const input = args[0];
  if (!input) {
    console.error('usage: npm run qa:report -- <run.(ndjson|json)> [--against <run>] [--out <file>.html]');
    process.exit(2);
  }

  const candidate = readRun(path.resolve(input));
  const reference = against ? readRun(path.resolve(against)) : undefined;
  const outPath = out
    ? path.resolve(out)
    : path.resolve(input).replace(/\.(ndjson|json)$/, '') + '.html';
  writeReport(outPath, candidate, { reference });
  console.log(`[report] wrote ${outPath}`);
}

