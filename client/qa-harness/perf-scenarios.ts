/**
 * Performance profiling scenarios. Each drives a real session (or two, like
 * duel.ts) and leans on the always-on perf collectors (perf-collectors.ts,
 * injected in openBotSession) plus the frame trace. The game is never
 * modified; everything is observed from standard browser APIs.
 *
 * Scenarios (see README perf section):
 *  - cold-load: fresh context -> goto -> join, landmarked.
 *  - first-cast: idle baseline, then two casts of the tap action bound to
 *    `primary` (v2 has no wizard/spell-specific keys — see generate-phases.ts's
 *    action-primitive matrix doc), each in its own phase window so
 *    first-vs-second is a phase comparison.
 *  - player-join: bot A steady-state, then bot B joins the same world;
 *    measure A's stall in the window after B appears vs its baseline.
 *  - remote-motion: bot B walks ~10s while bot A observes. A's page exposes
 *    only its OWN identity's row in window.__mogGame.store (no remote-player
 *    per-frame render position), so B's rendered position on A's page is not
 *    reachable — documented as a gap, same as before the v2 rewrite.
 *
 * Perf numbers are reported against budgets; failures only gate with QA_PERF_ENFORCE=1.
 */
import type { Browser, Page } from 'playwright';
import type { LoadLandmarks, RunData } from './trace-types';
import { SLOT_BINDINGS } from '../src/actions/defs.generated';
import { summarizeWsByPhase } from './perf-stats';
import {
  acquirePointerLock,
  captureChromeTrace,
  closeSession,
  collectRun,
  joinAs,
  openBotSession,
  readStoreField,
  saveFailureDiagnostics,
  setPhase,
  waitForRenderLoop,
  type BotSession,
  type SessionConfig,
} from './page-driver';
import { pressSlot, releaseSlot } from './generate-phases';

export type PerfResult = {
  runs: RunData[];
  /** Hard failures (e.g. a session that never became playable). */
  issues: string[];
  /** Descriptive notes, incl. instrumentation gaps (e.g. remote positions). */
  notes: string[];
};

const BASELINE_MS = 5000;
const CAST_WINDOW_MS = 3000;
const REMOTE_WALK_MS = 10000;
const POST_JOIN_MS = 5000;

async function holdKey(page: Page, code: string, ms: number) {
  await page.keyboard.down(code);
  await page.waitForTimeout(ms);
  await page.keyboard.up(code);
}

function scenarioCfg(cfg: SessionConfig, label: string): SessionConfig {
  return { ...cfg, runLabel: label };
}

async function tracedPhase<T>(session: BotSession, cfg: SessionConfig, phase: string, fn: () => Promise<T>): Promise<T> {
  await setPhase(session.page, phase);
  return await captureChromeTrace(session, cfg, phase, true, fn);
}

// ---------------------------------------------------------------------------
// cold-load

async function coldLoadJoin(session: BotSession, cfg: SessionConfig): Promise<LoadLandmarks> {
  const { page, botLabel } = session;
  const url = new URL(cfg.clientUrl);
  if (!url.searchParams.has('qa')) url.searchParams.set('qa', '');

  const t0 = Date.now();
  // networkidle never settles with live SpacetimeDB websockets on preview/prod.
  await page.goto(url.toString(), {
    waitUntil: 'domcontentloaded',
    timeout: Math.max(cfg.joinTimeoutMs, 60_000),
  });
  const nameInput = page.getByPlaceholder('name');
  await nameInput.waitFor({ state: 'visible', timeout: cfg.joinTimeoutMs });
  const tJoinScreen = Date.now();

  await nameInput.fill(`QaBot-${botLabel}-${Date.now()}`);
  const tClick = Date.now();
  await page.getByRole('button', { name: 'join', exact: true }).click();
  await page.waitForFunction(
    () => !!(window as unknown as { __mogGame?: { joined?: boolean } }).__mogGame?.joined,
    undefined,
    { timeout: cfg.joinTimeoutMs },
  );
  const tPlayable = Date.now();

  await waitForRenderLoop(page, cfg.joinTimeoutMs);
  const tFrames = Date.now();

  return {
    timeToJoinScreenMs: tJoinScreen - t0,
    timeToPlayableMs: tPlayable - tClick,
    timeToFirstFramesMs: tFrames - tClick,
    totalMs: tFrames - t0,
  };
}

