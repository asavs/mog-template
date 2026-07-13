/**
 * Offline diagnostics over harness NDJSON traces.
 * Surfaces hitch/stall patterns, phase-distance anomalies, combat channel
 * coverage, and multi-run reproducibility signals that the baseline gate
 * does not fully capture — especially for remote beta runs.
 */
import type { TraceRecord } from './trace-types';

export type FrameRec = TraceRecord & {
  type?: string;
  t: number;
  phase?: string;
  simPosition?: { x: number; y: number; z: number } | null;
  renderPosition?: { x: number; y: number; z: number } | null;
  localServerTick?: string | null;
  localCorrectionError?: number | null;
  offsetLength?: number | null;
  channels?: Record<string, number>;
};

export type HitchEvent = {
  phase: string;
  t: number;
  dtMs: number;
  index: number;
};

export type PhaseDiag = {
  phase: string;
  frames: number;
  durationMs: number;
  wallDurationMs: number;
  maxDtMs: number;
  p95DtMs: number;
  p99DtMs: number;
  meanDtMs: number;
  hitchCount: number;
  maxHitchMs: number;
  netXZ: { x: number; z: number };
  netDisplacement: number;
  pathLength: number;
  straightness: number | null;
  meanCorrErr: number | null;
  maxCorrErr: number | null;
  meanOffset: number | null;
  tickSpan: number | null;
  ticksPerSec: number | null;
  channelMax: Record<string, number>;
  joinedNullPos: number;
};

export type RunDiagnostics = {
  file: string;
  meta: Record<string, unknown> | null;
  frameCount: number;
  eventCount: number;
  longtaskCount: number;
  resourceCount: number;
  overallMaxDtMs: number;
  overallP95DtMs: number;
  hitches: HitchEvent[];
  phases: PhaseDiag[];
  concerns: Concern[];
  combat: {
    fireballSaw: boolean;
    lightningSaw: boolean;
    combatFeedbackSaw: boolean;
    hpChanged: boolean;
  };
  load: {
    topResources: Array<{ name: string; transferKB: number; durationMs: number }>;
    totalTransferMB: number;
  };
};

export type Concern = {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  code: string;
  phase?: string;
  message: string;
  evidence?: string;
};

const HITCH_MS = 100;
const SEVERE_HITCH_MS = 1000;
const WALK_EXPECTED = 9; // 6 u/s * 1.5s
const WALK_TOL = 1.8;

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))));
  return s[i];
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function parseNdjson(text: string): {
  meta: Record<string, unknown> | null;
  frames: FrameRec[];
  events: Array<Record<string, unknown>>;
  longtasks: Array<Record<string, unknown>>;
  resources: Array<Record<string, unknown>>;
} {
  const lines = text
    .trim()
    .split(/\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const meta = (lines.find((r) => r.type === 'meta') as Record<string, unknown> | undefined) ?? null;
  const frames = lines.filter((r) => r.type === 'frame') as FrameRec[];
  const events = lines.filter((r) => r.type === 'event');
  const longtasks = lines.filter((r) => r.type === 'longtask');
  const resources = lines.filter((r) => r.type === 'resource');
  return { meta, frames, events, longtasks, resources };
}

function phaseDeltas(frames: FrameRec[]): number[] {
  const dts: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i].t - frames[i - 1].t;
    if (Number.isFinite(dt) && dt > 0 && dt < 60_000) dts.push(dt);
  }
  return dts;
}

