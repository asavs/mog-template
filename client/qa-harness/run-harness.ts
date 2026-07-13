/**
 * Movement / camera / combat QA harness for BasePlayer.tsx.
 *
 * Two modes:
 *  - default: drives one bot per character class through the phase registry
 *    in scenarios.ts and checks the trace against a checked-in baseline
 *  - QA_MODE=duel: two concurrent bots in the same world; the wizard fires
 *    at the paladin and the run passes only if the paladin's hp channel
 *    actually drops (see duel.ts)
 *
 * Every run records per-frame telemetry plus every input event the page
 * received, and writes an NDJSON trace, a CSV, and a self-contained HTML
 * report. Usage: see client/qa-harness/README.md
 */
import { chromium, type Browser } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureEnv } from './ensure-env';
import type { CharacterClass, RunData, TraceRecord } from './trace-types';
import { summarizeByPhase, checkStructuralIntegrity, type TraceSummary } from './trace-stats';
import { compareToBaseline, formatFailures, type ComparisonFailure } from './compare-baseline';
import { checkConfigChannels, checkInvariants, formatInvariantFailures, type InvariantFailure } from './invariants';
import { parseQaTier, selectPhases, type PhaseDef } from './scenarios';
import { writeRunNdjson, writeFramesCsv } from './trace-io';
import { writeReport } from './report';
import { startNetProxyLane, type NetProfile, type NetProxyLane } from './net-proxy';
import {
  aggregateGridSummaries,
  gridJitterMs,
  gridRunLabel,
  logGridSummary,
  parseBurstSpec,
  parseGridLatencies,
  summarizeGridRun,
  writeGridReport,
  type GridRunSummary,
} from './grid';
import { runDuel } from './duel';
import { runPerf } from './perf-scenarios';
import { logPerfSummary } from './perf-report';
import { evaluatePerfBudgets, formatPerfBudgetCheck, type PerfBudgetCheck, type PerfBudgetFile } from './perf-budgets';
import {
  acquirePointerLock,
  captureChromeTrace,
  closeSession,
  collectRun,
  joinAs,
  openBotSession,
  saveFailureDiagnostics,
  setPhase,
  waitForRenderLoop,
  type SessionConfig,
} from './page-driver';
import { formatAnnounce, isRemoteClientUrl, parsePrArg, resolvePreviewTarget } from './preview-target';
import { checkRequirements, formatResults } from '../../tools/env-requirements/preflight.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(__dirname, 'runs');
const PERF_BUDGETS_PATH = path.join(__dirname, 'perf-budgets.json');
// Baselines are environment-specific: a run only compares meaningfully
// against a baseline captured in the same physics (local GPU vs CI's
// software-rendered SwiftShader at a much lower frame rate). CI points this
// at baselines/ci/; the default stays the local capture.
const BASELINES_DIR = process.env.QA_BASELINE_DIR
  ? path.resolve(process.env.QA_BASELINE_DIR)
  : path.join(__dirname, 'baselines');

const CLIENT_URL = process.env.QA_CLIENT_URL ?? 'http://localhost:5173';
// Structural wait budget for reaching the join dialog and the first player
// frame. Generous values don't affect metric quality (the trace starts after
// join) — CI raises this because SwiftShader + full asset parsing can stall
// the page far longer than a local GPU run.
const JOIN_TIMEOUT_MS = Number(process.env.QA_JOIN_TIMEOUT_MS ?? 15000);
const HEADLESS = process.env.QA_HEADLESS === '1';
const RUN_LABEL = process.env.QA_RUN_LABEL ?? 'baseline';
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
const PERF_ENFORCE = process.env.QA_PERF_ENFORCE === '1';
const AUTOTRACE_PHASES = process.env.QA_AUTOTRACE === '1';
const PHASE_SPEC = process.env.QA_PHASES;
const QA_TIER = parseQaTier(process.env.QA_TIER);
// QA_CHECKS=structural drops the movement-invariant layer, keeping only
// structural integrity checks. For environments where the game is not
// actually playable: GitHub's GPU-less runners never grant pointer lock
// (Chromium rejects the gesture under Xvfb + SwiftShader), the game gates
// ALL input on pointer lock, so movement invariants there test the runner,
// not the game.
const STRUCTURAL_ONLY = process.env.QA_CHECKS === 'structural';
const MODE =
  process.env.QA_MODE === 'duel'
    ? 'duel'
    : process.env.QA_MODE === 'perf'
      ? 'perf'
      : process.env.QA_MODE === 'grid'
        ? 'grid'
        : 'phases';