async function runColdLoad(browser: Browser, cfg: SessionConfig, botLabel: string): Promise<RunData> {
  const scfg = scenarioCfg(cfg, 'perf-coldload');
  const session = await openBotSession(browser, botLabel, scfg);
  let run: RunData | undefined;
  try {
    const landmarks = await captureChromeTrace(session, scfg, 'startup', true, () => coldLoadJoin(session, scfg));
    // Let the first rendered frames settle so their frame deltas land in a
    // named window rather than in 'startup'.
    await tracedPhase(session, scfg, 'settle', () => session.page.waitForTimeout(3000));
    await setPhase(session.page, 'done');
    await session.page.waitForTimeout(300);

    run = await collectRun(session, scfg);
    if (run.perf) run.perf.landmarks = landmarks;
    return run;
  } catch (err) {
    await saveFailureDiagnostics(session, scfg);
    throw err;
  } finally {
    await closeSession(session, run);
  }
}

// ---------------------------------------------------------------------------
// first-cast — v2 has no wizard/spell-specific keys, so this drives whatever
// tap action `primary` resolves to twice (see generate-phases.ts's action
// matrix for how "primary" is picked generically).

const PRIMARY_SLOT = SLOT_BINDINGS.find((b) => b.tapAction !== null)?.slot ?? 'primary';

async function runFirstCast(browser: Browser, cfg: SessionConfig): Promise<RunData> {
  const scfg = scenarioCfg(cfg, 'perf-firstcast');
  const session = await openBotSession(browser, 'a', scfg);
  let run: RunData | undefined;
  try {
    await joinAs(session, scfg);
    await waitForRenderLoop(session.page, scfg.joinTimeoutMs);
    await acquirePointerLock(session.page);
    const { page } = session;

    // Steady-state baseline before any action.
    await tracedPhase(session, scfg, 'steady_baseline', () => page.waitForTimeout(BASELINE_MS));

    await tracedPhase(session, scfg, 'primary_1', async () => {
      await pressSlot(page, PRIMARY_SLOT);
      await releaseSlot(page, PRIMARY_SLOT);
      await page.waitForTimeout(CAST_WINDOW_MS);
    });
    await tracedPhase(session, scfg, 'primary_2', async () => {
      await pressSlot(page, PRIMARY_SLOT);
      await releaseSlot(page, PRIMARY_SLOT);
      await page.waitForTimeout(CAST_WINDOW_MS);
    });

    await setPhase(page, 'done');
    await page.waitForTimeout(300);
    run = await collectRun(session, scfg);
    return run;
  } catch (err) {
    await saveFailureDiagnostics(session, scfg);
    throw err;
  } finally {
    await closeSession(session, run);
  }
}

// ---------------------------------------------------------------------------
// player-join