function analyzePhase(phase: string, frames: FrameRec[]): PhaseDiag {
  const withPos = frames.filter((f) => f.simPosition);
  const dts = phaseDeltas(frames);
  const hitches = dts.filter((d) => d >= HITCH_MS);
  const first = withPos[0]?.simPosition;
  const last = withPos[withPos.length - 1]?.simPosition;
  const netXZ = first && last ? { x: last.x - first.x, z: last.z - first.z } : { x: 0, z: 0 };
  const netDisplacement = Math.sqrt(netXZ.x * netXZ.x + netXZ.z * netXZ.z);

  let pathLength = 0;
  for (let i = 1; i < withPos.length; i++) {
    pathLength += dist(withPos[i - 1].simPosition!, withPos[i].simPosition!);
  }
  const straightness = pathLength > 1e-6 ? netDisplacement / pathLength : null;

  const corrs = withPos
    .map((f) => f.localCorrectionError)
    .filter((x): x is number => typeof x === 'number');
  const offs = withPos.map((f) => f.offsetLength).filter((x): x is number => typeof x === 'number');
  const ticks = withPos
    .map((f) => Number(f.localServerTick))
    .filter((n) => Number.isFinite(n));
  const tickSpan = ticks.length ? Math.max(...ticks) - Math.min(...ticks) : null;
  const wallDurationMs = frames.length >= 2 ? frames[frames.length - 1].t - frames[0].t : 0;
  const ticksPerSec =
    tickSpan != null && wallDurationMs > 0 ? (tickSpan / wallDurationMs) * 1000 : null;

  const channelMax: Record<string, number> = {};
  for (const f of frames) {
    if (!f.channels) continue;
    for (const [k, v] of Object.entries(f.channels)) {
      if (typeof v !== 'number') continue;
      channelMax[k] = channelMax[k] == null ? v : Math.max(channelMax[k], v);
    }
  }

  let joinedNullPos = 0;
  for (const f of frames) {
    if (f.channels?.isJoined === 1 && !f.simPosition) joinedNullPos += 1;
  }

  return {
    phase,
    frames: frames.length,
    durationMs: wallDurationMs,
    wallDurationMs,
    maxDtMs: dts.length ? Math.max(...dts) : 0,
    p95DtMs: pct(dts, 95),
    p99DtMs: pct(dts, 99),
    meanDtMs: mean(dts) ?? 0,
    hitchCount: hitches.length,
    maxHitchMs: hitches.length ? Math.max(...hitches) : 0,
    netXZ,
    netDisplacement,
    pathLength,
    straightness,
    meanCorrErr: mean(corrs),
    maxCorrErr: corrs.length ? Math.max(...corrs) : null,
    meanOffset: mean(offs),
    tickSpan,
    ticksPerSec,
    channelMax,
    joinedNullPos,
  };
}

function collectHitches(frames: FrameRec[]): HitchEvent[] {
  const out: HitchEvent[] = [];
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i].t - frames[i - 1].t;
    if (dt >= HITCH_MS) {
      out.push({
        phase: frames[i].phase ?? '(none)',
        t: frames[i].t,
        dtMs: dt,
        index: i,
      });
    }
  }
  return out.sort((a, b) => b.dtMs - a.dtMs);
}

