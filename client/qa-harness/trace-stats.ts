/**
 * Reduces a raw per-frame QA harness trace (hundreds of frames per phase) down
 * to one summary record per phase. This is what gets checked in as a baseline
 * — never the raw trace, which is noisy and huge (see README).
 */
import type { TraceRecord, Vec3 } from './trace-types';

export type ChannelSummary = {
  min: number;
  max: number;
  mean: number;
  first: number;
  last: number;
};

export type PhaseSummary = {
  phase: string;
  frames: number;
  pathLength: number;
  netDisplacement: number;
  maxFrameDelta: number;
  meanCorrErr: number;
  stddevCorrErr: number;
  meanOffset: number;
  stddevOffset: number;
  /**
   * Per-channel stats for whatever game-state channels the client published
   * during this phase (keys are client-defined; see useQaGameDebug.ts).
   * Informational for now — compare-baseline.ts does not gate on these.
   */
  channels?: Record<string, ChannelSummary>;
};

export type TraceSummary = Record<string, PhaseSummary>;

function dist(a: Vec3 | null, b: Vec3 | null): number | null {
  if (!a || !b) return null;
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function meanAndStddev(values: number[]): { mean: number; stddev: number } {
  if (values.length === 0) return { mean: 0, stddev: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length === 1) return { mean, stddev: 0 };
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return { mean, stddev: Math.sqrt(variance) };
}

function summarizePhase(phase: string, records: TraceRecord[]): PhaseSummary {
  const positioned = records.filter((r) => r.simPosition !== null);

  let pathLength = 0;
  let maxFrameDelta = 0;
  for (let i = 1; i < positioned.length; i++) {
    const d = dist(positioned[i - 1].simPosition, positioned[i].simPosition) ?? 0;
    pathLength += d;
    maxFrameDelta = Math.max(maxFrameDelta, d);
  }

  const netDisplacement = positioned.length >= 2
    ? dist(positioned[0].simPosition, positioned[positioned.length - 1].simPosition) ?? 0
    : 0;

  const corrErrs = records.map((r) => r.localCorrectionError).filter((v): v is number => typeof v === 'number');
  const offsets = records.map((r) => r.offsetLength).filter((v): v is number => typeof v === 'number');
  const corr = meanAndStddev(corrErrs);
  const off = meanAndStddev(offsets);

  const byChannel = new Map<string, number[]>();
  for (const r of records) {
    if (!r.channels) continue;
    for (const [key, value] of Object.entries(r.channels)) {
      if (!byChannel.has(key)) byChannel.set(key, []);
      byChannel.get(key)!.push(value);
    }
  }
  let channels: Record<string, ChannelSummary> | undefined;
  if (byChannel.size > 0) {
    channels = {};
    for (const [key, values] of byChannel) {
      channels[key] = {
        min: Math.min(...values),
        max: Math.max(...values),
        mean: meanAndStddev(values).mean,
        first: values[0],
        last: values[values.length - 1],
      };
    }
  }

  return {
    ...(channels ? { channels } : {}),
    phase,
    frames: records.length,
    pathLength,
    netDisplacement,
    maxFrameDelta,
    meanCorrErr: corr.mean,
    stddevCorrErr: corr.stddev,
    meanOffset: off.mean,
    stddevOffset: off.stddev,
  };
}

export function summarizeByPhase(records: TraceRecord[]): TraceSummary {
  const byPhase = new Map<string, TraceRecord[]>();
  for (const r of records) {
    if (!byPhase.has(r.phase)) byPhase.set(r.phase, []);
    byPhase.get(r.phase)!.push(r);
  }

  const summary: TraceSummary = {};
  for (const [phase, phaseRecords] of byPhase) {
    summary[phase] = summarizePhase(phase, phaseRecords);
  }
  return summary;
}

/**
 * Absolute data-integrity checks that don't depend on a baseline at all —
 * these catch crashes/NaNs regardless of how noisy normal gameplay is.
 * Capped at 20 entries so a badly broken run doesn't flood the log.
 */
export function checkStructuralIntegrity(records: TraceRecord[]): string[] {
  const issues: string[] = [];
  for (const r of records) {
    if (issues.length >= 20) break;

    if (r.phase !== 'startup') {
      if (!r.simPosition) issues.push(`${r.phase}@${r.t.toFixed(0)}ms: simPosition is null after startup`);
      if (!r.renderPosition) issues.push(`${r.phase}@${r.t.toFixed(0)}ms: renderPosition is null after startup`);
    }

    const numericFields: Array<[string, number | null | undefined]> = [
      ['simPosition.x', r.simPosition?.x], ['simPosition.y', r.simPosition?.y], ['simPosition.z', r.simPosition?.z],
      ['localCorrectionError', r.localCorrectionError], ['offsetLength', r.offsetLength],
    ];
    for (const [field, value] of numericFields) {
      if (typeof value === 'number' && Number.isNaN(value)) {
        issues.push(`${r.phase}@${r.t.toFixed(0)}ms: NaN in ${field}`);
      }
    }
  }
  return issues;
}