async function runPlayerJoin(browser: Browser, cfg: SessionConfig, notes: string[]): Promise<RunData[]> {
  const scfg = scenarioCfg(cfg, 'perf-playerjoin');
  // Sessions are pushed the moment they open (including B, opened mid-phase),
  // so the finally closes exactly the sessions that actually exist even when
  // a later step of the same phase throws.
  const sessions: BotSession[] = [];
  const runsBySession = new Map<BotSession, RunData>();
  try {
    const botA = await openBotSession(browser, 'a', scfg);
    sessions.push(botA);
    await joinAs(botA, scfg);
    await waitForRenderLoop(botA.page, scfg.joinTimeoutMs);

    await tracedPhase(botA, scfg, 'pre_join_baseline', () => botA.page.waitForTimeout(BASELINE_MS));
    const remoteCountBefore = await readStoreField(botA.page, 'player', 'connected', 'local'); // presence-only probe, see below

    // B connects; A stays in a distinct window while the connection/subscription
    // and the new remote player's assets come in.
    const botB = await tracedPhase(botA, scfg, 'b_joining', async () => {
      const b = await openBotSession(browser, 'b', scfg);
      sessions.push(b);
      await joinAs(b, scfg);
      await waitForRenderLoop(b.page, scfg.joinTimeoutMs);
      return b;
    });

    await tracedPhase(botA, scfg, 'after_b_join', () => botA.page.waitForTimeout(POST_JOIN_MS));
    notes.push(
      `player-join: bot A's own presence probe before/after B's join: ${remoteCountBefore ?? '—'} (see __mogGame.store.player size in the trace for the actual count)`,
    );

    await setPhase(botA.page, 'done');
    await setPhase(botB.page, 'done');
    await botA.page.waitForTimeout(300);

    const runA = await collectRun(botA, scfg);
    const runB = await collectRun(botB, scfg);
    runsBySession.set(botA, runA);
    runsBySession.set(botB, runB);
    return [runA, runB];
  } catch (err) {
    for (const session of sessions) await saveFailureDiagnostics(session, scfg);
    throw err;
  } finally {
    for (const session of [...sessions].reverse()) {
      await closeSession(session, runsBySession.get(session));
    }
  }
}

// ---------------------------------------------------------------------------
// remote-motion

/** Documents what bot A's page can see of a remote player. v2 publishes every player's row in
 * window.__mogGame.store (subscriptions cover every player), so a remote *position* IS
 * reachable now (unlike the pre-rewrite __playerDebug/__gameDebug split, which was local-only)
 * — this now reports remoteCount and the store's playerTransform size directly instead of the
 * old GAP note. */
async function probeRemoteVisibility(pageA: Page): Promise<string> {
  return (await pageA.evaluate(() => {
    const game = (window as unknown as {
      __mogGame?: { remoteCount: number; store: Record<string, Map<string, unknown>> };
    }).__mogGame;
    if (!game) return 'no __mogGame on A';
    const transformRows = game.store.playerTransform?.size ?? 0;
    return `remoteCount=${game.remoteCount}, store.playerTransform rows=${transformRows} (includes remote players' authoritative position — readable via readStoreField(page, 'playerTransform', <field>, <remoteIdentityHex>))`;
  })) as string;
}