function concernsFromRun(
  phases: PhaseDiag[],
  hitches: HitchEvent[],
  combat: RunDiagnostics['combat'],
  characterClass: string | undefined,
): Concern[] {
  const concerns: Concern[] = [];

  for (const h of hitches) {
    if (h.dtMs >= SEVERE_HITCH_MS) {
      concerns.push({
        severity: 'critical',
        code: 'severe-frame-stall',
        phase: h.phase,
        message: `Main-thread / rAF stall of ${h.dtMs.toFixed(0)}ms during ${h.phase}`,
        evidence: `t=${h.t.toFixed(0)} frame index ${h.index}`,
      });
    } else if (h.dtMs >= 250) {
      concerns.push({
        severity: 'high',
        code: 'frame-hitch',
        phase: h.phase,
        message: `${h.dtMs.toFixed(0)}ms frame gap in ${h.phase}`,
        evidence: `t=${h.t.toFixed(0)}`,
      });
    }
  }

  for (const p of phases) {
    if (p.phase === 'startup' || p.phase === 'done') continue;

    // Cardinal walks should cover ~9 units in 1.5s at walk speed 6.
    if (
      ['walk_forward', 'walk_backward', 'strafe_left', 'strafe_right'].includes(p.phase) &&
      p.durationMs > 500
    ) {
      if (p.netDisplacement < WALK_EXPECTED - WALK_TOL) {
        concerns.push({
          severity: p.maxHitchMs >= SEVERE_HITCH_MS ? 'critical' : 'high',
          code: 'under-movement',
          phase: p.phase,
          message: `${p.phase} net displacement ${p.netDisplacement.toFixed(2)} (expected ~${WALK_EXPECTED}±${WALK_TOL})`,
          evidence: `frames=${p.frames} wallMs=${p.wallDurationMs.toFixed(0)} maxDt=${p.maxDtMs.toFixed(0)} tickSpan=${p.tickSpan}`,
        });
      }
      if (p.netDisplacement > WALK_EXPECTED + WALK_TOL * 2) {
        concerns.push({
          severity: 'high',
          code: 'over-movement',
          phase: p.phase,
          message: `${p.phase} net displacement ${p.netDisplacement.toFixed(2)} (expected ~${WALK_EXPECTED}) — residual velocity or wrong direction?`,
          evidence: `netXZ=(${p.netXZ.x.toFixed(2)},${p.netXZ.z.toFixed(2)}) straightness=${p.straightness?.toFixed(3)}`,
        });
      }
      if (p.straightness != null && p.straightness < 0.75 && p.netDisplacement > 1) {
        concerns.push({
          severity: 'medium',
          code: 'crooked-path',
          phase: p.phase,
          message: `Straightness ${p.straightness.toFixed(3)} < 0.75 on single-axis move`,
          evidence: `path=${p.pathLength.toFixed(2)} net=${p.netDisplacement.toFixed(2)}`,
        });
      }
    }

    if (p.phase.startsWith('cast_') || p.phase === 'attack_slash' || p.phase === 'block_hold') {
      if (p.netDisplacement > 0.5) {
        concerns.push({
          severity: 'medium',
          code: 'stationary-drift',
          phase: p.phase,
          message: `Stationary combat phase drifted ${p.netDisplacement.toFixed(2)} units`,
          evidence: `meanCorr=${p.meanCorrErr?.toExponential(2)}`,
        });
      }
    }

    if (p.meanCorrErr != null && p.meanCorrErr > 0.5) {
      concerns.push({
        severity: 'medium',
        code: 'high-correction-error',
        phase: p.phase,
        message: `Mean localCorrectionError ${p.meanCorrErr.toFixed(3)} (elevated reconciling)`,
        evidence: `maxCorr=${p.maxCorrErr?.toFixed(3)}`,
      });
    }

    if (p.maxCorrErr != null && p.maxCorrErr > 5) {
      concerns.push({
        severity: 'high',
        code: 'correction-spike',
        phase: p.phase,
        message: `Correction error spiked to ${p.maxCorrErr.toFixed(2)}`,
      });
    }

    // Sparse frames during a long wall window = collection starved (stall).
    if (p.wallDurationMs > 2000 && p.frames < 60 && p.maxDtMs > 500) {
      concerns.push({
        severity: 'critical',
        code: 'sparse-frames',
        phase: p.phase,
        message: `Only ${p.frames} frames over ${p.wallDurationMs.toFixed(0)}ms wall time`,
        evidence: `maxDt=${p.maxDtMs.toFixed(0)}ms — rAF likely blocked`,
      });
    }

    if (p.joinedNullPos > 20) {
      concerns.push({
        severity: 'low',
        code: 'joined-without-pos',
        phase: p.phase,
        message: `${p.joinedNullPos} frames with isJoined=1 but no simPosition`,
      });
    }
  }

  if (characterClass === 'wizard') {
    if (!combat.fireballSaw) {
      concerns.push({
        severity: 'high',
        code: 'combat-channel-missing',
        message: 'fireballProjectiles never rose above 0 during wizard run',
      });
    }
    if (!combat.lightningSaw) {
      concerns.push({
        severity: 'medium',
        code: 'combat-channel-missing',
        message: 'lightningEffects never rose above 0 during wizard run',
      });
    }
  }
  if (characterClass === 'paladin' && !combat.combatFeedbackSaw) {
    // attack_slash may only pulse briefly
    concerns.push({
      severity: 'info',
      code: 'combat-feedback-quiet',
      message: 'combatFeedbackEffects never > 0 — slash may not be instrumented or did not fire',
    });
  }

  return concerns;
}

