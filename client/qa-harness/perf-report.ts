/**
 * Rendering of the perf capture: a compact per-phase console table (printed at
 * the end of every run) and an HTML section folded into the run report. Both
 * are purely descriptive — worst frame delta, long-task count/total, dt
 * percentiles, heap growth, and (for load phases) the slowest resources.
 *
 * Uses the same CSS classes as report.ts so the HTML section inherits the
 * report's styling without duplicating it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunData } from './trace-types';
import { frameDeltas, resourceOffenders, summarizePerfByPhase, type PerfPhaseSummary } from './perf-stats';
import { evaluatePerfBudgets, type PerfBudgetCheck, type PerfBudgetFile } from './perf-budgets';
import { firstFrameInPhase, formatVideoAt, hasVideo } from './video-time';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const n = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const mb = (v: number | null, d = 1) => (v === null ? '—' : v.toFixed(d));
const opt = (v: number | null, d = 3) => (v === null ? '-' : n(v, d));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUDGET_PATH = path.join(__dirname, 'perf-budgets.json');

function readBudgets(): PerfBudgetFile | null {
  try {
    return JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf8')) as PerfBudgetFile;
  } catch {
    return null;
  }
}

/** Shorten a resource URL to its last path segment (+ query stripped). */
function shortName(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split('/').filter(Boolean).pop() ?? u.pathname;
    return base || u.host;
  } catch {
    return url;
  }
}

type WorstFrameGap = { t: number; dt: number };

function worstFrameGapsByPhase(run: RunData): Map<string, WorstFrameGap> {
  const out = new Map<string, WorstFrameGap>();
  for (const delta of frameDeltas(run.frames)) {
    const prev = out.get(delta.phase);
    if (!prev || delta.dt > prev.dt) out.set(delta.phase, { t: delta.t, dt: delta.dt });
  }
  return out;
}

function budgetPhaseName(check: PerfBudgetCheck, run: RunData): string | null {
  if (check.metric === 'timeToPlayableMs') return run.frames[0]?.phase ?? 'startup';
  const parts = check.name.split('.');
  return parts.length >= 3 ? parts[1] : null;
}

function budgetVideoTime(run: RunData, check: PerfBudgetCheck): string {
  const phase = budgetPhaseName(check, run);
  if (!phase) return '';
  const frame = check.metric === 'worstFrameDeltaMs'
    ? worstFrameGapsByPhase(run).get(phase)
    : firstFrameInPhase(run, phase);
  return frame ? formatVideoAt(run, frame.t) : '';
}

// ---------------------------------------------------------------------------
// Console summary

/** Pads/truncates to a fixed width for a monospaced console table. */
function col(s: string, width: number): string {
  const t = s.length > width ? s.slice(0, width - 1) + '…' : s;
  return t.padEnd(width);
}

export function logPerfSummary(run: RunData): void {
  const label = `${run.meta.characterClass} · ${run.meta.label}`;
  const rows = summarizePerfByPhase(run);
  console.log(`\n[perf] ${label} - per-phase`);
  console.log(
    '  ' +
      col('phase', 22) +
      col('frames', 8) +
      col('worstΔ', 9) +
      col('p50', 7) +
      col('p95', 7) +
      col('p99', 7) +
      col('slowFr', 8) +
      col('LT#', 5) +
      col('LTms', 8) +
      col('flicker', 9) +
      col('maxJump', 9) +
      col('heapΔMB', 9),
  );
  for (const r of rows) {
    console.log(
      '  ' +
        col(r.phase, 22) +
        col(String(r.frames), 8) +
        col(n(r.worstFrameDeltaMs), 9) +
        col(n(r.p50FrameDeltaMs), 7) +
        col(n(r.p95FrameDeltaMs), 7) +
        col(n(r.p99FrameDeltaMs), 7) +
        col(String(r.slowFrameCount), 8) +
        col(String(r.longTaskCount), 5) +
        col(n(r.longTaskTotalMs), 8) +
        col(opt(r.flickerIndex), 9) +
        col(opt(r.maxRemoteJumpUnits), 9) +
        col(r.heapGrowthMB === null ? '—' : mb(r.heapGrowthMB), 9),
    );
  }

  if (run.perf?.landmarks) {
    const l = run.perf.landmarks;
    console.log(
      `  load landmarks: join-screen ${n(l.timeToJoinScreenMs, 0)}ms · playable ${n(l.timeToPlayableMs, 0)}ms · first-frames ${n(l.timeToFirstFramesMs, 0)}ms · total ${n(l.totalMs, 0)}ms`,
    );
    const { byDuration } = resourceOffenders(run.perf, 5);
    console.log('  slowest resources (by duration):');
    for (const res of byDuration) {
      console.log(`    ${col(shortName(res.name), 34)} ${n(res.duration, 0)}ms  ${(res.transferSize / 1024).toFixed(0)}KB`);
    }
  }

  // Highlight first-vs-second casts when both windows exist (the headline
  // number for the first-cast scenario).
  logCastDeltas(rows);
}

