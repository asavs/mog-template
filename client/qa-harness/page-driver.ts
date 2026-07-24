/**
 * Shared page-session machinery: everything about driving one bot's browser
 * page (collectors, join flow, pointer lock, structural waits, telemetry
 * reads, failure diagnostics), independent of which scenario is driving it.
 * run-harness.ts uses this for single-bot phase runs; duel.ts opens two
 * sessions at once.
 */
import type { Browser, BrowserContext, Page, Video } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { joinPresetButtonLabel } from '../src/components/characterConfig';
import type { CharacterClass, InputEvent, RunData, TraceRecord, Vec3 } from './trace-types';
import { collectPerf, installPerfCollectors } from './perf-collectors';

export type SessionConfig = {
  clientUrl: string;
  stdbUrl?: string;
  joinTimeoutMs: number;
  runsDir: string;
  runLabel: string;
};

export type BotSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  characterClass: CharacterClass;
  consoleTail: string[];
  startedAt: string;
  startedAtWallTimeMs: number;
  videoStartedWallTimeMs?: number;
  video?: Video | null;
  traceTempPaths?: Record<string, string>;
};

const RECORD_VIDEO = process.env.QA_VIDEO !== '0';
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'v8.execute',
  'blink.user_timing',
  'gpu',
];

// Injected into the page before any app script runs. Collects one record per
// rendered frame (so the trace reflects actual useFrame ticks, not an
// arbitrary polling interval) and every input event the page receives, both
// on the same performance.now() clock.
export function installCollectors() {
  const w = window as unknown as {
    __qaTrace: TraceRecord[];
    __qaEvents: InputEvent[];
    __qaPhase: string;
    __qaTimeAnchor: { wallTimeMs: number; performanceNowMs: number };
    __playerDebug?: Record<string, unknown>;
  };
  w.__qaTrace = [];
  w.__qaEvents = [];
  w.__qaPhase = 'startup';
  w.__qaTimeAnchor = { wallTimeMs: Date.now(), performanceNowMs: performance.now() };

  const record = (kind: InputEvent['kind'], detail: string) => {
    w.__qaEvents.push({ t: performance.now(), kind, detail });
  };
  window.addEventListener('keydown', (e) => { if (!e.repeat) record('keydown', e.code); }, true);
  window.addEventListener('keyup', (e) => record('keyup', e.code), true);
  window.addEventListener('mousedown', (e) => record('mousedown', `button${e.button}`), true);
  window.addEventListener('mouseup', (e) => record('mouseup', `button${e.button}`), true);
  document.addEventListener('pointerlockchange', () => {
    record('pointerlockchange', document.pointerLockElement ? 'locked' : 'unlocked');
  }, true);

  const tick = () => {
    const debug = w.__playerDebug;

    const toPlain = (v: unknown) => {
      if (!v || typeof v !== 'object') return null;
      const vec = v as { x: number; y: number; z: number };
      return { x: vec.x, y: vec.y, z: vec.z };
    };

    // Game-state channels are whatever the client publishes — no key names
    // are known here (see useQaGameDebug.ts for the contract).
    const gameDebug = (window as unknown as { __gameDebug?: Record<string, unknown> }).__gameDebug;
    let channels: Record<string, number> | null = null;
    if (gameDebug) {
      channels = {};
      for (const [key, value] of Object.entries(gameDebug)) {
        if (typeof value === 'number' && !Number.isNaN(value)) channels[key] = value;
        else if (typeof value === 'boolean') channels[key] = value ? 1 : 0;
      }
    }

    w.__qaTrace.push({
      t: performance.now(),
      phase: w.__qaPhase,
      simPosition: toPlain(debug?.simPosition),
      renderPosition: toPlain(debug?.renderPosition),
      visualOffset: toPlain(debug?.visualOffset),
      offsetLength: typeof debug?.offsetLength === 'number' ? debug.offsetLength : null,
      cameraPosition: toPlain(debug?.cameraPosition),
      localServerTick: debug?.localServerTick != null ? String(debug.localServerTick) : null,
      localCorrectionError: typeof debug?.localCorrectionError === 'number' ? debug.localCorrectionError : null,
      channels,
    });

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export async function openBotSession(
  browser: Browser,
  characterClass: CharacterClass,
  cfg: SessionConfig,
): Promise<BotSession> {
  const startedAtWallTimeMs = Date.now();
  if (RECORD_VIDEO) fs.mkdirSync(cfg.runsDir, { recursive: true });
  // QA_VIEWPORT=WIDTHxHEIGHT (e.g. 640x360) shrinks the render surface —
  // software-rendered CI (SwiftShader) pays per pixel, so a quarter-size
  // viewport is the difference between the rAF loop crawling and ticking.
  // Local GPU runs leave it unset (Playwright's default viewport).
  const viewportMatch = /^(\d+)x(\d+)$/.exec(process.env.QA_VIEWPORT ?? '');
  const context = await browser.newContext({
    ...(RECORD_VIDEO ? { recordVideo: { dir: cfg.runsDir } } : {}),
    ...(viewportMatch
      ? { viewport: { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) } }
      : {}),
  });
  const page = await context.newPage();
  const videoStartedWallTimeMs = RECORD_VIDEO ? Date.now() : undefined;
  const video = page.video();
  // Playwright's 30s default action timeout is not enough while SwiftShader
  // digests the scene; align every implicit wait with the structural budget.
  page.setDefaultTimeout(cfg.joinTimeoutMs);
  await page.addInitScript(installCollectors);
  // Perf instrumentation runs alongside the frame trace, injected the same way
  // (before any app script) so it captures cold-load stalls too. Harness-side
  // only — the game is never modified. See perf-collectors.ts.
  await page.addInitScript(installPerfCollectors);

  const consoleTail: string[] = [];
  page.on('console', (msg) => {
    consoleTail.push(`[${msg.type()}] ${msg.text()}`);
    if (consoleTail.length > 200) consoleTail.shift();
  });
  page.on('pageerror', (err) => {
    consoleTail.push(`[pageerror] ${err.message}`);
    console.error(`[${characterClass}] pageerror:`, err.message);
  });

  return {
    browser,
    context,
    page,
    characterClass,
    consoleTail,
    startedAt: new Date(startedAtWallTimeMs).toISOString(),
    startedAtWallTimeMs,
    videoStartedWallTimeMs,
    video,
  };
}
export async function setPhase(page: Page, phase: string) {
  await page.evaluate((p) => {
    const w = window as unknown as { __qaPhase: string; __qaEvents: InputEvent[] };
    w.__qaPhase = p;
    w.__qaEvents.push({ t: performance.now(), kind: 'phase', detail: p });
  }, phase);
}

export async function joinAs(session: BotSession, cfg: SessionConfig) {
  const { page, characterClass } = session;
  // Force the runtime QA gate (?qa) so window.__gameDebug channels exist even
  // when the web server wasn't started with VITE_QA_MODE (e.g. preview builds).
  const url = new URL(cfg.clientUrl);
  if (!url.searchParams.has('qa')) url.searchParams.set('qa', '');
  if (cfg.stdbUrl) url.searchParams.set('stdb', cfg.stdbUrl);
  await page.goto(url.toString(), { waitUntil: 'networkidle' });
  await page.waitForSelector('#username', { timeout: cfg.joinTimeoutMs });
  await page.locator('#username').fill(`QaBot-${characterClass}-${Date.now()}`);
  await page
    .getByRole('button', { name: joinPresetButtonLabel(characterClass), exact: true })
    .click();
  await page.getByRole('button', { name: 'Join Game' }).click();
  await page.waitForFunction(() => !!(window as unknown as { __playerDebug?: unknown }).__playerDebug, { timeout: cfg.joinTimeoutMs });
}

export async function acquirePointerLock(page: Page) {
  // Already locked: skip the engaging click, which doubles as an attack and
  // freezes camera rotation for the swing duration.
  const alreadyLocked = await page.evaluate(() => document.pointerLockElement === document.body);
  if (alreadyLocked) return true;
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  const center = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : { x: 640, y: 360 };
  // requestPointerLock rejects with "root document is not valid for pointer
  // lock" when the window isn't OS-focused — a real race when multiple headed
  // Chromium windows are open (duel mode, sequential class runs). Bring the
  // window to front and retry a few times before giving up.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.bringToFront();
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(200);
    const locked = await page.evaluate(() => document.pointerLockElement === document.body);
    if (locked) return true;
    await page.waitForTimeout(300);
  }
  console.warn('[page-driver] pointer lock did not engage; camera-look and spell-aim will not track mouse input.');
  return false;
}