const CLASSES = (process.env.QA_CLASSES ?? 'wizard,paladin')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean) as CharacterClass[];

const STDB_TARGET_HOST = '127.0.0.1';
const STDB_TARGET_PORT = 3000;

function makeSessionConfig(opts: { clientUrl?: string; runLabel?: string; stdbUrl?: string } = {}): SessionConfig {
  return {
    clientUrl: opts.clientUrl ?? CLIENT_URL,
    ...(opts.stdbUrl ? { stdbUrl: opts.stdbUrl } : {}),
    joinTimeoutMs: JOIN_TIMEOUT_MS,
    runsDir: RUNS_DIR,
    runLabel: opts.runLabel ?? (MODE === 'duel' ? `${RUN_LABEL}-duel` : RUN_LABEL),
  };
}

async function runOneClass(
  browser: Browser,
  characterClass: CharacterClass,
  cfg: SessionConfig,
  phases: PhaseDef[],
): Promise<RunData> {
  const session = await openBotSession(browser, characterClass, cfg);
  let run: RunData | undefined;

  try {
    await joinAs(session, cfg);
    await waitForRenderLoop(session.page, JOIN_TIMEOUT_MS);
    await acquirePointerLock(session.page);
    const cdp = await session.context.newCDPSession(session.page);

    for (const phase of phases) {
      await setPhase(session.page, phase.name);
      await captureChromeTrace(session, cfg, phase.name, AUTOTRACE_PHASES, () =>
        phase.run({ page: session.page, cdp, characterClass }),
      );
    }

    await setPhase(session.page, 'done');
    await session.page.waitForTimeout(300);

    run = await collectRun(session, cfg);
    return run;
  } catch (err) {
    await saveFailureDiagnostics(session, cfg);
    throw err;
  } finally {
    await closeSession(session, run);
  }
}

function runBase(run: RunData): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Name the file after the run's own label (perf scenarios set a distinct
  // label per scenario), not the process-wide default, so scenario runs don't
  // all collapse to the same base name.
  return path.join(RUNS_DIR, `${stamp}-${run.meta.label}-${run.meta.characterClass}`);
}

function safeArtifactSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function moveArtifact(src: string, dest: string): boolean {
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    fs.renameSync(src, dest);
    return true;
  } catch {
    try {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
      return true;
    } catch (err) {
      console.warn(`[run-harness] could not move artifact ${src} -> ${dest}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}

function deleteArtifact(filePath: string) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    console.warn(`[run-harness] could not delete staged artifact ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function finalizeVideo(run: RunData, base: string) {
  const tempPath = run.artifacts?.videoTempPath;
  if (!tempPath || !fs.existsSync(tempPath)) return;

  const dest = `${base}.webm`;
  if (!moveArtifact(tempPath, dest)) return;

  const startedWallTimeMs =
    run.meta.time?.videoStartedWallTimeMs ??
    run.meta.time?.sessionStartedWallTimeMs ??
    Date.parse(run.meta.startedAt);
  run.meta.video = { file: path.basename(dest), startedWallTimeMs };
}

function finalizeChromeTraces(run: RunData, base: string, keepPhases: Set<string>) {
  const staged = run.artifacts?.autoTraceTempPaths ?? {};
  const kept: Record<string, string> = {};

  for (const [phase, tempPath] of Object.entries(staged)) {
    if (!keepPhases.has(phase)) {
      deleteArtifact(tempPath);
      continue;
    }

    const dest = `${base}-${safeArtifactSegment(phase)}.trace.json`;
    if (fs.existsSync(tempPath) && moveArtifact(tempPath, dest)) kept[phase] = path.basename(dest);
  }

  if (Object.keys(kept).length > 0) run.meta.chromeTraces = kept;
}

function writeRun(run: RunData, keepTracePhases = new Set<string>()): string {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const base = runBase(run);

  finalizeVideo(run, base);
  finalizeChromeTraces(run, base, keepTracePhases);

  writeRunNdjson(`${base}.ndjson`, run);
  writeFramesCsv(`${base}.csv`, run.frames);

  console.log(`[run-harness] wrote ${run.frames.length} frames / ${run.events.length} events -> ${base}.ndjson / .csv`);
  return base;
}

function checkFailurePhases(result: CheckResult): Set<string> {
  return new Set([
    ...(result.comparison ?? []).map((f) => f.phase),
    ...result.structuralIssues.map((issue) => issue.split('@')[0]).filter(Boolean),
  ]);
}

function budgetCheckPhase(check: PerfBudgetCheck, run: RunData): string | null {
  if (check.metric === 'timeToPlayableMs') return run.frames[0]?.phase ?? 'startup';
  const parts = check.name.split('.');
  return parts.length >= 3 ? parts[1] : null;
}

function failedBudgetPhases(checks: PerfBudgetCheck[], run: RunData): Set<string> {
  return new Set(
    checks
      .filter((check) => check.status === 'FAIL')
      .map((check) => budgetCheckPhase(check, run))
      .filter((phase): phase is string => !!phase),
  );
}

function readPerfBudgets(): PerfBudgetFile {
  return JSON.parse(fs.readFileSync(PERF_BUDGETS_PATH, 'utf8')) as PerfBudgetFile;
}

type CheckResult = {
  ok: boolean;
  structuralIssues: string[];
  invariantFailures: InvariantFailure[];
  /** undefined = comparison did not run (no baseline, or baseline update). */
  comparison?: ComparisonFailure[];
};

/**
 * Checks a trace's structural integrity (NaNs, dropped positions — always
 * applies) and, if a baseline exists for this class, its drift against that
 * baseline (skipped, not failed, if no baseline has been established yet).
 */
function checkTrace(characterClass: string, trace: TraceRecord[], phases: PhaseDef[]): CheckResult {
  const structuralIssues = checkStructuralIntegrity(trace);
  if (structuralIssues.length > 0) {
    console.error(`[run-harness] ${characterClass}: structural integrity issues:`);
    structuralIssues.forEach((issue) => console.error(`  ${issue}`));
  }

  const summary = summarizeByPhase(trace);
  const invariantFailures = STRUCTURAL_ONLY
    ? []
    : [
        ...checkConfigChannels(trace),
        ...checkInvariants(summary, phases),
      ];
  if (STRUCTURAL_ONLY) {
    console.log('[run-harness] QA_CHECKS=structural: movement invariants skipped');
  }
  if (invariantFailures.length > 0) {
    console.error(formatInvariantFailures(characterClass, invariantFailures));
  }

  const baselinePath = path.join(BASELINES_DIR, `${characterClass}.json`);
  // Generated matrix phases carry config-derived invariant expectations and
  // deliberately never acquire environment-specific recorded baselines.
  const baselineEligibleNames = new Set(
    phases.filter((phase) => phase.group !== 'matrix').map((phase) => phase.name),
  );
  const baselineSummary = Object.fromEntries(
    Object.entries(summary).filter(([phase]) => baselineEligibleNames.has(phase)),
  ) as TraceSummary;

  if (UPDATE_BASELINE) {
    fs.mkdirSync(BASELINES_DIR, { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(baselineSummary, null, 2));
    console.log(`[run-harness] updated baseline -> ${baselinePath}`);
    return { ok: structuralIssues.length === 0 && invariantFailures.length === 0, structuralIssues, invariantFailures };
  }

  if (!fs.existsSync(baselinePath)) {
    console.log(`[run-harness] ${characterClass}: no baseline yet at ${baselinePath} (run with --update-baseline to establish one)`);
    return { ok: structuralIssues.length === 0 && invariantFailures.length === 0, structuralIssues, invariantFailures };
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  // A partial run legitimately lacks unselected phases. Generated phases are
  // invariant-only, so they are excluded from both sides of this comparison.
  const comparedBaseline = Object.fromEntries(
    Object.entries(baseline as Record<string, unknown>).filter(([phase]) => phase in baselineSummary),
  ) as TraceSummary;
  const missingBaselinePhases = Object.keys(baselineSummary).filter(
    (phase) => !(phase in (baseline as Record<string, unknown>)),
  );
  for (const phase of missingBaselinePhases) {
    console.log(`[compare-baseline] ${characterClass}: ${phase}: no baseline (skipped)`);
  }

  const comparison = compareToBaseline(baselineSummary, comparedBaseline);
  if (comparison.length > 0) {
    console.error(formatFailures(characterClass, comparison));
  } else {
    console.log(`[run-harness] ${characterClass}: within baseline tolerance (${Object.keys(baselineSummary).length} phases checked)`);
  }

  return {
    ok: structuralIssues.length === 0 && invariantFailures.length === 0 && comparison.length === 0,
    structuralIssues,
    invariantFailures,
    comparison,
  };
}

async function mainPhases(browser: Browser, cfg: SessionConfig): Promise<{ ok: boolean; reports: string[] }> {
  const reports: string[] = [];
  let ok = true;

  for (const characterClass of CLASSES) {
    const phases = selectPhases(PHASE_SPEC, characterClass, QA_TIER);
    const phaseNames = phases.map((p) => p.name);
    console.log(`[run-harness] running ${characterClass}: ${phaseNames.join(', ')}`);
    const run = await runOneClass(browser, characterClass, cfg, phases);
    const result = checkTrace(characterClass, run.frames, phases);
    const base = writeRun(run, checkFailurePhases(result));
    ok = result.ok && ok;

    const reportPath = writeReport(`${base}.html`, run, {
      structuralIssues: result.structuralIssues,
      invariantFailures: result.invariantFailures,
      comparison: result.comparison,
    });
    console.log(`[run-harness] report -> ${reportPath}`);
    reports.push(reportPath);
  }

  return { ok, reports };
}

// Duel runs don't compare against phase baselines (different phases, and the
// pass/fail signal is the interaction assertion itself) — structural checks
// and the duel issues decide the verdict.
async function mainDuel(browser: Browser, cfg: SessionConfig): Promise<{ ok: boolean; reports: string[] }> {
  console.log('[run-harness] running duel: wizard fires at paladin, verifying hp drop');
  const { runs, issues } = await runDuel(browser, cfg);
  if (issues.length > 0) {
    console.error('[run-harness] duel issues:');
    issues.forEach((issue) => console.error(`  ${issue}`));
  }

  const reports: string[] = [];
  let ok = issues.length === 0;
  for (const run of runs) {
    const structuralIssues = checkStructuralIntegrity(run.frames);
    const base = writeRun(run);
    if (structuralIssues.length > 0) {
      console.error(`[run-harness] ${run.meta.characterClass}: structural integrity issues:`);
      structuralIssues.forEach((issue) => console.error(`  ${issue}`));
      ok = false;
    }
    const reportPath = writeReport(`${base}.html`, run, {
      structuralIssues: [...structuralIssues, ...issues],
    });
    console.log(`[run-harness] report -> ${reportPath}`);
    reports.push(reportPath);
  }

  return { ok, reports };
}

// Perf mode drives the profiling scenarios (cold-load, first-cast,
// player-join, remote-motion). It writes traces + reports, prints per-phase
// perf tables, and gates budget failures only when QA_PERF_ENFORCE=1.
// A scenario that can't even reach a playable state is still a hard failure.
async function mainPerf(browser: Browser, cfg: SessionConfig): Promise<{ ok: boolean; reports: string[] }> {
  const { runs, issues, notes } = await runPerf(browser, cfg);

  const reports: string[] = [];
  const budgets = readPerfBudgets();
  let budgetOk = true;

  for (const run of runs) {
    const structuralIssues = checkStructuralIntegrity(run.frames);
    const budgetChecks = evaluatePerfBudgets(run, budgets);
    const base = writeRun(run, failedBudgetPhases(budgetChecks, run));
    const reportPath = writeReport(`${base}.html`, run, { structuralIssues });
    reports.push(reportPath);
    logPerfSummary(run);

    for (const check of budgetChecks) {
      const line = formatPerfBudgetCheck(check);
      if (check.status === 'FAIL') {
        budgetOk = false;
        console.error(line);
      } else {
        console.log(line);
      }
    }
  }

  if (notes.length > 0) {
    console.log('\n[perf] notes:');
    notes.forEach((note) => console.log(`  ${note}`));
  }
  if (issues.length > 0) {
    console.error('\n[perf] issues:');
    issues.forEach((issue) => console.error(`  ${issue}`));
  }

  return { ok: issues.length === 0 && (!PERF_ENFORCE || budgetOk), reports };
}

function stdbProxyUrl(lane: NetProxyLane) {
  return `ws://127.0.0.1:${lane.port}`;
}

function parseNetProfileSpec(spec: string | undefined): NetProfile | null {
  if (!spec) return null;
  const [delay, jitter] = spec.split('/').map((part) => part.trim());
  const delayMs = Number(delay);
  const jitterMs = Number(jitter ?? '0');
  if (!Number.isFinite(delayMs) || !Number.isFinite(jitterMs) || delayMs < 0 || jitterMs < 0) {
    throw new Error(`QA_NET_PROFILE must be <delayMs>/<jitterMs>; got ${JSON.stringify(spec)}`);
  }
  return { delayMs, jitterMs };
}

async function startEnvNetProxy(): Promise<{ lane: NetProxyLane; stdbUrl: string } | null> {
  const profile = parseNetProfileSpec(process.env.QA_NET_PROFILE);
  if (!profile) return null;

  const lane = await startNetProxyLane({
    targetHost: STDB_TARGET_HOST,
    targetPort: STDB_TARGET_PORT,
    profile,
  });
  const stdbUrl = stdbProxyUrl(lane);
  console.log(`[run-harness] QA_NET_PROFILE=${profile.delayMs}/${profile.jitterMs} via ${stdbUrl} -> ${STDB_TARGET_HOST}:${STDB_TARGET_PORT}`);
  return { lane, stdbUrl };
}

async function mainGrid(browser: Browser, baseCfg: SessionConfig): Promise<{ ok: boolean; reports: string[] }> {
  const latencies = parseGridLatencies();
  const burst = parseBurstSpec();
  const phaseSpec = PHASE_SPEC ?? 'movement';
  const lane = await startNetProxyLane({
    targetHost: STDB_TARGET_HOST,
    targetPort: STDB_TARGET_PORT,
    profile: { delayMs: 0, jitterMs: 0 },
  });

  const reports: string[] = [];
  const summaries: GridRunSummary[] = [];
  let ok = true;

  try {
    for (const latencyMs of latencies) {
      const profile = {
        delayMs: latencyMs,
        jitterMs: gridJitterMs(latencyMs),
        ...(burst ? { burst } : {}),
      };
      lane.setProfile(profile);
      const label = gridRunLabel(latencyMs, burst);
      const cfg = makeSessionConfig({
        clientUrl: baseCfg.clientUrl,
        stdbUrl: stdbProxyUrl(lane),
        runLabel: label,
      });

      for (const characterClass of CLASSES) {
        const phases = selectPhases(phaseSpec, characterClass, QA_TIER);
        console.log(`[grid] ${label} ${characterClass} (${profile.delayMs}ms +/- ${profile.jitterMs}ms): ${phases.map((p) => p.name).join(', ')}`);
        const run = await runOneClass(browser, characterClass, cfg, phases);
        const base = writeRun(run);
        const structuralIssues = checkStructuralIntegrity(run.frames);
        if (structuralIssues.length > 0) {
          ok = false;
          console.error(`[grid] ${label} ${characterClass}: structural integrity issues:`);
          structuralIssues.forEach((issue) => console.error(`  ${issue}`));
        }
        const reportPath = writeReport(`${base}.html`, run, { structuralIssues });
        reports.push(reportPath);
        summaries.push(summarizeGridRun(latencyMs, run));
      }
    }
  } finally {
    await lane.close();
  }

  const rows = aggregateGridSummaries(summaries);
  logGridSummary(rows);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const gridReport = writeGridReport(path.join(RUNS_DIR, `${stamp}-${RUN_LABEL}-grid.html`), rows, { label: RUN_LABEL });
  console.log(`[grid] report -> ${gridReport}`);
  reports.push(gridReport);

  return { ok, reports };
}

// Preflight a set of environment requirements (tools/env-requirements) and
// abort with the registry's why/remedy if any fail-severity one is unmet —
// surfacing e.g. a missing `gh` or Linux-native node_modules as a clear
// message here rather than a cryptic ENOENT deep in the run. warns print but
// never abort. Stage-A groundwork for the derived tool x environment matrix.
function envPreflight(ids: string[]): void {
  const { ok, results } = checkRequirements(ids);
  console.log('[run-harness] environment preflight:');
  console.log(
    formatResults(results)
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  );
  if (!ok) {
    const failed = results.filter((r) => r.status === 'FAIL').map((r) => r.id);
    throw new Error(
      `environment preflight failed (${failed.join(', ')}) — see the why/remedy above, ` +
        `or re-run: node tools/env-requirements/preflight.mjs ${ids.join(' ')}`,
    );
  }
}

async function main() {
  // Precedence: --pr <N> (preview VM announce) > a remote QA_CLIENT_URL >
  // local default. A --pr target resolves the PR's announce comment to the
  // ephemeral VM URL; both remote paths skip the local SpacetimeDB/Vite
  // bootstrap (the VM already serves the client + its own SpacetimeDB /v1).
  const prTarget = parsePrArg(process.argv.slice(2));
  // The --pr path shells out to `gh` to read the PR's announce comment and
  // drives a local Chromium against the remote VM, so it needs the gh CLI +
  // auth and a native node_modules; check before the gh call, not after it
  // fails.
  if (prTarget != null) {
    envPreflight(['gh-cli', 'gh-auth', 'windows-node-modules']);
  }
  let clientUrl = CLIENT_URL;
  let remote = isRemoteClientUrl(CLIENT_URL);
  if (prTarget != null) {
    const announce = resolvePreviewTarget(prTarget);
    clientUrl = announce.url;
    remote = true;
    console.log(`[run-harness] resolved preview target for PR #${prTarget}:`);
    console.log(
      formatAnnounce(announce)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  }

  if (remote) {
    console.log(`[run-harness] remote client URL (${clientUrl}) — skipping local SpacetimeDB/Vite bootstrap`);
    if (MODE === 'grid' || process.env.QA_NET_PROFILE) {
      console.warn(
        '[run-harness] WARNING: net-proxy / grid latency shaping only fronts a local SpacetimeDB ' +
          '(127.0.0.1:3000); it will not shape traffic to the remote VM. Prefer local mode for latency grids.',
      );
    }
  } else {
    // Local mode drives headed Chromium against a WSL2-hosted SpacetimeDB +
    // local Vite. Migrate ensure-env's implicit host assumptions into probes:
    // it needs a display for headed Chromium (unless QA_HEADLESS=1) and, on
    // Windows, `wsl.exe` and a native node_modules. (SpacetimeDB itself is
    // brought up by ensure-env inside WSL/CI, not required on the host PATH.)
    const localIds = [
      ...(HEADLESS ? [] : ['headed-display']),
      ...(process.platform === 'win32' ? ['wsl-available', 'windows-node-modules'] : []),
    ];
    if (localIds.length > 0) envPreflight(localIds);
    await ensureEnv({ publish: process.argv.includes('--publish') });
  }

  // The net proxy only makes sense in front of a local SpacetimeDB. Against a
  // remote VM the page talks to the VM's own /v1, so leave stdbUrl unset.
  const envProxy = remote || MODE === 'grid' ? null : await startEnvNetProxy();
  const cfg = makeSessionConfig({ clientUrl, stdbUrl: envProxy?.stdbUrl });
  let browser: Browser | null = null;
  let result: { ok: boolean; reports: string[] };

  try {
    browser = await chromium.launch({ headless: HEADLESS });
    result =
      MODE === 'duel'
        ? await mainDuel(browser, cfg)
        : MODE === 'perf'
          ? await mainPerf(browser, cfg)
          : MODE === 'grid'
            ? await mainGrid(browser, cfg)
            : await mainPhases(browser, cfg);
  } finally {
    if (browser) await browser.close();
    await envProxy?.lane.close();
  }

  console.log('[run-harness] done:');
  result.reports.forEach((p) => console.log(`  ${p}`));

  if (!result.ok) {
    console.error('[run-harness] failed: structural issues, invariant failures, baseline drift, or an unmet scenario assertion');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[run-harness] failed:', err);
  process.exit(1);
});