function logCastDeltas(rows: PerfPhaseSummary[]): void {
  const by = new Map(rows.map((r) => [r.phase, r]));
  for (const [first, second, label] of [
    ['fireball_1', 'fireball_2', 'fireball'],
    ['lightning_1', 'lightning_2', 'lightning'],
  ] as const) {
    const a = by.get(first);
    const b = by.get(second);
    if (!a || !b) continue;
    console.log(
      `  first-vs-second ${label}: worstΔ ${n(a.worstFrameDeltaMs)}ms → ${n(b.worstFrameDeltaMs)}ms (Δ ${n(a.worstFrameDeltaMs - b.worstFrameDeltaMs)}ms) · LTms ${n(a.longTaskTotalMs)} → ${n(b.longTaskTotalMs)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// HTML section (appended to the run report)

function phaseTable(run: RunData, rows: PerfPhaseSummary[]): string {
  const showVideo = hasVideo(run);
  const worstByPhase = worstFrameGapsByPhase(run);
  const body = rows
    .map((r) => {
      const worst = worstByPhase.get(r.phase);
      const videoCell = showVideo ? `<td>${worst ? esc(formatVideoAt(run, worst.t)) : ''}</td>` : '';
      return `<tr>
      <td>${esc(r.phase)}</td>${videoCell}
      <td class="num">${r.frames}</td>
      <td class="num">${n(r.worstFrameDeltaMs)}</td>
      <td class="num">${n(r.p50FrameDeltaMs)}</td>
      <td class="num">${n(r.p95FrameDeltaMs)}</td>
      <td class="num">${n(r.p99FrameDeltaMs)}</td>
      <td class="num">${r.slowFrameCount}</td>
      <td class="num">${r.longTaskCount}</td>
      <td class="num">${n(r.longTaskTotalMs)}</td>
      <td class="num">${n(r.worstLongTaskMs)}</td>
      <td class="num">${opt(r.flickerIndex)}</td>
      <td class="num">${opt(r.maxRemoteJumpUnits)}</td>
      <td class="num">${mb(r.heapStartMB)}</td>
      <td class="num">${mb(r.heapEndMB)}</td>
      <td class="num">${r.heapGrowthMB === null ? '—' : (r.heapGrowthMB >= 0 ? '+' : '') + mb(r.heapGrowthMB)}</td>
    </tr>`;
    })
    .join('');
  return `<table>
    <thead><tr>
      <th>phase</th>${showVideo ? '<th>worst gap at</th>' : ''}<th class="num">frames</th>
      <th class="num">worst Δ (ms)</th><th class="num">p50</th><th class="num">p95</th><th class="num">p99</th>
      <th class="num">slow fr</th><th class="num">LT #</th><th class="num">LT total ms</th><th class="num">worst LT</th>
      <th class="num">flicker index</th><th class="num">max remote jump</th>
      <th class="num">heap0 MB</th><th class="num">heap1 MB</th><th class="num">heap Δ</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}


function budgetTable(run: RunData): string {
  const budgets = readBudgets();
  if (!budgets) return '';
  const checks = evaluatePerfBudgets(run, budgets);
  if (checks.length === 0) return '';
  const showVideo = hasVideo(run);
  const rows = checks
    .map((check) => {
      const cls = check.status === 'FAIL' ? ' class="row-fail"' : '';
      const actual = check.actual === undefined ? '-' : n(check.actual, check.metric === 'flickerIndex' || check.metric === 'maxRemoteJumpUnits' ? 3 : 1);
      const budget = check.budget === undefined ? '-' : String(check.budget);
      const phase = budgetPhaseName(check, run);
      const traceFile = phase ? run.meta.chromeTraces?.[phase] : undefined;
      const op = check.status === 'SKIP' ? check.reason ?? 'skipped' : check.status === 'PASS' ? '<=' : '>';
      const traceLink = check.status === 'FAIL' && traceFile
        ? ` <a href="${esc(traceFile)}">Chrome trace</a>`
        : '';
      const detail = `${op}${traceLink}`;
      const videoCell = showVideo ? `<td>${esc(budgetVideoTime(run, check))}</td>` : '';
      return `<tr${cls}><td>${esc(check.status)}</td><td>${esc(check.name)}</td>${videoCell}<td class="num">${actual}</td><td class="num">${budget}</td><td>${detail}</td></tr>`;
    })
    .join('');
  return `<section>
    <h2>Performance budgets</h2>
    <table><thead><tr><th>status</th><th>check</th>${showVideo ? '<th>video</th>' : ''}<th class="num">actual</th><th class="num">budget</th><th>detail</th></tr></thead><tbody>${rows}</tbody></table>
  </section>`;
}

function longTaskList(run: RunData): string {
  const tasks = [...(run.perf?.longTasks ?? [])].sort((a, b) => b.duration - a.duration).slice(0, 20);
  if (tasks.length === 0) return '<p class="issues">No long tasks (&gt;50ms) observed.</p>';
  const rows = tasks
    .map(
      (t) => `<tr>
      <td class="num">${n(t.duration)}</td>
      <td>${esc(t.phase)}</td>
      <td class="num">${n(t.startTime, 0)}</td>
      <td>${esc(t.attribution.join(', ') || '(none)')}</td>
    </tr>`,
    )
    .join('');
  return `<table>
    <thead><tr><th class="num">duration ms</th><th>phase</th><th class="num">startTime ms</th><th>attribution</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function resourceTable(run: RunData): string {
  if (!run.perf || run.perf.resources.length === 0) return '';
  const { byDuration, bySize } = resourceOffenders(run.perf, 10);
  const rowsOf = (rs: typeof byDuration) =>
    rs
      .map(
        (r) => `<tr>
        <td title="${esc(r.name)}">${esc(shortName(r.name))}</td>
        <td>${esc(r.initiatorType)}</td>
        <td class="num">${n(r.duration, 0)}</td>
        <td class="num">${(r.transferSize / 1024).toFixed(0)}</td>
        <td class="num">${n(r.startTime, 0)}</td>
      </tr>`,
      )
      .join('');
  const head = '<thead><tr><th>resource</th><th>type</th><th class="num">duration ms</th><th class="num">transfer KB</th><th class="num">startTime ms</th></tr></thead>';
  return `<div>
    <h2>Top resources by duration</h2>
    <table>${head}<tbody>${rowsOf(byDuration)}</tbody></table>
    <h2 style="margin-top:14px">Top resources by transfer size</h2>
    <table>${head}<tbody>${rowsOf(bySize)}</tbody></table>
  </div>`;
}

function landmarksBlock(run: RunData): string {
  const l = run.perf?.landmarks;
  if (!l) return '';
  return `<section>
    <h2>Cold-load landmarks (harness clock)</h2>
    <table>
      <tbody>
        <tr><td>goto → join screen</td><td class="num">${n(l.timeToJoinScreenMs, 0)} ms</td></tr>
        <tr><td>join click → playable (__playerDebug)</td><td class="num">${n(l.timeToPlayableMs, 0)} ms</td></tr>
        <tr><td>join click → first frames rendering</td><td class="num">${n(l.timeToFirstFramesMs, 0)} ms</td></tr>
        <tr><td>goto → first frames (end-to-end)</td><td class="num">${n(l.totalMs, 0)} ms</td></tr>
      </tbody>
    </table>
  </section>`;
}

/** The full perf section for a run's HTML report. Empty string if no perf. */
export function perfReportSection(run: RunData): string {
  if (!run.perf) return '';
  const rows = summarizePerfByPhase(run);
  return `
  ${landmarksBlock(run)}
  <section>
    <h2>Performance - per phase</h2>
    ${phaseTable(run, rows)}
  </section>
  ${budgetTable(run)}
  <section>
    <h2>Long tasks (main-thread stalls &gt;50ms, top 20 by duration)</h2>
    ${longTaskList(run)}
  </section>
  ${run.perf.resources.length > 0 ? `<section>${resourceTable(run)}</section>` : ''}`;
}