// The render loop can stall for a long time right after join while terrain
// geometry/textures upload (minutes under CI's SwiftShader). Don't drive
// input until the rAF loop is demonstrably ticking again.
export async function waitForRenderLoop(page: Page, timeoutMs: number) {
  // QA_RENDER_READY_FRAMES: how many new rAF frames prove the loop is
  // ticking. 30 is instant on a GPU but can outlast any sane timeout at
  // SwiftShader frame rates, so CI lowers it — the point is only to prove
  // the loop is alive, not to measure it.
  const parsed = Number(process.env.QA_RENDER_READY_FRAMES ?? '30');
  const readyFrames = Number.isFinite(parsed) && parsed >= 1 ? parsed : 30;
  const start = (await page.evaluate(
    () => (window as unknown as { __qaTrace: unknown[] }).__qaTrace.length,
  )) as number;
  await page.waitForFunction(
    (args) =>
      (window as unknown as { __qaTrace: unknown[] }).__qaTrace.length >= args.start + args.readyFrames,
    { start, readyFrames },
    { timeout: timeoutMs },
  );
  // Proving rAF is alive isn't enough: heavy chunks can keep lazy-loading for
  // a while after (#217), stalling frames mid-phase and producing truncated
  // phase captures plus reconciliation snaps that read as teleports. Require
  // a full second of steady cadence before driving input. "Steady" is
  // environment-relative — QA_RENDER_READY_FRAMES already encodes what a
  // healthy rate is here (SwiftShader CI never reaches GPU frame rates), so
  // reuse it as frames-per-second. Cap the wait well below the job timeout:
  // an environment that never steadies should degrade to a warning, not eat
  // the whole run.
  const steadyFps = Math.min(45, readyFrames);
  const deadline = Date.now() + Math.min(timeoutMs, 60_000);
  while (Date.now() < deadline) {
    const before = (await page.evaluate(
      () => (window as unknown as { __qaTrace: unknown[] }).__qaTrace.length,
    )) as number;
    await page.waitForTimeout(1000);
    const after = (await page.evaluate(
      () => (window as unknown as { __qaTrace: unknown[] }).__qaTrace.length,
    )) as number;
    if (after - before >= steadyFps) return;
  }
  console.warn('[page-driver] render loop never reached steady cadence; phase captures may be truncated.');
}

