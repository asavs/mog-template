/**
 * Reduces the raw perf capture (frames + long tasks + memory samples +
 * resources) to per-phase summaries and resource-offender lists. Frame deltas
 * are derived here from the frame trace (each frame carries t + phase) rather
 * than from a second parallel per-frame stream.
 *
 * Purely descriptive � no thresholds, no pass/fail. See README perf section.
 */
import type { PerfData, ResourceEntry, RunData, TraceRecord } from './trace-types';

export type PerfPhaseSummary = {
  phase: string;
  frames: number;
  /** Largest single inter-frame gap in the phase, in ms. */
  worstFrameDeltaMs: number;
  p50FrameDeltaMs: number;
  p95FrameDeltaMs: number;
  p99FrameDeltaMs: number;
  /** Frames whose delta exceeded 50ms. */
  slowFrameCount: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  worstLongTaskMs: number;
  /** Remote-player displacement coefficient of variation while moving. null if channels absent/stationary. */
  flickerIndex: number | null;
  /** Largest one-frame remote-player X/Z displacement in world units. null if channels absent. */
  maxRemoteJumpUnits: number | null;
  /** Heap at first/last sample in the phase and their difference (MB). null if unsampled. */
  heapStartMB: number | null;
  heapEndMB: number | null;
  heapGrowthMB: number | null;
};

const BYTES_PER_MB = 1024 * 1024;

/** Frame-to-frame deltas (ms), each tagged with the phase of the later frame. */
export function frameDeltas(frames: TraceRecord[]): Array<{ dt: number; phase: string; t: number }> {
  const out: Array<{ dt: number; phase: string; t: number }> = [];
  for (let i = 1; i < frames.length; i += 1) {
    const dt = frames[i].t - frames[i - 1].t;
    if (dt <= 0) continue; // clock artifacts / duplicate timestamps
    out.push({ dt, phase: frames[i].phase, t: frames[i].t });
  }
  return out;
}

/** Nearest-rank percentile of an already-unsorted array; returns 0 for empty. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Phase order of first appearance, so summaries read in execution order. */
function phaseOrder(frames: TraceRecord[]): string[] {
  const seen: string[] = [];
  for (const f of frames) if (!seen.includes(f.phase)) seen.push(f.phase);
  return seen;
}

type RemoteFlicker = { flickerIndex: number | null; maxRemoteJumpUnits: number | null };

export function computeRemoteFlicker(frames: TraceRecord[], phase: string): RemoteFlicker {
  const phaseFrames = frames.filter((f) => f.phase === phase && f.channels);
  const displacements: number[] = [];
  let sawRemote = false;
  let maxRemoteJumpUnits = 0;

  for (let remote = 0; remote < 4; remote += 1) {
    const xKey = `remote${remote}_x`;
    const zKey = `remote${remote}_z`;
    let prev: { x: number; z: number } | null = null;

    for (const frame of phaseFrames) {
      const x = frame.channels?.[xKey];
      const z = frame.channels?.[zKey];
      if (typeof x !== 'number' || typeof z !== 'number') {
        prev = null;
        continue;
      }

      sawRemote = true;
      if (prev) {
        const d = Math.hypot(x - prev.x, z - prev.z);
        maxRemoteJumpUnits = Math.max(maxRemoteJumpUnits, d);
        if (d > 0.001) displacements.push(d);
      }
      prev = { x, z };
    }
  }

  if (!sawRemote) return { flickerIndex: null, maxRemoteJumpUnits: null };
  if (displacements.length === 0) return { flickerIndex: null, maxRemoteJumpUnits };

  const mean = displacements.reduce((a, b) => a + b, 0) / displacements.length;
  if (mean <= 0) return { flickerIndex: null, maxRemoteJumpUnits };
  const variance = displacements.reduce((sum, d) => sum + (d - mean) ** 2, 0) / displacements.length;
  return { flickerIndex: Math.sqrt(variance) / mean, maxRemoteJumpUnits };
}