export function diagnoseRun(file: string, text: string): RunDiagnostics {
  const { meta, frames, events, longtasks, resources } = parseNdjson(text);
  const byPhase = new Map<string, FrameRec[]>();
  for (const f of frames) {
    const p = f.phase ?? '(none)';
    if (!byPhase.has(p)) byPhase.set(p, []);
    byPhase.get(p)!.push(f);
  }
  const phases = [...byPhase.entries()].map(([name, pf]) => analyzePhase(name, pf));
  const hitches = collectHitches(frames);
  const allDts = phaseDeltas(frames);

  let fireMax = 0;
  let lightMax = 0;
  let combatFbMax = 0;
  let hpMin = Infinity;
  let hpMax = -Infinity;
  for (const f of frames) {
    const c = f.channels;
    if (!c) continue;
    if (typeof c.fireballProjectiles === 'number') fireMax = Math.max(fireMax, c.fireballProjectiles);
    if (typeof c.lightningEffects === 'number') lightMax = Math.max(lightMax, c.lightningEffects);
    if (typeof c.combatFeedbackEffects === 'number') combatFbMax = Math.max(combatFbMax, c.combatFeedbackEffects);
    if (typeof c.hp === 'number') {
      hpMin = Math.min(hpMin, c.hp);
      hpMax = Math.max(hpMax, c.hp);
    }
  }

  const combat = {
    fireballSaw: fireMax > 0,
    lightningSaw: lightMax > 0,
    combatFeedbackSaw: combatFbMax > 0,
    hpChanged: Number.isFinite(hpMin) && hpMin < hpMax,
  };

  const topResources = [...resources]
    .map((r) => ({
      name: String(r.name ?? ''),
      transferKB: Number(r.transferSize ?? 0) / 1024,
      durationMs: Number(r.duration ?? 0),
    }))
    .sort((a, b) => b.transferKB - a.transferKB)
    .slice(0, 8);

  const totalTransferMB =
    resources.reduce((s, r) => s + Number(r.transferSize ?? 0), 0) / (1024 * 1024);

  const characterClass =
    typeof meta?.characterClass === 'string' ? meta.characterClass : undefined;

  const concerns = concernsFromRun(phases, hitches, combat, characterClass);

  if (totalTransferMB > 40) {
    concerns.push({
      severity: 'medium',
      code: 'heavy-cold-load',
      message: `Cold-load transferred ~${totalTransferMB.toFixed(1)} MB of assets`,
      evidence: topResources
        .slice(0, 3)
        .map((r) => `${(r.transferKB / 1024).toFixed(1)}MB ${r.name.split('/').pop()}`)
        .join('; '),
    });
  }

  // Startup long hitch is expected during asset parse — downgrade severity if only in startup.
  for (const c of concerns) {
    if (c.code === 'severe-frame-stall' && c.phase === 'startup') {
      c.severity = 'medium';
      c.message += ' (startup asset load — expected-ish on cold beta)';
    }
  }

  return {
    file,
    meta,
    frameCount: frames.length,
    eventCount: events.length,
    longtaskCount: longtasks.length,
    resourceCount: resources.length,
    overallMaxDtMs: allDts.length ? Math.max(...allDts) : 0,
    overallP95DtMs: pct(allDts, 95),
    hitches: hitches.slice(0, 15),
    phases,
    concerns: concerns.sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
    combat,
    load: { topResources, totalTransferMB },
  };
}

function severityRank(s: Concern['severity']): number {
  return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[s];
}