/** Current local-player telemetry, for cross-page scenario logic (aiming). */
export async function readPlayerState(page: Page): Promise<{ sim: Vec3 | null; cam: Vec3 | null }> {
  return (await page.evaluate(() => {
    const debug = (window as unknown as { __playerDebug?: { simPosition?: unknown; cameraPosition?: unknown } }).__playerDebug;
    const toPlain = (v: unknown) => {
      if (!v || typeof v !== 'object') return null;
      const vec = v as { x: number; y: number; z: number };
      return { x: vec.x, y: vec.y, z: vec.z };
    };
    return { sim: toPlain(debug?.simPosition), cam: toPlain(debug?.cameraPosition) };
  })) as { sim: Vec3 | null; cam: Vec3 | null };
}

/** One game-state channel's current value (null if not published). */
export async function readGameChannel(page: Page, key: string): Promise<number | null> {
  return (await page.evaluate((k) => {
    const gameDebug = (window as unknown as { __gameDebug?: Record<string, unknown> }).__gameDebug;
    const value = gameDebug?.[k];
    if (typeof value === 'number' && !Number.isNaN(value)) return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return null;
  }, key)) as number | null;
}

export async function collectRun(session: BotSession, cfg: SessionConfig): Promise<RunData> {
  const { frames, events, timeAnchor } = (await session.page.evaluate(() => {
    const w = window as unknown as {
      __qaTrace: TraceRecord[];
      __qaEvents: InputEvent[];
      __qaTimeAnchor?: { wallTimeMs: number; performanceNowMs: number };
    };
    return { frames: w.__qaTrace, events: w.__qaEvents, timeAnchor: w.__qaTimeAnchor };
  })) as {
    frames: TraceRecord[];
    events: InputEvent[];
    timeAnchor?: { wallTimeMs: number; performanceNowMs: number };
  };

  const perf = await collectPerf(session.page);

  return {
    meta: {
      version: 2,
      characterClass: session.characterClass,
      label: cfg.runLabel,
      startedAt: session.startedAt,
      clientUrl: cfg.clientUrl,
      ...(timeAnchor
        ? {
            time: {
              collectorWallTimeMs: timeAnchor.wallTimeMs,
              collectorPerformanceNowMs: timeAnchor.performanceNowMs,
              sessionStartedWallTimeMs: session.startedAtWallTimeMs,
              ...(session.videoStartedWallTimeMs !== undefined
                ? { videoStartedWallTimeMs: session.videoStartedWallTimeMs }
                : {}),
            },
          }
        : {}),
    },
    frames,
    events,
    perf,
  };
}