export function summarizePerfByPhase(run: RunData): PerfPhaseSummary[] {
  const { frames, perf } = run;
  const deltas = frameDeltas(frames);
  const order = phaseOrder(frames);

  const longTasksByPhase = new Map<string, number[]>();
  for (const lt of perf?.longTasks ?? []) {
    if (!longTasksByPhase.has(lt.phase)) longTasksByPhase.set(lt.phase, []);
    longTasksByPhase.get(lt.phase)!.push(lt.duration);
  }

  const memByPhase = new Map<string, number[]>();
  for (const m of perf?.memorySamples ?? []) {
    if (!memByPhase.has(m.phase)) memByPhase.set(m.phase, []);
    memByPhase.get(m.phase)!.push(m.usedJSHeapSize);
  }

  return order.map((phase) => {
    const phaseDeltas = deltas.filter((d) => d.phase === phase).map((d) => d.dt);
    const lts = longTasksByPhase.get(phase) ?? [];
    const heap = memByPhase.get(phase) ?? [];
    const heapStart = heap.length > 0 ? heap[0] / BYTES_PER_MB : null;
    const heapEnd = heap.length > 0 ? heap[heap.length - 1] / BYTES_PER_MB : null;
    const remoteFlicker = computeRemoteFlicker(frames, phase);

    return {
      phase,
      frames: frames.filter((f) => f.phase === phase).length,
      worstFrameDeltaMs: phaseDeltas.length > 0 ? Math.max(...phaseDeltas) : 0,
      p50FrameDeltaMs: percentile(phaseDeltas, 50),
      p95FrameDeltaMs: percentile(phaseDeltas, 95),
      p99FrameDeltaMs: percentile(phaseDeltas, 99),
      slowFrameCount: phaseDeltas.filter((dt) => dt > 50).length,
      longTaskCount: lts.length,
      longTaskTotalMs: lts.reduce((a, b) => a + b, 0),
      worstLongTaskMs: lts.length > 0 ? Math.max(...lts) : 0,
      flickerIndex: remoteFlicker.flickerIndex,
      maxRemoteJumpUnits: remoteFlicker.maxRemoteJumpUnits,
      heapStartMB: heapStart,
      heapEndMB: heapEnd,
      heapGrowthMB: heapStart !== null && heapEnd !== null ? heapEnd - heapStart : null,
    };
  });
}

export type WsPhaseRate = {
  phase: string;
  durationMs: number;
  inCount: number;
  outCount: number;
  inBytes: number;
  outBytes: number;
  /** Inbound frames/sec — on an AFK observer this is the transform-receive churn (#5). */
  inHz: number;
  /** Outbound frames/sec — on a mover this is the input send rate (#6). */
  outHz: number;
  inBytesPerSec: number;
  outBytesPerSec: number;
};

/** Per-phase wall-clock spans (performance.now ms) from the frame trace. */
function phaseSpans(frames: TraceRecord[]): Map<string, { start: number; end: number }> {
  const spans = new Map<string, { start: number; end: number }>();
  for (const f of frames) {
    const s = spans.get(f.phase);
    if (!s) spans.set(f.phase, { start: f.t, end: f.t });
    else {
      if (f.t < s.start) s.start = f.t;
      if (f.t > s.end) s.end = f.t;
    }
  }
  return spans;
}

/**
 * Per-phase SpacetimeDB WebSocket rates from the WS meter (perf-collectors.ts).
 * Phase duration is the phase's wall-clock span from the frame trace; if a phase
 * has <2 frames the ws timestamps are used as a fallback so a rate still reports.
 * This is the #21 measurement surface — the same run yields an AFK observer's
 * inbound churn (inHz) and a mover's input send rate (outHz); the acceptance
 * signal is the delta between an idle phase and a moving phase.
 */
export function summarizeWsByPhase(run: RunData): WsPhaseRate[] {
  const { frames, perf } = run;
  const msgs = perf?.wsMessages ?? [];
  const spans = phaseSpans(frames);
  const order = phaseOrder(frames);
  // Include ws-only phases (no frames) at the end, preserving first-seen order.
  for (const m of msgs) if (!order.includes(m.phase)) order.push(m.phase);

  return order.map((phase) => {
    const inMsgs = msgs.filter((m) => m.phase === phase && m.dir === 'in');
    const outMsgs = msgs.filter((m) => m.phase === phase && m.dir === 'out');
    const span = spans.get(phase);
    let durationMs = span ? span.end - span.start : 0;
    if (durationMs <= 0) {
      const ts = [...inMsgs, ...outMsgs].map((m) => m.t);
      durationMs = ts.length >= 2 ? Math.max(...ts) - Math.min(...ts) : 0;
    }
    const secs = durationMs > 0 ? durationMs / 1000 : 0;
    const inBytes = inMsgs.reduce((a, m) => a + m.bytes, 0);
    const outBytes = outMsgs.reduce((a, m) => a + m.bytes, 0);
    return {
      phase,
      durationMs,
      inCount: inMsgs.length,
      outCount: outMsgs.length,
      inBytes,
      outBytes,
      inHz: secs > 0 ? inMsgs.length / secs : 0,
      outHz: secs > 0 ? outMsgs.length / secs : 0,
      inBytesPerSec: secs > 0 ? inBytes / secs : 0,
      outBytesPerSec: secs > 0 ? outBytes / secs : 0,
    };
  });
}

export type ResourceOffenders = {
  byDuration: ResourceEntry[];
  bySize: ResourceEntry[];
};

/** Top-N resource-timing entries by duration and by transfer size. */
export function resourceOffenders(perf: PerfData | undefined, topN = 10): ResourceOffenders {
  const resources = perf?.resources ?? [];
  const byDuration = [...resources].sort((a, b) => b.duration - a.duration).slice(0, topN);
  const bySize = [...resources].sort((a, b) => b.transferSize - a.transferSize).slice(0, topN);
  return { byDuration, bySize };
}