/**
 * `input_churn` — the rubberband detector.
 *
 * Mechanises the one movement complaint a human reproduces in seconds and every
 * existing harness phase misses: *"I log in and spam wadwadwadwdas and I expect it
 * to be smooth and it's not, and then when I let go of WASD I teleport around more
 * for a moment."*
 *
 * Why the existing phases never caught it: `walk_forward` and friends hold ONE key
 * for 750ms, and `direction_change` changes direction three times in 1.8s. Both are
 * far slower than a hand on WASD, and neither measures the moment AFTER the keys come
 * up. This scenario drives alternating direction keys at three cadences (80/150/300ms)
 * with overlapping holds — real fingers overlap, they do not hand off cleanly — and then
 * RELEASES EVERYTHING and holds still, because the post-release window is where the
 * user sees the worst of it.
 *
 * ## What it asserts (hard, not report-only)
 *
 * All three bounds are PHYSICAL, derived from the sim's own `PLAYER_SPEED`, so they
 * mean the same thing on any machine at any frame rate — no recorded baseline to drift:
 *
 *  a. `frame-jump` — the rendered position may never travel faster than the sim's own top
 *     speed, measured over any window of at least `FRAME_JUMP_WINDOW_MS`. Catches teleports.
 *  b. `settle` — once the keys are up and the first `SETTLE_GRACE_MS` have passed, the
 *     rendered position must be *finished*: not one further displacement event. Catches
 *     the "teleport around more for a moment" tail directly.
 *  c. `path-inflation` — total rendered path over a churn window may not exceed what
 *     `PLAYER_SPEED` could have drawn in that window. Catches oscillation/vibration,
 *     which inflates path length without inflating net displacement.
 *  d. `prediction-lead` — the sharpest of the four, and the only one that reads the
 *     mechanism rather than the symptom: a reconcile must REPLAY the predicted ticks the
 *     server has not acked. Replaying none means prediction was discarded and the render
 *     snapped onto a stale authoritative position; replaying dozens means the render is
 *     running seconds ahead of it. Measured 52-100% zero-replay before the fix, 0-16% after.
 *
 * Every tolerance is anchored to a measurement, and every one carries the before/after
 * numbers it sits between in its own doc comment. `CALIBRATION` below records the clean
 * straight-line-walk reference the frame-level ones start from.
 *
 * ## What it records
 *
 * Beyond the rendered position, every frame carries `reconcile` (`trace-types.ts`'s
 * `ReconcileRecord`, published by `client/src/game/frame.ts`), so a failure names its own
 * mechanism instead of leaving a bisect: `lastCorrectionDropped` spiking while
 * `lastCorrectionReplayed` collapses to zero is in-flight prediction being discarded;
 * an alternating-sign `visualOffset` at steady replay counts is correction-offset
 * oscillation.
 *
 * ## Running it
 *
 *   npm run qa:harness -- (churn phases are in the default registry, 0ms latency)
 *   QA_MODE=churn npm run qa:harness   (full sweep: 0 / 100 / 200ms via net-proxy.ts)
 *
 * CDP network emulation does not delay already-established WebSockets, so injected
 * latency must come from `net-proxy.ts`'s real socket hop — never `Network.emulateNetworkConditions`.
 */
import type { Page } from 'playwright';
import { PLAYER_SPEED } from '../src/sim/locomotion.ts';
import { acquirePointerLock } from './page-driver';
import type { PhaseDef } from './phase-helpers';
import type { ReconcileRecord, TraceRecord, Vec3 } from './trace-types';

/**
 * Nothing in a churn window binds sprint (`input/keymap.ts` binds no sprint key), and no
 * ability is pressed, so `PLAYER_SPEED` — not the sprint multiple, and not roll's
 * `displace_self` — is the true ceiling on how fast the local player can move.
 */
export const CHURN_MAX_SPEED = PLAYER_SPEED;

/**
 * The predictor's fixed tick period (`frame.ts`'s `TICK_DT`). The rendered local player
 * advances in whole 50ms sim ticks, so at 180fps most frames move zero and every ~9th
 * moves a full tick's 0.3m — measured on a clean `walk_forward` hold, worst single-frame
 * displacement 0.342m at dt≈5.6ms. A naive `speed * dt` bound therefore flags ordinary
 * healthy movement at ~3.4x on any machine fast enough to render above 20fps. The
 * frame-jump bound below allows one tick quantum as its floor for exactly this reason;
 * see FRAME_JUMP_SLACK.
 */
const TICK_DT_SECONDS = 1 / 20;

/**
 * Per switch. 80ms is faster than a person can reliably alternate; 300ms is a relaxed
 * strafe-dance. The middle value is roughly what "wadwadwad" measures out to.
 */
export const CHURN_CADENCES_MS = [80, 150, 300] as const;

