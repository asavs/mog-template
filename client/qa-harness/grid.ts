import fs from 'node:fs';
import path from 'node:path';
import type { CharacterClass, RunData } from './trace-types';
import { summarizeByPhase, type PhaseSummary, type TraceSummary } from './trace-stats';

export const DEFAULT_GRID_LATENCIES_MS = [0, 60, 150, 300];

export type GridRunSummary = {
  latencyMs: number;
  characterClass: CharacterClass;
  summary: TraceSummary;
};

export type GridMetricRow = {
  latencyMs: number;
  characterClass: CharacterClass;
  phase: string;
  netDisplacement: number;
  maxFrameDelta: number;
  meanCorrErr: number;
  meanOffset: number;
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmt = (v: number, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits) : 'n/a');

export function parseGridLatencies(spec = process.env.QA_GRID_LATENCIES): number[] {
  if (!spec || spec.trim() === '') return DEFAULT_GRID_LATENCIES_MS;

  const values = spec
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const parsed = Number(part);
      if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        throw new Error(`QA_GRID_LATENCIES must be a comma-separated list of non-negative integer milliseconds; got ${JSON.stringify(part)}`);
      }
      return parsed;
    });

  if (values.length === 0) {
    throw new Error('QA_GRID_LATENCIES did not contain any latency values');
  }

  return values;
}

/**
 * QA_GRID_BURST spec: `<delayMs>x<durationMs>@<periodMs>`, e.g. `300x500@3000`
 * = spike to 300ms for 500ms at the start of every 3s window, riding on each
 * grid cell's base latency. Steady latency did not reproduce #216; the burst
 * is the transition experiment.
 */
export function parseBurstSpec(
  spec = process.env.QA_GRID_BURST,
): { periodMs: number; durationMs: number; delayMs: number } | undefined {
  if (!spec || spec.trim() === '') return undefined;

  const match = /^(\d+)x(\d+)@(\d+)$/.exec(spec.trim());
  if (!match) {
    throw new Error(`QA_GRID_BURST must look like <delayMs>x<durationMs>@<periodMs> (e.g. 300x500@3000); got ${JSON.stringify(spec)}`);
  }
  const [delayMs, durationMs, periodMs] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (periodMs === 0) {
    throw new Error('QA_GRID_BURST period must be positive');
  }
  if (durationMs > periodMs) {
    throw new Error(`QA_GRID_BURST duration (${durationMs}ms) cannot exceed its period (${periodMs}ms)`);
  }
  return { periodMs, durationMs, delayMs };
}

export function gridRunLabel(latencyMs: number, burst?: { delayMs: number; durationMs: number; periodMs: number }) {
  return burst
    ? `grid-l${latencyMs}-b${burst.delayMs}x${burst.durationMs}@${burst.periodMs}`
    : `grid-l${latencyMs}`;
}

export function gridJitterMs(latencyMs: number) {
  return Math.round(latencyMs * 0.1);
}

export function summarizeGridRun(
  latencyMs: number,
  run: RunData,
  phases?: readonly string[],
): GridRunSummary {
  const summary = summarizeByPhase(run.frames);
  if (phases) {
    const wanted = new Set(phases);
    for (const phase of Object.keys(summary)) {
      if (!wanted.has(phase)) delete summary[phase];
    }
  }

  return {
    latencyMs,
    characterClass: run.meta.characterClass as CharacterClass,
    summary,
  };
}

export function aggregateGridSummaries(cells: readonly GridRunSummary[]): GridMetricRow[] {
  const rows: GridMetricRow[] = [];

  for (const cell of cells) {
    for (const phase of Object.keys(cell.summary)) {
      const summary: PhaseSummary = cell.summary[phase];
      rows.push({
        latencyMs: cell.latencyMs,
        characterClass: cell.characterClass,
        phase,
        netDisplacement: summary.netDisplacement,
        maxFrameDelta: summary.maxFrameDelta,
        meanCorrErr: summary.meanCorrErr,
        meanOffset: summary.meanOffset,
      });
    }
  }

  return rows.sort((a, b) =>
    a.characterClass.localeCompare(b.characterClass) ||
    a.phase.localeCompare(b.phase) ||
    a.latencyMs - b.latencyMs,
  );
}

export function logGridSummary(rows: readonly GridMetricRow[]) {
  console.table(rows.map((row) => ({
    class: row.characterClass,
    phase: row.phase,
    latencyMs: row.latencyMs,
    netDisplacement: Number(row.netDisplacement.toFixed(3)),
    maxFrameDelta: Number(row.maxFrameDelta.toFixed(4)),
    meanCorrErr: Number(row.meanCorrErr.toFixed(4)),
    meanOffset: Number(row.meanOffset.toFixed(4)),
  })));
}

export function generateGridReport(rows: readonly GridMetricRow[], opts: { label: string; generatedAt?: string }) {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const tableRows = rows
    .map((row) => `<tr>
      <td>${esc(row.characterClass)}</td>
      <td>${esc(row.phase)}</td>
      <td class="num">${row.latencyMs}</td>
      <td class="num">${fmt(row.netDisplacement, 3)}</td>
      <td class="num">${fmt(row.maxFrameDelta, 4)}</td>
      <td class="num">${fmt(row.meanCorrErr, 4)}</td>
      <td class="num">${fmt(row.meanOffset, 4)}</td>
    </tr>`)
    .join('');

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QA latency grid - ${esc(opts.label)}</title>
<style>
  :root { --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --muted:#66635f; --grid:#e1e0d9; --border:rgba(11,11,11,.10); }
  @media (prefers-color-scheme: dark) { :root { --page:#0d0d0d; --surface:#1a1a19; --ink:#fff; --muted:#c3c2b7; --grid:#2c2c2a; --border:rgba(255,255,255,.10); } }
  body { background:var(--page); color:var(--ink); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; margin:0; padding:24px; }
  main { max-width:1040px; margin:0 auto; display:grid; gap:16px; }
  section { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:16px; }
  h1 { font-size:18px; margin:0; } .meta { color:var(--muted); margin-top:4px; }
  table { border-collapse:collapse; width:100%; overflow-x:auto; display:block; }
  th, td { text-align:left; padding:5px 10px; border-bottom:1px solid var(--grid); white-space:nowrap; }
  th { color:var(--muted); font-weight:500; } .num { text-align:right; font-variant-numeric:tabular-nums; }
</style>
<main>
  <header>
    <h1>QA latency grid - ${esc(opts.label)}</h1>
    <div class="meta">${esc(generatedAt)} - ${rows.length} phase/class/latency rows</div>
  </header>
  <section>
    <table>
      <thead><tr><th>class</th><th>phase</th><th class="num">latency ms</th><th class="num">net disp</th><th class="num">max delta/frame</th><th class="num">mean corr err</th><th class="num">mean offset</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </section>
</main>`;
}

export function writeGridReport(outPath: string, rows: readonly GridMetricRow[], opts: { label: string }) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `<!doctype html>\n<html lang="en">\n${generateGridReport(rows, opts)}</html>\n`);
  return outPath;
}