async function runRemoteMotion(browser: Browser, cfg: SessionConfig, notes: string[]): Promise<RunData[]> {
  const scfg = scenarioCfg(cfg, 'perf-remotemotion');
  // Sessions open inside the try so a failure opening the second doesn't
  // leak the first (the finally closes whatever was actually opened).
  const sessions: BotSession[] = [];
  const runsBySession = new Map<BotSession, RunData>();
  try {
    const botA = await openBotSession(browser, 'a', scfg);
    sessions.push(botA);
    const botB = await openBotSession(browser, 'b', scfg);
    sessions.push(botB);
    await joinAs(botA, scfg);
    await waitForRenderLoop(botA.page, scfg.joinTimeoutMs);
    await joinAs(botB, scfg);
    await waitForRenderLoop(botB.page, scfg.joinTimeoutMs);

    // The mover must hold pointer lock or its movement never happens: keydowns are
    // ignored unless document.pointerLockElement === document.body (intents.ts). Without
    // this the "walk" phase moves nobody. The observer (A) stays AFK and unlocked by design.
    await acquirePointerLock(botB.page);

    // Baseline while both stand still.
    await setPhase(botB.page, 'remote_baseline');
    await tracedPhase(botA, scfg, 'remote_baseline', () => botA.page.waitForTimeout(BASELINE_MS));

    notes.push(`remote-motion: ${await probeRemoteVisibility(botA.page)}`);

    // B walks continuously while A observes.
    await setPhase(botB.page, 'remote_walk');
    await tracedPhase(botA, scfg, 'remote_motion', () => holdKey(botB.page, 'KeyW', REMOTE_WALK_MS));

    await setPhase(botA.page, 'done');
    await setPhase(botB.page, 'done');
    await botA.page.waitForTimeout(300);

    const runA = await collectRun(botA, scfg);
    const runB = await collectRun(botB, scfg);
    runsBySession.set(botA, runA);
    runsBySession.set(botB, runB);

    // #21 headline: the WS meter turns this observe-a-mover run into the
    // idle-transform / input-policy measurement. Observer A's inbound rate is
    // the transform-receive churn; mover B's outbound rate is the input send
    // rate. The signal is the idle→walk delta on each.
    const wsA = summarizeWsByPhase(runA);
    const wsB = summarizeWsByPhase(runB);
    const hz = (v: number | undefined) => (v === undefined ? '—' : v.toFixed(1));
    const bps = (v: number | undefined) => (v === undefined ? '—' : v.toFixed(0));
    const aIdle = wsA.find((w) => w.phase === 'remote_baseline');
    const aWalk = wsA.find((w) => w.phase === 'remote_motion');
    const bIdle = wsB.find((w) => w.phase === 'remote_baseline');
    const bWalk = wsB.find((w) => w.phase === 'remote_walk');
    notes.push(
      `#21 observer(A) inbound: idle ${hz(aIdle?.inHz)}Hz → walk ${hz(aWalk?.inHz)}Hz ` +
        `(bytes/s ${bps(aIdle?.inBytesPerSec)} → ${bps(aWalk?.inBytesPerSec)}) — idle rate ≈0 means no tick-rate transform churn`,
    );
    notes.push(
      `#21 mover(B) outbound: idle ${hz(bIdle?.outHz)}Hz → walk ${hz(bWalk?.outHz)}Hz — idle ≈0 with moving sustained is the #6 input policy`,
    );

    return [runA, runB];
  } catch (err) {
    for (const session of sessions) await saveFailureDiagnostics(session, scfg);
    throw err;
  } finally {
    for (const session of [...sessions].reverse()) {
      await closeSession(session, runsBySession.get(session));
    }
  }
}

// ---------------------------------------------------------------------------
// orchestration

export async function runPerf(browser: Browser, cfg: SessionConfig): Promise<PerfResult> {
  const runs: RunData[] = [];
  const issues: string[] = [];
  const notes: string[] = [];

  // Optional filter: QA_PERF_SCENARIOS=cold-load,first-cast (default: all).
  const wanted = new Set(
    (process.env.QA_PERF_SCENARIOS ?? 'cold-load,first-cast,player-join,remote-motion')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  async function runScenario(name: string, fn: () => Promise<RunData[] | RunData>) {
    if (!wanted.has(name)) {
      console.log(`[perf] skip ${name} (not in QA_PERF_SCENARIOS)`);
      return;
    }
    console.log(`[perf] ${name}`);
    try {
      const result = await fn();
      if (Array.isArray(result)) runs.push(...result);
      else runs.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push(`${name}: ${message}`);
      console.error(`[perf] ${name} FAILED: ${message}`);
      // Continue remaining scenarios so cold-load / first-cast reports still land.
    }
  }

  await runScenario('cold-load', async () => [await runColdLoad(browser, cfg, 'a')]);
  await runScenario('first-cast', async () => [await runFirstCast(browser, cfg)]);
  await runScenario('player-join', async () => runPlayerJoin(browser, cfg, notes));
  await runScenario('remote-motion', async () => runRemoteMotion(browser, cfg, notes));

  return { runs, issues, notes };
}