// On any failure, capture what the page actually looked like and what it
// logged — without this, a CI timeout says nothing about whether the page
// was stuck connecting, mid-asset-load, or crashed.
export async function saveFailureDiagnostics(session: BotSession, cfg: SessionConfig) {
  fs.mkdirSync(cfg.runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(cfg.runsDir, `${stamp}-${cfg.runLabel}-${session.characterClass}-failure`);
  // Console tail first — the screenshot needs the page's main thread, which
  // is often exactly what's wedged when we get here.
  fs.writeFileSync(`${base}-console.log`, session.consoleTail.join('\n'));
  try {
    await session.page.screenshot({ path: `${base}.png`, timeout: 10000 });
    console.error(`[page-driver] wrote failure diagnostics -> ${base}.png / ${base}-console.log`);
  } catch {
    console.error(`[page-driver] page too wedged to screenshot; wrote ${base}-console.log`);
  }
}

export async function captureChromeTrace<T>(
  session: BotSession,
  cfg: SessionConfig,
  phase: string,
  capture: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (!capture) return await fn();

  fs.mkdirSync(cfg.runsDir, { recursive: true });
  const safePhase = phase.replace(/[^a-zA-Z0-9_.-]/g, '_');
  const tempPath = path.join(
    cfg.runsDir,
    `.autotrace-${Date.now()}-${cfg.runLabel}-${session.characterClass}-${safePhase}.trace.json`,
  );

  let tracing = false;
  try {
    await session.browser.startTracing(session.page, {
      path: tempPath,
      categories: TRACE_CATEGORIES,
      screenshots: false,
    });
    tracing = true;
  } catch (err) {
    console.warn(`[page-driver] Chrome trace unavailable for ${phase}: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    return await fn();
  } finally {
    if (tracing) {
      try {
        await session.browser.stopTracing();
        session.traceTempPaths = { ...session.traceTempPaths, [phase]: tempPath };
      } catch (err) {
        console.warn(`[page-driver] Chrome trace stop failed for ${phase}: ${err instanceof Error ? err.message : String(err)}`);
        try {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }
}

export function attachSessionArtifacts(session: BotSession, run: RunData) {
  if (!session.traceTempPaths || Object.keys(session.traceTempPaths).length === 0) return;
  run.artifacts = { ...run.artifacts, autoTraceTempPaths: session.traceTempPaths };
}

export async function closeSession(session: BotSession, run?: RunData) {
  const video = session.video;
  try {
    await session.page.close();
  } catch {
    /* context.close below is the authoritative teardown */
  }
  await session.context.close();

  if (run) {
    attachSessionArtifacts(session, run);
  } else {
    for (const tempPath of Object.values(session.traceTempPaths ?? {})) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  if (!video) return;
  try {
    const videoPath = await video.path();
    if (run) run.artifacts = { ...run.artifacts, videoTempPath: videoPath };
    else if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  } catch (err) {
    console.warn(`[page-driver] video capture unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}