/** Per cadence. Long enough for latency-dependent drift to accumulate, short enough to sweep 3x. */
const CHURN_DURATION_MS = 10_000;
/** Post-release stillness. The user's "teleport around more for a moment" lives here. */
const SETTLE_DURATION_MS = 3_000;
/**
 * How long after the last key comes up the rendered position is still allowed to be
 * moving. It legitimately is: in-flight input is still being acked and the visual
 * correction offset is still decaying (`VISUAL_CORRECTION_DECAY_RATE` = 12/s, so a
 * correction is ~99% gone in 400ms). Past this, a healthy client is simply parked.
 */
const SETTLE_GRACE_MS = 500;

/**
 * A real hand presses the next direction before the last one is fully up. Handing off
 * cleanly (up-then-down) is the ONE thing that never reproduces the complaint, so the
 * overlap is not incidental — it is the point.
 */
const OVERLAP_FRACTION = 1 / 3;

/**
 * The direction ring. Deliberately includes opposing pairs back to back (W then S,
 * A then D): under overlap those hold simultaneously for a moment and cancel, which is
 * exactly the movement→idle→movement boundary where in-flight predicted ticks are
 * most likely to be mishandled.
 */
const CHURN_KEYS = ['KeyW', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyS'] as const;

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Measured on a clean straight-line `KeyW` hold at 0ms injected latency, local GPU,
 * against `public/v2/essential-template` — the reference every tolerance below is
 * anchored to rather than guessed at. Kept here so a future re-tune can see what the
 * healthy numbers actually were instead of re-deriving them.
 */
export const CALIBRATION = {
  /**
   * Worst single-frame rendered displacement over a clean straight-line walk, in metres.
   * This is one tick quantum (`PLAYER_SPEED * TICK_DT` = 0.300m) plus float noise — the
   * predictor renders whole 50ms ticks, so the ceiling below is anchored to the tick,
   * not to the frame.
   */
  worstWalkFrameMeters: 0.342,
  /** The frame `dt` that displacement landed on — 180fps, i.e. ~9 frames per sim tick. */
  worstWalkFrameDtMs: 5.6,
  /** Worst single-frame rendered displacement over a settled, no-input window, in metres. */
  worstStillFrameMeters: 0.001,
  /** `renderedPath / (PLAYER_SPEED * elapsed)` over a clean single-direction hold. */
  worstWalkPathInflation: 1.02,
} as const;

/**
 * The window the frame-jump bound measures rendered speed over. It is deliberately NOT one
 * frame.
 *
 * `predictPendingTicks` advances the sim in whole 50ms ticks and `stepFrame` renders
 * `local.position + offset` directly, so the rendered position moves in 0.3m quanta no
 * matter the frame rate: above 20fps most frames render zero and the one that crosses a
 * tick boundary renders the whole quantum (CALIBRATION: 0.342m at dt=5.6ms). Worse, when a
 * frame runs long the ticks it accrued are flushed by the NEXT, short frame — measured
 * live at 0.781m rendered in a 5.8ms frame immediately after an 83ms one. Neither is a
 * teleport; both are unavoidable artifacts of a fixed-tick predictor, and a per-frame
 * `speed * dt` bound flags them at 1.6-3.4x on any healthy machine.
 *
 * Two ticks of window is long enough for the quantization and the scheduler jitter to
 * average out, and short enough that a real teleport has nowhere to hide: the 1.3s stall
 * recovery this detector caught rendered 4.7m, ~90u/s against a 6u/s ceiling.
 */
const FRAME_JUMP_WINDOW_MS = 100;
/**
 * Multiple of `PLAYER_SPEED * windowElapsed` the rendered path may reach inside that window.
 *
 * Not 1.0, because the rendered position is `sim + visualCorrectionOffset` and BOTH terms
 * move: while a correction glides out, the render travels at walk speed plus the glide rate.
 * `VISUAL_CORRECTION_DECAY_RATE` is 12/s, so an offset of ~0.6m — the size of a routine churn
 * correction at 200ms, measured — adds up to 7.2u/s on top of 6u/s, i.e. ~2.2x, for as long as
 * the glide lasts. Healthy post-fix runs peak at 1.51x; before the fix, 2.00x.
 *
 * 2.5 is therefore a TELEPORT bound, not a churn-defect bound — it does not separate the two
 * versions, and it is not meant to. `prediction-lead` and `path-inflation` are what catch the
 * defect; this catches the thing no amount of latency should ever produce. It fired for real
 * exactly once during this wave, on the 1.3s-stall resync at ~90u/s (see
 * `MAX_MEASURED_FRAME_DT_MS`, now exempt).
 */
const FRAME_JUMP_SLACK = 2.5;
/**
 * Absolute floor added to the window allowance so a degenerate window (frames landing
 * inside the same millisecond) can't produce a ~0 allowance and fail on float noise.
 */
const FRAME_JUMP_EPSILON_METERS = 0.05;
/**
 * What counts as "moved" during the settle window. ~50x the worst clean-stillness frame
 * (CALIBRATION.worstStillFrameMeters) — comfortably above float noise, and 1/6th of one
 * tick of walking (0.3m), so any displacement a human could perceive as a twitch trips it.
 */
const STILL_EPSILON_METERS = 0.05;
/**
 * Path-length ceiling as a multiple of `PLAYER_SPEED * elapsed`. A clean single-direction
 * hold measured 1.02: a rendered path can slightly exceed the ideal because a correction
 * glide moves the render while the sim also moves it.
 *
 * Measured across the 0/100/200ms sweep — before the fix, 1.24 / 1.44 / 1.66 / 1.48 / 1.39 /
 * 1.60 / 1.83; after, 0.93 / 1.02 / 1.06 / 1.07 / 1.09 / 1.16 / 1.20. 1.35 sits in the gap
 * with ~12% clearance over healthy and fails 6 of the 9 pre-fix windows outright. The three
 * it does not fail are all at loopback, where there is barely any in-flight prediction to
 * mishandle — that tier's repro is carried by `prediction-lead`, which fails all of them.
 */
const PATH_INFLATION_SLACK = 1.35;
/**
 * Total rendered path allowed over an ENTIRE post-release settle window, grace included.
 *
 * The floor here is not ours to set. The client applies an input on ITS tick boundary; the
 * server applies whatever arrived most recently on ITS OWN (`tick.rs::game_tick` reads
 * `player_input.input`, it does not queue by client tick). A direction change that lands
 * between the two boundaries is therefore held for a different number of ticks on each
 * side — up to 0.3m of honest disagreement per switch, and at 200ms RTT with an 80ms
 * cadence there are ~5 switches in flight at any moment. Post-fix worst measured: 1.41m,
 * converging to 0.48m net.
 *
 * 2.0 is a coarse guard against that tail growing (pre-fix worst was 2.37m), NOT the sharp
 * instrument here. Making it sharp needs the server to apply input by the client tick that
 * stamped it, which would let the client predict the exact same tick boundaries — a server
 * change, out of this wave's scope.
 */
const RELEASED_PATH_CEILING_METERS = 2.0;
/**
 * The sharp one.
 *
 * A correction replays the predicted ticks the server has not acked yet; that count IS the
 * client's prediction lead, and at a known latency it has a known value (RTT/50ms, +1 for
 * the send/apply offset). Zero means the reconcile threw away every in-flight tick and
 * rendered the raw authoritative position — which is a stale position, which is the
 * rubberband. It is not a proxy for the defect; it is the defect, counted.
 *
 * Measured, as `zero-replay corrections / corrections` per churn window:
 *   before the fix — 67/130, 135/135, 163/163 (0ms); 109/153, 154/154, 150/150 (200ms)
 *   after          —  19/120,   0/90,    0/85  (0ms);   0/152,   0/160,   0/156  (200ms)
 * i.e. 52-100% before, 0-16% after. 0.30 sits between with ~2x clearance on both sides.
 *
 * The one non-zero post-fix window is the run that also contained the 1.33s stall: losing
 * a second of simulation genuinely does empty the pending buffer for a while.
 *
 * ONLY MEANINGFUL WITH LATENCY, and enforced only then (`ChurnCheckOptions.latencyMs`).
 * A correction that replays nothing is the rubberband because the authoritative position it
 * renders instead is a round trip stale — but on a direct loopback socket the round trip
 * fits inside a single 50ms tick, the server really has processed everything the client
 * predicted, and replaying nothing is the honest answer. Measured on the un-proxied default
 * run after the fix: 0.47 / 0.45 / 0.28, indistinguishable from the pre-fix ratios and just
 * as correct. `MIN_LATENCY_FOR_LEAD_CHECK_MS` is where it starts to mean something.
 */
const MAX_ZERO_REPLAY_RATIO = 0.3;
/**
 * Below one tick of round trip there is no prediction lead to preserve, so there is nothing
 * for `zeroReplayCorrections` to be evidence of. The `QA_MODE=churn` sweep passes the
 * latency it injected; an ordinary un-proxied run passes 0 and the sub-check is skipped
 * (`maxReplayedTicks`, which needs no latency to mean something, still applies).
 */
const MIN_LATENCY_FOR_LEAD_CHECK_MS = 25;
/**
 * The other end of the same bound. Replaying dozens of ticks onto the authoritative position
 * means the client is rebuilding SECONDS of prediction on every correction and rendering that
 * far ahead of truth — the steady-play half of the same defect (measured pre-fix: up to 61
 * ticks replayed per correction during churn, 87-114 during plain walking, which put
 * `walk_forward` 84% past its own top speed). Post-fix worst: 16.
 *
 * 30 ticks is 1.5s of lead — far past any latency this game should be played at, and
 * comfortably clear of the 8-10 seen at 200ms.
 */
const MAX_REPLAYED_TICKS = 30;
/**
 * The anti-vacuity floor: rendered path a churn window must produce for its result to mean
 * anything at all.
 *
 * Every other bound here is an UPPER bound, so a run in which the player never moved
 * satisfies all of them and reports "clean". That is not hypothetical — it happened during
 * this wave. `intents.ts` drops every key edge while the pointer is unlocked (`if
 * (!state.locked) return { state: next, edges: [] }`), and the harness checks pointer lock
 * once, at session start. A browser window that lost focus mid-sweep recorded `path=0.00m`
 * across four consecutive phases and the gate called it clean.
 *
 * A healthy 10s churn window draws 52-72m. 10m is under two seconds of walking: far below any
 * real run, far above anything a genuinely dead one produces. `churnPhases` also re-acquires
 * pointer lock before each window, so this should stay a backstop rather than the thing that
 * fires — but a gate that can pass by doing nothing is not a gate.
 */
const MIN_CHURN_PATH_METERS = 10;
/**
 * A frame gap this long means the tab was descheduled, and the resync that follows is
 * correct behaviour, not a defect: `game/App.tsx` clamps the frame delta to 100ms and
 * `frame.ts`'s `MAX_TICKS_PER_FRAME` caps catch-up at 5 ticks, so a stalled client
 * permanently loses simulated time while the server keeps ticking, and the next reconcile
 * has a genuinely large error to repair. Observed once here: a 1.33s stall left the server
 * 4.5m ahead, past `VISUAL_CORRECTION_SNAP_METERS`, so it snapped — which is the right call
 * (gliding 4.5m would be 400ms of visible sliding).
 *
 * Windows containing such a gap are therefore exempt from the frame-jump bound, and counted
 * as `stalledFrames` so a real frame-time regression still surfaces in the stats line rather
 * than being silently absorbed.
 */
const MAX_MEASURED_FRAME_DT_MS = 250;
/**
 * How long after a stall the frame-jump bound stays lifted.
 *
 * The resync does not land ON the stalled frame — it lands on whichever later frame the
 * catch-up transform arrives at, once the server's position has propagated. In the 1.33s
 * stall above, the stall ended at t=18537 and the 4.7m snap rendered at t=18564, so an
 * exemption keyed only to windows containing the long gap missed it by one window.
 *
 * The ack has to travel a full round trip before the client can even see how far behind it
 * is, so this has to cover a slow link's RTT plus the glide; 750ms does at every latency this
 * detector sweeps. Stalls are rare enough for this to cost nothing: one in ~10,000 frames
 * across this wave's runs, and every one is still counted in `stalledFrames`.
 */
const STALL_RECOVERY_MS = 750;

// ---------------------------------------------------------------------------
// Driving
// ---------------------------------------------------------------------------

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** How far the rendered position may travel across a window spanning `elapsedMs`. */
export function frameJumpAllowance(elapsedMs: number): number {
  const seconds = Math.max(elapsedMs / 1000, TICK_DT_SECONDS);
  return CHURN_MAX_SPEED * seconds * FRAME_JUMP_SLACK + FRAME_JUMP_EPSILON_METERS;
}

type WindowScan = {
  /** Worst `renderedPathInWindow / allowance` seen, over windows free of a stall. */
  worstRatio: number;
  /** The rendered path of that worst window. */
  worstMeters: number;
  /** `t` of the frame that window ends on — line this up against the video. */
  worstAtMs: number;
  /** Frame gaps longer than `MAX_MEASURED_FRAME_DT_MS` (see its doc). */
  stalledFrames: number;
};

/**
 * Slides a >= `FRAME_JUMP_WINDOW_MS` window across the phase and finds the worst rendered
 * speed in it, skipping any window that contains a stall.
 *
 * Path length inside the window, not straight-line displacement: a teleport out and
 * straight back would cancel to nearly zero displacement while still being two teleports.
 */
function scanFrameJumpWindows(positioned: TraceRecord[]): WindowScan {
  const scan: WindowScan = { worstRatio: 0, worstMeters: 0, worstAtMs: positioned[0]?.t ?? 0, stalledFrames: 0 };
  // pathTo[i] = rendered path from frame 0 up to frame i; window path is a difference of two.
  const pathTo: number[] = [0];
  // The most recent long frame gap at or before each frame — the exemption clock (see
  // STALL_RECOVERY_MS). -Infinity until the first stall, so untroubled runs exempt nothing.
  const lastStallAt: number[] = [Number.NEGATIVE_INFINITY];

  for (let i = 1; i < positioned.length; i += 1) {
    const gapMs = positioned[i].t - positioned[i - 1].t;
    const stalled = gapMs > MAX_MEASURED_FRAME_DT_MS;
    pathTo[i] = pathTo[i - 1] + distance(positioned[i - 1].simPosition!, positioned[i].simPosition!);
    lastStallAt[i] = stalled ? positioned[i].t : lastStallAt[i - 1];
    if (stalled) scan.stalledFrames += 1;
  }

  let start = 0;
  for (let end = 1; end < positioned.length; end += 1) {
    // Smallest window ending at `end` that still spans the full window duration.
    while (start + 1 < end && positioned[end].t - positioned[start + 1].t >= FRAME_JUMP_WINDOW_MS) start += 1;
    const elapsedMs = positioned[end].t - positioned[start].t;
    if (elapsedMs < FRAME_JUMP_WINDOW_MS) continue; // not enough history yet
    // Exempt the stall itself AND the resync that follows it — see STALL_RECOVERY_MS.
    if (positioned[end].t - lastStallAt[end] <= STALL_RECOVERY_MS) continue;

    const moved = pathTo[end] - pathTo[start];
    const ratio = moved / frameJumpAllowance(elapsedMs);
    if (ratio > scan.worstRatio) {
      scan.worstRatio = ratio;
      scan.worstMeters = moved;
      scan.worstAtMs = positioned[end].t;
    }
  }

  return scan;
}

/** Belt-and-braces: never leave a key stuck down for the phases that follow. */
async function releaseAllChurnKeys(page: Page) {
  for (const key of new Set(CHURN_KEYS)) {
    await page.keyboard.up(key).catch(() => {
      /* already up — Playwright treats a redundant keyup as a no-op, but be explicit */
    });
  }
}

/**
 * Alternates `CHURN_KEYS` at `cadenceMs`, overlapping each hold into the next by
 * `OVERLAP_FRACTION` of the cadence. Wall-clock driven (not a fixed iteration count) so
 * the window is `durationMs` of real churn regardless of how slow Playwright's per-key
 * round trip happens to be on this machine.
 */
export async function driveChurn(page: Page, cadenceMs: number, durationMs: number) {
  const overlapMs = Math.max(1, Math.round(cadenceMs * OVERLAP_FRACTION));
  const deadline = Date.now() + durationMs;
  let previous: string | null = null;
  let index = 0;

  while (Date.now() < deadline) {
    const key = CHURN_KEYS[index % CHURN_KEYS.length];
    index += 1;
    await page.keyboard.down(key);

    if (previous && previous !== key) {
      await page.waitForTimeout(overlapMs);
      await page.keyboard.up(previous);
      await page.waitForTimeout(Math.max(0, cadenceMs - overlapMs));
    } else {
      await page.waitForTimeout(cadenceMs);
    }
    previous = key;
  }

  await releaseAllChurnKeys(page);
}

export function churnPhaseName(cadenceMs: number): string {
  return `churn_${cadenceMs}ms`;
}

export function settlePhaseName(cadenceMs: number): string {
  return `settle_${cadenceMs}ms`;
}

/**
 * One churn window + its post-release settle window per cadence. The settle phase is a
 * separate phase (not a tail of the churn phase) so the assertions can address it by
 * name and so the report's phase bands show the release boundary explicitly.
 */
export function churnPhases(): PhaseDef[] {
  const phases: PhaseDef[] = [];
  for (const cadenceMs of CHURN_CADENCES_MS) {
    phases.push({
      name: churnPhaseName(cadenceMs),
      group: 'churn',
      run: async ({ page }) => {
        // Re-assert pointer lock per window, not once per session: `intents.ts` silently
        // drops every key edge while unlocked, so a window that lost focus would record a
        // motionless — and vacuously passing — 10 seconds. See MIN_CHURN_PATH_METERS.
        await acquirePointerLock(page);
        await driveChurn(page, cadenceMs, CHURN_DURATION_MS);
      },
    });
    phases.push({
      name: settlePhaseName(cadenceMs),
      group: 'churn',
      run: async ({ page }) => {
        await releaseAllChurnKeys(page);
        await page.waitForTimeout(SETTLE_DURATION_MS);
      },
    });
  }
  return phases;
}

export const CHURN_PHASE_NAMES: ReadonlySet<string> = new Set(churnPhases().map((phase) => phase.name));

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export type ChurnFailure = {
  phase: string;
  check: 'frame-jump' | 'settle' | 'settle-drift' | 'path-inflation' | 'prediction-lead' | 'no-input';
  detail: string;
  actual: number;
  allowed: number;
  /** performance.now() of the offending frame, for lining the failure up against the video. */
  atMs: number;
};

export type ChurnPhaseStats = {
  phase: string;
  frames: number;
  /** Frame gaps over MAX_MEASURED_FRAME_DT_MS; windows containing one are not asserted on. */
  stalledFrames: number;
  /** Rendered path of the worst >= FRAME_JUMP_WINDOW_MS window, and how it scored. */
  worstFrameJumpMeters: number;
  worstFrameJumpRatio: number;
  worstFrameJumpAtMs: number;
  pathLength: number;
  netDisplacement: number;
  pathInflation: number;
  /** Settle phases only: displacement events past the grace window. */
  postGraceMovementEvents: number;
  postGraceWorstMeters: number;
  /** Settle phases only: total rendered path over the WHOLE post-release window. */
  releasedPathMeters: number;
  /** Derived from the reconcile channel, when the client publishes it (see `ReconcileRecord`). */
  reconcile?: {
    corrections: number;
    worstCorrectionMeters: number;
    snapCorrections: number;
    droppedTicksTotal: number;
    maxDroppedTicks: number;
    /**
     * Predicted ticks REPLAYED onto the authoritative position, across the phase's
     * corrections. This is the client's prediction lead in ticks, and at a known latency it
     * has a known value (RTT / 50ms, +1) — which makes it the sharpest signal in the trace.
     * `minReplayedTicks === 0` while a key is held means a correction threw away every
     * in-flight predicted tick; a large `maxReplayedTicks` means corrections are rebuilding
     * seconds of prediction on top of the server position instead of the RTT's worth.
     */
    minReplayedTicks: number;
    maxReplayedTicks: number;
    /** Corrections that replayed NOTHING — every in-flight predicted tick discarded at once. */
    zeroReplayCorrections: number;
    minPendingTicks: number;
    maxPendingTicks: number;
    /** Sign changes in the correction offset's dominant axis — the oscillation signature. */
    offsetSignFlips: number;
  };
};

function reconcileOf(record: TraceRecord): ReconcileRecord | null {
  return record.reconcile ?? null;
}

function summarizeReconcile(records: TraceRecord[]): ChurnPhaseStats['reconcile'] {
  const frames = records.map(reconcileOf).filter((n): n is ReconcileRecord => n !== null);
  if (frames.length === 0) return undefined;

  let snapCorrections = 0;
  let worstCorrectionMeters = 0;
  let droppedTicksTotal = 0;
  let maxDroppedTicks = 0;
  let minReplayedTicks = Number.POSITIVE_INFINITY;
  let maxReplayedTicks = 0;
  let zeroReplayCorrections = 0;
  let offsetSignFlips = 0;
  let previousCorrections = frames[0].corrections;
  let previousOffsetSign = 0;

  for (const frame of frames) {
    // Correction fields describe the LAST reconcile, so only count them when the
    // reconcile counter actually advanced — otherwise one correction observed across 8
    // frames would be tallied 8 times.
    if (frame.corrections !== previousCorrections) {
      previousCorrections = frame.corrections;
      worstCorrectionMeters = Math.max(worstCorrectionMeters, frame.lastCorrectionMagnitude);
      if (frame.lastCorrectionSnapped) snapCorrections += 1;
      droppedTicksTotal += frame.lastCorrectionDropped;
      maxDroppedTicks = Math.max(maxDroppedTicks, frame.lastCorrectionDropped);
      minReplayedTicks = Math.min(minReplayedTicks, frame.lastCorrectionReplayed);
      maxReplayedTicks = Math.max(maxReplayedTicks, frame.lastCorrectionReplayed);
      if (frame.lastCorrectionReplayed === 0) zeroReplayCorrections += 1;
    }

    // Oscillation reads as the offset repeatedly reversing along its dominant axis.
    const offset = frame.visualOffset;
    const dominant = Math.abs(offset.x) >= Math.abs(offset.z) ? offset.x : offset.z;
    const sign = Math.abs(dominant) < 1e-4 ? 0 : Math.sign(dominant);
    if (sign !== 0 && previousOffsetSign !== 0 && sign !== previousOffsetSign) offsetSignFlips += 1;
    if (sign !== 0) previousOffsetSign = sign;
  }

  return {
    corrections: frames[frames.length - 1].corrections - frames[0].corrections,
    worstCorrectionMeters,
    snapCorrections,
    droppedTicksTotal,
    maxDroppedTicks,
    minReplayedTicks: Number.isFinite(minReplayedTicks) ? minReplayedTicks : 0,
    maxReplayedTicks,
    zeroReplayCorrections,
    minPendingTicks: Math.min(...frames.map((n) => n.pendingTicks)),
    maxPendingTicks: Math.max(...frames.map((n) => n.pendingTicks)),
    offsetSignFlips,
  };
}

function isSettlePhase(phase: string): boolean {
  return phase.startsWith('settle_');
}

/**
 * Reduces one phase's frames to the numbers the three checks read. Frames without a
 * position (pre-join) are dropped; everything else is measured, including stalled ones
 * (they still count toward path length — a stall does not excuse the distance covered).
 */
export function summarizeChurnPhase(phase: string, records: TraceRecord[]): ChurnPhaseStats {
  const positioned = records.filter((r) => r.simPosition !== null);
  const phaseStartMs = positioned[0]?.t ?? 0;

  let pathLength = 0;
  let postGraceMovementEvents = 0;
  let postGraceWorstMeters = 0;

  for (let i = 1; i < positioned.length; i += 1) {
    const current = positioned[i];
    const moved = distance(positioned[i - 1].simPosition!, current.simPosition!);
    pathLength += moved;

    if (isSettlePhase(phase) && current.t - phaseStartMs > SETTLE_GRACE_MS && moved > STILL_EPSILON_METERS) {
      postGraceMovementEvents += 1;
      postGraceWorstMeters = Math.max(postGraceWorstMeters, moved);
    }
  }

  const jump = scanFrameJumpWindows(positioned);

  const elapsedSeconds =
    positioned.length >= 2 ? (positioned[positioned.length - 1].t - positioned[0].t) / 1000 : 0;
  const idealPath = CHURN_MAX_SPEED * elapsedSeconds;

  return {
    phase,
    frames: positioned.length,
    stalledFrames: jump.stalledFrames,
    worstFrameJumpMeters: jump.worstMeters,
    worstFrameJumpRatio: jump.worstRatio,
    worstFrameJumpAtMs: jump.worstAtMs,
    pathLength,
    netDisplacement:
      positioned.length >= 2
        ? distance(positioned[0].simPosition!, positioned[positioned.length - 1].simPosition!)
        : 0,
    pathInflation: idealPath > 0 ? pathLength / idealPath : 0,
    postGraceMovementEvents,
    postGraceWorstMeters,
    releasedPathMeters: isSettlePhase(phase) ? pathLength : 0,
    ...(summarizeReconcile(records) ? { reconcile: summarizeReconcile(records) } : {}),
  };
}

/**
 * The gate. Returns one failure per violated bound per phase (not per frame — a
 * rubberbanding phase produces hundreds of offending frames and one line is the useful
 * summary; the raw trace has the rest).
 */
export type ChurnCheckOptions = {
  /**
   * One-way latency the run injected through `net-proxy.ts`, if any. Enables the
   * `prediction-lead` zero-replay sub-check — see `MIN_LATENCY_FOR_LEAD_CHECK_MS`.
   */
  latencyMs?: number;
};

export function checkChurn(
  records: TraceRecord[],
  options: ChurnCheckOptions = {},
): { failures: ChurnFailure[]; stats: ChurnPhaseStats[] } {
  const leadCheckApplies = (options.latencyMs ?? 0) >= MIN_LATENCY_FOR_LEAD_CHECK_MS;
  const byPhase = new Map<string, TraceRecord[]>();
  for (const record of records) {
    if (!CHURN_PHASE_NAMES.has(record.phase)) continue;
    if (!byPhase.has(record.phase)) byPhase.set(record.phase, []);
    byPhase.get(record.phase)!.push(record);
  }

  const failures: ChurnFailure[] = [];
  const stats: ChurnPhaseStats[] = [];

  for (const [phase, phaseRecords] of byPhase) {
    const summary = summarizeChurnPhase(phase, phaseRecords);
    stats.push(summary);

    // (e) FIRST, because everything after it is an upper bound and a motionless run passes
    // every one of them. See MIN_CHURN_PATH_METERS.
    if (!isSettlePhase(phase) && summary.pathLength < MIN_CHURN_PATH_METERS) {
      failures.push({
        phase,
        check: 'no-input',
        detail:
          `the player moved ${summary.pathLength.toFixed(2)}m over a ${(CHURN_DURATION_MS / 1000).toFixed(0)}s ` +
          'churn window — the scripted input never reached the game (pointer lock is the usual ' +
          'culprit: intents.ts drops key edges while unlocked), so this window proves nothing',
        actual: summary.pathLength,
        allowed: MIN_CHURN_PATH_METERS,
        atMs: phaseRecords[0]?.t ?? 0,
      });
    }

    // (a) no single-frame teleports, in EVERY window including post-release.
    if (summary.worstFrameJumpRatio > 1) {
      failures.push({
        phase,
        check: 'frame-jump',
        detail:
          `rendered position travelled ${summary.worstFrameJumpMeters.toFixed(3)}m inside a ` +
          `${FRAME_JUMP_WINDOW_MS}ms window — ${summary.worstFrameJumpRatio.toFixed(2)}x what ` +
          `${CHURN_MAX_SPEED}u/s can cover in that time`,
        actual: summary.worstFrameJumpRatio,
        allowed: 1,
        atMs: summary.worstFrameJumpAtMs,
      });
    }

    // (b) post-release the rendered position must converge and STAY converged.
    if (isSettlePhase(phase) && summary.postGraceMovementEvents > 0) {
      failures.push({
        phase,
        check: 'settle',
        detail:
          `${summary.postGraceMovementEvents} displacement event(s) more than ${SETTLE_GRACE_MS}ms after ` +
          `every key came up (worst ${summary.postGraceWorstMeters.toFixed(3)}m) — the player is still ` +
          'moving on screen with no input',
        actual: summary.postGraceMovementEvents,
        allowed: 0,
        atMs: phaseRecords[0]?.t ?? 0,
      });
    }

    // (b2) …and CONVERGE is the other half of that sentence. The per-frame bound above only
    // sees a jump; a correction that glides in over 400ms is spread across ~60 frames at 8mm
    // each and slips under it completely, while still reading on screen as the player drifting
    // after the hands came off the keys. Bound the total instead.
    if (isSettlePhase(phase) && summary.releasedPathMeters > RELEASED_PATH_CEILING_METERS) {
      failures.push({
        phase,
        check: 'settle-drift',
        detail:
          `rendered position travelled ${summary.releasedPathMeters.toFixed(3)}m after every key came ` +
          'up — with no input held, a converged client has nothing left to move toward',
        actual: summary.releasedPathMeters,
        allowed: RELEASED_PATH_CEILING_METERS,
        atMs: phaseRecords[0]?.t ?? 0,
      });
    }

    // (c) the rendered path may not exceed what the sim's own top speed could draw.
    if (summary.pathInflation > PATH_INFLATION_SLACK) {
      failures.push({
        phase,
        check: 'path-inflation',
        detail:
          `rendered path was ${summary.pathLength.toFixed(2)}m over ${(summary.pathLength / Math.max(summary.pathInflation, 1e-9) / CHURN_MAX_SPEED).toFixed(2)}s — ` +
          `${summary.pathInflation.toFixed(2)}x the ${CHURN_MAX_SPEED}u/s ceiling (oscillation inflates path without inflating displacement)`,
        actual: summary.pathInflation,
        allowed: PATH_INFLATION_SLACK,
        atMs: phaseRecords[0]?.t ?? 0,
      });
    }

    // (d) the mechanism itself: a correction must resolve the client's prediction lead, not
    // delete it and not rebuild seconds of it. See MAX_ZERO_REPLAY_RATIO / MAX_REPLAYED_TICKS.
    const reconcileStats = summary.reconcile;
    if (reconcileStats && reconcileStats.corrections > 0) {
      const zeroReplayRatio = reconcileStats.zeroReplayCorrections / reconcileStats.corrections;
      if (leadCheckApplies && zeroReplayRatio > MAX_ZERO_REPLAY_RATIO) {
        failures.push({
          phase,
          check: 'prediction-lead',
          detail:
            `${reconcileStats.zeroReplayCorrections} of ${reconcileStats.corrections} corrections replayed NO ` +
            'predicted ticks — every in-flight tick discarded and the render snapped onto the ' +
            'raw authoritative position, which is one round trip stale. This is the rubberband.',
          actual: zeroReplayRatio,
          allowed: MAX_ZERO_REPLAY_RATIO,
          atMs: phaseRecords[0]?.t ?? 0,
        });
      }
      if (reconcileStats.maxReplayedTicks > MAX_REPLAYED_TICKS) {
        failures.push({
          phase,
          check: 'prediction-lead',
          detail:
            `a correction replayed ${reconcileStats.maxReplayedTicks} predicted ticks ` +
            `(${(reconcileStats.maxReplayedTicks * TICK_DT_SECONDS).toFixed(1)}s of prediction) onto the ` +
            'authoritative position — the render is running that far ahead of the server',
          actual: reconcileStats.maxReplayedTicks,
          allowed: MAX_REPLAYED_TICKS,
          atMs: phaseRecords[0]?.t ?? 0,
        });
      }
    }
  }

  return { failures, stats };
}

export function formatChurnStats(stats: ChurnPhaseStats[]): string {
  const lines = ['[input_churn] per-phase:'];
  for (const s of stats) {
    lines.push(
      `  ${s.phase.padEnd(16)} frames=${String(s.frames).padStart(4)} ` +
        `worst${FRAME_JUMP_WINDOW_MS}ms=${s.worstFrameJumpMeters.toFixed(3)}m (${s.worstFrameJumpRatio.toFixed(2)}x allowed) ` +
        `path=${s.pathLength.toFixed(2)}m (${s.pathInflation.toFixed(2)}x ceiling) ` +
        `net=${s.netDisplacement.toFixed(2)}m` +
        (isSettlePhase(s.phase)
          ? ` releasedPath=${s.releasedPathMeters.toFixed(3)}m postGraceMoves=${s.postGraceMovementEvents}`
          : '') +
        (s.stalledFrames > 0 ? ` stalled=${s.stalledFrames}` : ''),
    );
    if (s.reconcile) {
      lines.push(
        `    reconcile: corrections=${s.reconcile.corrections} worst=${s.reconcile.worstCorrectionMeters.toFixed(3)}m ` +
          `snaps=${s.reconcile.snapCorrections} droppedTicks=${s.reconcile.droppedTicksTotal} (max ${s.reconcile.maxDroppedTicks}/reconcile) ` +
          `replayed=${s.reconcile.minReplayedTicks}..${s.reconcile.maxReplayedTicks} (zero-replay ${s.reconcile.zeroReplayCorrections}/${s.reconcile.corrections}) ` +
          `pending=${s.reconcile.minPendingTicks}..${s.reconcile.maxPendingTicks} offsetSignFlips=${s.reconcile.offsetSignFlips}`,
      );
    }
  }
  return lines.join('\n');
}

export function formatChurnFailures(botLabel: string, failures: ChurnFailure[]): string {
  const lines = [`[input_churn] ${botLabel}: ${failures.length} rubberband check(s) failed:`];
  for (const f of failures) {
    lines.push(
      `  ${f.phase}.${f.check} @${f.atMs.toFixed(0)}ms: actual=${f.actual.toFixed(4)} allowed=${f.allowed.toFixed(4)}\n    ${f.detail}`,
    );
  }
  return lines.join('\n');
}