export function formatDiagnostics(d: RunDiagnostics): string {
  const lines: string[] = [];
  const cls = d.meta?.characterClass ?? '?';
  const label = d.meta?.label ?? '';
  const url = d.meta?.clientUrl ?? '';
  lines.push(`\n======== ${d.file} ========`);
  lines.push(`class=${cls} label=${label}`);
  lines.push(`url=${url}`);
  lines.push(
    `frames=${d.frameCount} events=${d.eventCount} longtasks=${d.longtaskCount} resources=${d.resourceCount}`,
  );
  lines.push(
    `frame pacing: p95=${d.overallP95DtMs.toFixed(1)}ms max=${d.overallMaxDtMs.toFixed(1)}ms hitches(≥${HITCH_MS}ms)=${d.hitches.length}`,
  );
  lines.push(
    `combat: fireball=${d.combat.fireballSaw} lightning=${d.combat.lightningSaw} combatFb=${d.combat.combatFeedbackSaw} hpChanged=${d.combat.hpChanged}`,
  );
  lines.push(`load: ${d.load.totalTransferMB.toFixed(1)} MB total`);

  lines.push('\nphases:');
  for (const p of d.phases) {
    if (p.phase === 'startup' && p.frames < 5) continue;
    lines.push(
      `  ${p.phase.padEnd(28)} n=${String(p.frames).padStart(4)} wall=${p.wallDurationMs.toFixed(0).padStart(5)}ms` +
        ` maxDt=${p.maxDtMs.toFixed(0).padStart(5)} p95=${p.p95DtMs.toFixed(1).padStart(5)}` +
        ` net=${p.netDisplacement.toFixed(2).padStart(6)} str=${p.straightness?.toFixed(2) ?? '  - '}` +
        ` corr=${p.meanCorrErr?.toFixed(3) ?? '  -  '} hitches=${p.hitchCount}`,
    );
  }

  if (d.hitches.length) {
    lines.push('\ntop hitches:');
    for (const h of d.hitches.slice(0, 8)) {
      lines.push(`  ${h.dtMs.toFixed(0).padStart(6)}ms @ t=${h.t.toFixed(0)} phase=${h.phase}`);
    }
  }

  if (d.concerns.length) {
    lines.push('\nconcerns:');
    for (const c of d.concerns) {
      lines.push(
        `  [${c.severity.toUpperCase()}] ${c.code}${c.phase ? ` (${c.phase})` : ''}: ${c.message}` +
          (c.evidence ? `\n           ${c.evidence}` : ''),
      );
    }
  } else {
    lines.push('\nconcerns: none');
  }

  return lines.join('\n');
}

/** Compare two runs of the same class for reproducibility. */
export function compareRuns(a: RunDiagnostics, b: RunDiagnostics): Concern[] {
  const concerns: Concern[] = [];
  const mapB = new Map(b.phases.map((p) => [p.phase, p]));
  for (const pa of a.phases) {
    const pb = mapB.get(pa.phase);
    if (!pb) continue;
    if (['startup', 'done'].includes(pa.phase)) continue;
    const dNet = Math.abs(pa.netDisplacement - pb.netDisplacement);
    if (dNet > 3 && Math.max(pa.netDisplacement, pb.netDisplacement) > 1) {
      concerns.push({
        severity: 'medium',
        code: 'non-reproducible-distance',
        phase: pa.phase,
        message: `netDisplacement ${pa.netDisplacement.toFixed(2)} vs ${pb.netDisplacement.toFixed(2)} across runs (Δ=${dNet.toFixed(2)})`,
      });
    }
    if (Math.max(pa.maxHitchMs, pb.maxHitchMs) >= SEVERE_HITCH_MS && Math.min(pa.maxHitchMs, pb.maxHitchMs) < 250) {
      concerns.push({
        severity: 'high',
        code: 'intermittent-stall',
        phase: pa.phase,
        message: `Severe stall in one run only (${pa.maxHitchMs.toFixed(0)}ms vs ${pb.maxHitchMs.toFixed(0)}ms)`,
      });
    }
  }
  return concerns;
}
