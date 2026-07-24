/**
 * Performance profiling scenarios. Each drives a real session (or two, like
 * duel.ts) and leans on the always-on perf collectors (perf-collectors.ts,
 * injected in openBotSession) plus the frame trace. The game is never
 * modified; everything is observed from standard browser APIs.
 *
 * Scenarios (see README perf section):
 *  - cold-load: fresh context → goto → join, landmarked; both classes.
 *  - first-cast: idle baseline, then fireball×2 and lightning×2 with a
 *    per-cast phase window — first-vs-second delta is the headline.
 *  - player-join: bot A steady-state, then bot B joins the same world;
 *    measure A's stall in the window after B appears vs its baseline.
 *  - remote-motion: bot B walks ~10s while bot A observes. A's page exposes
 *    only its OWN __playerDebug (no remote render positions), so B's rendered
 *    position on A's page is not reachable — documented as a gap.
 *
 * Perf numbers are reported against budgets; failures only gate with QA_PERF_ENFORCE=1.
 */
import type { Browser, Page } from 'playwright';
import { joinPresetButtonLabel } from '../src/components/characterConfig';
import type { CharacterClass, LoadLandmarks, RunData } from './trace-types';
import { summarizeWsByPhase } from './perf-stats';
import {
  acquirePointerLock,
  captureChromeTrace,
  closeSession,
  collectRun,
  joinAs,
  openBotSession,
  readGameChannel,
  saveFailureDiagnostics,
  setPhase,
  waitForRenderLoop,
  type BotSession,
  type SessionConfig,
} from './page-driver';

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

async function tapKey(page: Page, code: string, ms = 120) {
  await page.keyboard.down(code);
  await page.waitForTimeout(ms);
  await page.keyboard.up(code);
}

async function holdKey(page: Page, code: string, ms: number) {
  await page.keyboard.down(code);
  await page.waitForTimeout(ms);
  await page.keyboard.up(code);
}

async function click(page: Page) {
  await page.mouse.down();
  await page.mouse.up();
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
  const { page, characterClass } = session;
  const url = new URL(cfg.clientUrl);
  if (!url.searchParams.has('qa')) url.searchParams.set('qa', '');

  const t0 = Date.now();
  await page.goto(url.toString(), { waitUntil: 'networkidle' });
  await page.waitForSelector('#username', { timeout: cfg.joinTimeoutMs });
  const tJoinScreen = Date.now();

  await page.locator('#username').fill(`QaBot-${characterClass}-${Date.now()}`);
  await page
    .getByRole('button', { name: joinPresetButtonLabel(characterClass), exact: true })
    .click();

  const tClick = Date.now();
  await page.getByRole('button', { name: 'Join Game' }).click();
  await page.waitForFunction(
    () => !!(window as unknown as { __playerDebug?: unknown }).__playerDebug,
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

async function runColdLoad(
  browser: Browser,
  cfg: SessionConfig,
  characterClass: CharacterClass,
): Promise<RunData> {
  const scfg = scenarioCfg(cfg, 'perf-coldload');
  const session = await openBotSession(browser, characterClass, scfg);
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
// first-cast

async function runFirstCast(browser: Browser, cfg: SessionConfig): Promise<RunData> {
  const scfg = scenarioCfg(cfg, 'perf-firstcast');
  const session = await openBotSession(browser, 'wizard', scfg);
  let run: RunData | undefined;
  try {
    await joinAs(session, scfg);
    await waitForRenderLoop(session.page, scfg.joinTimeoutMs);
    await acquirePointerLock(session.page);
    const { page } = session;

    // Steady-state baseline before any cast.
    await tracedPhase(session, scfg, 'steady_baseline', () => page.waitForTimeout(BASELINE_MS));

    // Fireball (spell 1): select, then two casts CAST_WINDOW_MS apart. Each
    // cast owns its own phase window so first-vs-second is a phase comparison.
    await tapKey(page, 'Digit1');
    await tracedPhase(session, scfg, 'fireball_1', async () => {
      await click(page);
      await page.waitForTimeout(CAST_WINDOW_MS);
    });
    await tracedPhase(session, scfg, 'fireball_2', async () => {
      await click(page);
      await page.waitForTimeout(CAST_WINDOW_MS);
    });

    // Lightning (spell 2): same structure.
    await tapKey(page, 'Digit2');
    await tracedPhase(session, scfg, 'lightning_1', async () => {
      await click(page);
      await page.waitForTimeout(CAST_WINDOW_MS);
    });
    await tracedPhase(session, scfg, 'lightning_2', async () => {
      await click(page);
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

async function runPlayerJoin(
  browser: Browser,
  cfg: SessionConfig,
  notes: string[],
): Promise<RunData[]> {
  const scfg = scenarioCfg(cfg, 'perf-playerjoin');
  // Sessions are pushed the moment they open (including B, opened mid-phase),
  // so the finally closes exactly the sessions that actually exist even when
  // a later step of the same phase throws.
  const sessions: BotSession[] = [];
  const runsBySession = new Map<BotSession, RunData>();
  try {
    const botA = await openBotSession(browser, 'wizard', scfg);
    sessions.push(botA);
    await joinAs(botA, scfg);
    await waitForRenderLoop(botA.page, scfg.joinTimeoutMs);

    await tracedPhase(botA, scfg, 'pre_join_baseline', () => botA.page.waitForTimeout(BASELINE_MS));
    const onlineBefore = await readGameChannel(botA.page, 'playersOnline');

    // B connects; A stays in a distinct window while the connection/subscription
    // and the new remote player's assets come in.
    const botB = await tracedPhase(botA, scfg, 'b_joining', async () => {
      const b = await openBotSession(browser, 'paladin', scfg);
      sessions.push(b);
      await joinAs(b, scfg);
      await waitForRenderLoop(b.page, scfg.joinTimeoutMs);
      return b;
    });

    await tracedPhase(botA, scfg, 'after_b_join', () => botA.page.waitForTimeout(POST_JOIN_MS));
    const onlineAfter = await readGameChannel(botA.page, 'playersOnline');
    notes.push(
      `player-join: bot A playersOnline ${onlineBefore ?? '—'} → ${onlineAfter ?? '—'} across B's join`,
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

/**
 * Scans bot A's page for any global that could expose a *remote* player's
 * rendered position. The master client publishes only the local player's
 * __playerDebug and local game-state channels via __gameDebug, so this is
 * expected to find nothing — the return value documents the gap.
 */
async function probeRemotePositionChannel(pageA: Page): Promise<string[]> {
  return (await pageA.evaluate(() => {
    const w = window as unknown as {
      __gameDebug?: Record<string, unknown>;
      __playerDebug?: Record<string, unknown>;
    };
    const found: string[] = [];
    const gd = w.__gameDebug ?? {};
    for (const k of Object.keys(gd)) {
      if (/remote|other|pos|position|x$|z$/i.test(k)) found.push(`__gameDebug.${k}`);
    }
    // __playerDebug is local-only by contract; list its keys so the report can
    // show exactly what *was* available on A's page.
    const pd = w.__playerDebug ?? {};
    for (const k of Object.keys(pd)) found.push(`__playerDebug.${k}(local)`);
    return found;
  })) as string[];
}

async function runRemoteMotion(
  browser: Browser,
  cfg: SessionConfig,
  notes: string[],
): Promise<RunData[]> {
  const scfg = scenarioCfg(cfg, 'perf-remotemotion');
  // Sessions open inside the try so a failure opening the second doesn't
  // leak the first (the finally closes whatever was actually opened).
  const sessions: BotSession[] = [];
  const runsBySession = new Map<BotSession, RunData>();
  try {
    const botA = await openBotSession(browser, 'wizard', scfg);
    sessions.push(botA);
    const botB = await openBotSession(browser, 'paladin', scfg);
    sessions.push(botB);
    await joinAs(botA, scfg);
    await waitForRenderLoop(botA.page, scfg.joinTimeoutMs);
    await joinAs(botB, scfg);
    await waitForRenderLoop(botB.page, scfg.joinTimeoutMs);

    // The mover must hold pointer lock or its movement never happens: keydowns are
    // ignored unless document.pointerLockElement === document.body (useInputManager,
    // useLocalPlayerControls). Without this the "walk" phase moves nobody — the
    // remote stays put (maxRemoteJumpUnits 0) and no transform traffic is published,
    // which silently made #21's measurement meaningless. The observer (A) stays AFK
    // and unlocked by design.
    await acquirePointerLock(botB.page);

    // Baseline while both stand still.
    await setPhase(botB.page, 'remote_baseline');
    await tracedPhase(botA, scfg, 'remote_baseline', () => botA.page.waitForTimeout(BASELINE_MS));

    // Document what A can actually see of B before we rely on it.
    const available = await probeRemotePositionChannel(botA.page);
    const hasRemotePos = available.some((s) => !s.includes('(local)') && s.startsWith('__gameDebug'));
    notes.push(
      hasRemotePos
        ? `remote-motion: candidate remote-position channels on A: ${available.filter((s) => !s.includes('(local)')).join(', ')}`
        : `remote-motion GAP: bot A's page exposes no remote-player render position; only local surfaces available: ${available.join(', ') || '(none)'} — B's rendered position per frame on A is not measurable without a game change.`,
    );

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

  console.log('[perf] cold-load (wizard, paladin)');
  runs.push(await runColdLoad(browser, cfg, 'wizard'));
  runs.push(await runColdLoad(browser, cfg, 'paladin'));

  console.log('[perf] first-cast (wizard: fireball×2, lightning×2)');
  runs.push(await runFirstCast(browser, cfg));

  console.log('[perf] player-join (bot A wizard, bot B paladin)');
  runs.push(...(await runPlayerJoin(browser, cfg, notes)));

  console.log('[perf] remote-motion (bot B walks, bot A observes)');
  runs.push(...(await runRemoteMotion(browser, cfg, notes)));

  return { runs, issues, notes };
}
