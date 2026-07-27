/**
 * Two-bot interaction scenarios: the first automated tests of the game as a multiplayer game
 * rather than a single player in an empty world.
 *
 * Topology: two concurrent browser contexts against the same SpacetimeDB world. Both join
 * (round-robin spawn selection puts them on different, often distant, authored spawn points —
 * see server/spacetimedb/src/player.rs's `select_spawn`), the attacker walks/turns toward the
 * victim until in melee range, then the scenario drives whatever interaction it's named for and
 * asserts the outcome from server-authoritative rows read off `window.__mogGame.store` (never
 * from a client-side visual/camera guess — v2 exposes no camera telemetry at all, see
 * page-driver.ts's readStoreField/readStoreVector doc).
 *
 * v2 dropped the old class system (wizard/paladin) entirely, so this is no longer "the wizard
 * fires at the paladin" — it's a small named-scenario registry (DUEL_SCENARIOS), generic over
 * two identical bots. Only `block_absorb` is implemented for this wave (the Wave 3F "local run
 * proof" bar); the registry shape is there so a future wave can add e.g. `arc_hit` or
 * `roll_iframe` as another entry rather than another one-off script.
 *
 * Facing is closed-loop against the authoritative `player_transform.rotation_y` row (read back
 * via readStoreField) rather than a client-side camera telemetry probe (v2 has none to read —
 * see the old duel.ts's `readViewYaw`, which this replaces): mouse deltas are dead-reckoned
 * from the client's own yaw-per-pixel constant, then corrected against what the server actually
 * recorded, which is more robust than the pre-rewrite probe because there's no ambiguity about
 * what "current yaw" means — it's the same number the pipeline gates combat on.
 */
import type { Browser, Page } from 'playwright';
import type { RunData, Vec3 } from './trace-types';
import { ACTION_DEFS, SLOT_BINDINGS } from '../src/actions/defs.generated';
import { Phase } from '../src/actions/gates';
import { findByEffect, pressSlot, releaseSlot, waitForActionPhase, waitForIdle } from './generate-phases';
import {
  acquirePointerLock,
  closeSession,
  collectRun,
  joinAs,
  openBotSession,
  readLocalIdentityHex,
  readStoreField,
  readStoreRows,
  readStoreVector,
  saveFailureDiagnostics,
  setPhase,
  waitForRenderLoop,
  type BotSession,
  type SessionConfig,
} from './page-driver';

// Mirrors client/src/input/useInput.ts's private CAMERA_YAW_SENSITIVITY (not exported — it's
// an internal UI feel constant, not part of the wire contract). Used only to dead-reckon the
// FIRST turn; every turn is corrected against the authoritative server-recorded rotation_y
// afterward (see turnToward), so drift here costs an extra correction step, never a wrong facing.
const MOUSE_YAW_SENSITIVITY = 0.0025;
const YAW_TOLERANCE_RAD = 0.3; // attack_light's melee_arc is 90 degrees wide (+/-0.785rad) — generous margin
const MELEE_RANGE = 2.2; // under attack_light's 2.8u range, leaving room for position noise
const MAX_APPROACH_STEPS = 40;

export type DuelResult = {
  runs: RunData[];
  /** Empty means every scenario assertion held. */
  issues: string[];
};

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function yawToward(from: Vec3, to: Vec3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

function distance2d(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Applies the FULL raw pixel delta needed for `totalDeltaRad` of yaw, working around the
 * viewport's limited mouse-move range for turns approaching a full PI (round-robin spawns can
 * start a bot facing exactly opposite the victim — see server/spacetimedb/src/player.rs's
 * `select_spawn`) by releasing pointer lock to recenter the cursor when it runs out of room,
 * then re-acquiring — ported from the pre-rewrite duel.ts's `aimAt`/`moveBy`, which documented
 * exactly this: "Cursor pinned at the edge: recenter with lock released so the reposition
 * doesn't register as camera movement, then re-lock."
 *
 * This does NOT recenter-then-correct as two independent moves the way an earlier version of
 * this file did — that recenter is itself a real mouse delta the client's rotationYRef silently
 * absorbs (client/src/input/useInput.ts's mousemove handler runs regardless of whether a
 * movement key is held), and when both the recenter and the following correction hit the same
 * clamp magnitude in opposite directions their contributions to rotationYRef exactly cancel —
 * observed live as the yaw correction succeeding once and then stalling at the identical
 * residual for every further attempt. Every pixel moved here is a deliberate step toward the
 * target; recentering only ever happens via the lock-release trick, which is documented (and
 * empirically confirmed, both pre- and post-rewrite) to not itself count as camera movement.
 */
async function applyYawPixels(page: Page, totalPixels: number): Promise<void> {
  // Under pointer lock the cursor is captured (hidden, no real on-screen position), so CDP's
  // Input.dispatchMouseEvent still reports a correct movementX for a target coordinate well
  // outside the viewport's visible pixels — there's no "reaching the edge" the way an
  // un-captured cursor would hit. Testing confirmed the viewport-bounded room-tracking +
  // escape/relock dance this replaced was unnecessary AND, worse, broke movementX reporting
  // for every attempt after the first relock (observed live: yaw permanently stopped
  // responding to any further correction once a single escape/relock cycle had happened).
  await page.mouse.move(640 + totalPixels, 360, { steps: 3 });
}

/** Turns to face `desiredYaw` in one shot (bounded internal retries against server-recorded
 * drift), via brief forward TAPS — spawns can start facing up to ~180 degrees from the victim
 * (see applyYawPixels's doc), and holding a movement key continuously through a turn that large
 * slides the bot along whatever wall its still-mostly-wrong facing points into for the whole
 * window (observed live: pinned to the wall it started facing, oscillating along it, never able
 * to leave). A tap still flushes the mouse-turned rotationY to the server
 * (client/src/input/useInput.ts sends on any movement-vector change, which a tap's press AND
 * release both are) but covers only a fraction of a tick's worth of ground. */
async function alignFacing(page: Page, desiredYaw: number, toleranceRad: number, maxAttempts = 4): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const currentYaw = (await readStoreField(page, 'playerTransform', 'rotationY', 'local')) ?? 0;
    const delta = angleDiff(desiredYaw, currentYaw);
    if (Math.abs(delta) < toleranceRad) return true;
    await applyYawPixels(page, -delta / MOUSE_YAW_SENSITIVITY);
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(60);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(150); // let the tap's send round-trip before reading rotationY again
  }
  return false;
}

/** Small corrective re-aim while forward is already held continuously (the main approach loop)
 * — the residual here should be modest (alignFacing already faced the target), so this rarely
 * needs more than one pass; the caller's held movement key keeps flushing rotationY via the
 * heartbeat regardless. */
async function turnToward(page: Page, desiredYaw: number): Promise<void> {
  const currentYaw = (await readStoreField(page, 'playerTransform', 'rotationY', 'local')) ?? 0;
  const delta = angleDiff(desiredYaw, currentYaw);
  if (Math.abs(delta) < YAW_TOLERANCE_RAD) return;
  await applyYawPixels(page, -delta / MOUSE_YAW_SENSITIVITY);
  await page.waitForTimeout(150); // let the movement heartbeat (50ms) flush + round-trip
}

async function approachForMelee(attacker: Page, victimIdentityHex: string): Promise<{ ok: boolean; detail: string }> {
  await acquirePointerLock(attacker);

  const initialMine = await readStoreVector(attacker, 'playerTransform', 'position', 'local');
  const initialTheirs = await readStoreVector(attacker, 'playerTransform', 'position', victimIdentityHex);
  if (!initialMine || !initialTheirs) return { ok: false, detail: 'telemetry unavailable before approach' };
  const aligned = await alignFacing(attacker, yawToward(initialMine, initialTheirs), YAW_TOLERANCE_RAD);
  if (!aligned) {
    return { ok: false, detail: 'could not align facing toward the victim before committing to walk forward' };
  }

  await attacker.keyboard.down('KeyW');
  try {
    for (let step = 0; step < MAX_APPROACH_STEPS; step += 1) {
      const mine = await readStoreVector(attacker, 'playerTransform', 'position', 'local');
      const theirs = await readStoreVector(attacker, 'playerTransform', 'position', victimIdentityHex);
      if (!mine || !theirs) return { ok: false, detail: 'telemetry unavailable during approach' };

      const distance = distance2d(mine, theirs);
      if (distance <= MELEE_RANGE) {
        await turnToward(attacker, yawToward(mine, theirs));
        return { ok: true, detail: `in melee range at ${distance.toFixed(2)}u` };
      }
      await turnToward(attacker, yawToward(mine, theirs));
      await attacker.waitForTimeout(250);
    }
    return { ok: false, detail: 'could not reach melee range within the step budget' };
  } finally {
    await attacker.keyboard.up('KeyW');
  }
}

/**
 * The charge-mode hold action on the dual-bound slot (today: attack_heavy on `primary`) and
 * the melee_arc effect it carries — resolved generically, never a hardcoded action id, same
 * "find the charge-mode hold" primitive generate-phases.ts's action matrix uses.
 *
 * block_absorb presses this and holds it deliberately (rather than firing the instant tap
 * side, attack_light) specifically for the SLACK a charge affords: a Press always resolves
 * dual-bound `primary` into this action's Charging state immediately (docs/action-pipeline.md),
 * and it stays there — server-tick-driven, independent of the sending client's focus or even
 * connection — until an explicit Release, which is the one edge `intents.ts::handleMouseUp`
 * does NOT gate on pointer lock ("always processed even while unlocked, so state never
 * sticks"). That combination is what makes the two-window focus handoff below possible at all:
 * attack_light's fixed 250ms windup left far too little real time for a still-unlocked
 * victim's OWN pointer-lock engagement (measured live: needs on the order of 300-500ms) to
 * complete before the active window fired, so the "victim already Held" precondition was lost
 * almost every run. Holding the charge instead borrows from its up-to-1500ms charge window
 * (`maxTicks`) for that same handoff, then releases into a normal (short) windup once victim's
 * block is confirmed — no attacker refocus required for the release itself.
 */
function chargeMeleeAttack() {
  const primaryBinding = SLOT_BINDINGS.find((b) => {
    if (!b.holdAction) return false;
    const holdDef = ACTION_DEFS.find((d) => d.id === b.holdAction);
    return holdDef?.hold?.mode === 'charge';
  });
  const def = ACTION_DEFS.find((d) => d.id === primaryBinding?.holdAction);
  const effect = def?.effects.find((e) => e.kind === 'melee_arc');
  if (!primaryBinding || !def || def.hold?.mode !== 'charge' || !effect || effect.kind !== 'melee_arc') {
    throw new Error('duel: expected a dual-bound slot whose hold action is a charge-mode melee_arc def');
  }
  return { binding: primaryBinding, def, hold: def.hold, effect };
}

type ActionEventRow = {
  actor: string;
  target: string | null;
  actionId: string;
  kind: string;
  amount: number;
  serverTick: bigint;
};

/** Every `action_event` row where `actor` == `attackerHex`, newest first. */
async function actionEventsFrom(page: Page, attackerHex: string): Promise<ActionEventRow[]> {
  const rows = await readStoreRows(page, 'actionEvent', 'actor', attackerHex);
  return rows
    .map(
      (r): ActionEventRow => ({
        actor: r.actor as string,
        target: (r.target as string | undefined) ?? null,
        actionId: r.actionId as string,
        kind: r.kind as string,
        amount: r.amount as number,
        serverTick: BigInt(r.serverTick as string),
      }),
    )
    .sort((a, b) => (a.serverTick < b.serverTick ? 1 : a.serverTick > b.serverTick ? -1 : 0));
}

/**
 * Fast pointer-lock (re-)acquisition for the one handoff in runBlockAbsorb that IS
 * timing-critical (victim's block press, mid-attacker-charge — see that function's comments).
 * Unlike page-driver.ts's acquirePointerLock, this does NOT wait for an incidental attack_light
 * to clear afterward (waitLocalActionIdle, up to 1000ms) — by the time this runs, victim has
 * already been through one full acquire/absorb cycle (this function's caller does that ahead of
 * time, outside the timing-critical window), so there's nothing left to absorb, and burning
 * hundreds of ms here is exactly what let the attacker's charge fully resolve before this ever
 * got called (root-caused: the original single-acquirePointerLock(victim) call's fixed 200ms
 * settle wait, PLUS however long its own incidental-attack absorption took, easily exceeded
 * attack_heavy's ~200ms windup — see defs.generated.rs — by the time it returned).
 */
async function fastReacquirePointerLock(page: Page, center: { x: number; y: number }): Promise<void> {
  // No boundingBox() query and no post-click confirmation wait here — both are round trips this
  // one handoff cannot afford (server-side, the whole budget is attack_heavy's windup MINUS
  // block's own windup before it reaches Held, ~100ms — see the caller's comment). `center` is
  // resolved once by the caller, off the clock; the click itself (not confirming it landed) is
  // the fastest sequence that still gives the browser a real user gesture to grant the lock on.
  await page.bringToFront();
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.up();
}

/**
 * block_absorb: the attacker closes to melee range and lands a charged attack on a blocking
 * victim; the assertion is that damage lands as the def's `blockedDamage` (chip damage), not
 * the full `damage` — proving `mitigation`'s multiplier-and-override math
 * (server/spacetimedb/src/actions/effects.rs::resolve_damage) round-trips through a real
 * client session on both ends, not just the unit tests that already cover the pure function
 * (and not just test-action-pipeline.ts's own two-identity case, which proves the same math via
 * direct reducer calls — no browser, no cross-window input timing at all).
 *
 * ROOT-CAUSED (Wave 3F): this used to consistently reach a real "hit" event instead of
 * "blocked" — a live SDK timing sweep against the server showed the mitigation boundary itself
 * is exact (delta>=0 ticks -> blocked/chip, delta<0 -> hit, zero anomalies); the server was
 * exonerated. The bug was entirely in this harness's OWN choreography: the single
 * `acquirePointerLock(victim.page)` call used to happen AFTER the attacker had already been
 * charging past its hold threshold, which (a) blurred the attacker mid-hold, firing a REAL
 * (premature) Release edge (`intents.ts::setPointerLocked` — losing pointer lock force-releases
 * whatever's held) that resolved the charged attack almost immediately, and (b) itself absorbed
 * victim's OWN incidental attack_light (every click can attack in v2 — see
 * page-driver.ts::acquirePointerLock's doc) before ever pressing block, adding thereto up to
 * ~650ms more. Attack_heavy's active (damage-applying) tick lands ~200ms after whatever Release
 * ends the charge (windup_ticks=4 @ 20Hz — defs.generated.rs), so by the time the old code
 * finally pressed block, the hit had already resolved as a full, unmitigated hit ~1s earlier.
 * Fixed by moving ALL of victim's (and the attacker's re-)focus-stealing setup, including
 * absorbing any incidental attack_light, to BEFORE the attacker's controlled charge press even
 * starts — see the comments below — so only ONE more (fast, pre-absorbed) handoff remains
 * inside the actual timing-critical window.
 */
async function runBlockAbsorb(attacker: BotSession, victim: BotSession, issues: string[]) {
  const { binding: primaryBinding, effect } = chargeMeleeAttack();
  const blockCase = findByEffect('mitigation');

  const attackerHexMaybe = await readLocalIdentityHex(attacker.page);
  const victimHexMaybe = await readLocalIdentityHex(victim.page);
  if (!attackerHexMaybe || !victimHexMaybe) {
    issues.push('block_absorb: identity not available on one of the sessions');
    return;
  }
  // Rebound as definite strings (not just narrowed) so attemptExchange's closure below — a
  // nested function, where TS control-flow narrowing of the outer `let`/`const` doesn't persist
  // — sees `string`, not `string | null`.
  const attackerHex: string = attackerHexMaybe;
  const victimHex: string = victimHexMaybe;

  await setPhase(attacker.page, 'duel_approach');
  await setPhase(victim.page, 'duel_approach');
  const approach = await approachForMelee(attacker.page, victimHex);
  console.log(`[duel] approach: ${approach.detail}`);
  if (!approach.ok) {
    issues.push(`block_absorb: ${approach.detail}`);
    return;
  }

  await setPhase(attacker.page, 'duel_block_absorb');
  await setPhase(victim.page, 'duel_block_absorb');

  // Resolved once, off the clock — fastReacquirePointerLock's later (timing-critical) call
  // reuses this instead of paying for its own boundingBox() round trip.
  // `.game-shell canvas`, not a bare `canvas` — the perf overlay adds a second one
  // under the same `?qa` gate. See acquirePointerLock in page-driver.ts.
  const victimCanvasBox = await victim.page.locator('.game-shell canvas').boundingBox();
  const victimCenter = victimCanvasBox
    ? { x: victimCanvasBox.x + victimCanvasBox.width / 2, y: victimCanvasBox.y + victimCanvasBox.height / 2 }
    : { x: 640, y: 360 };

  // Single exchange attempt: press the charge, hand off to victim mid-hold, confirm the block
  // landed as `blocked`. Returns null on success, or an issue string describing what went wrong.
  //
  // Why this can still miss even with the reordered choreography (see the function-level doc):
  // attack_heavy's damage-applying tick lands `windup_ticks`(4) after whatever Release ends the
  // charge, but block has its OWN `windup_ticks`(2) before reaching Held (defs.generated.rs) —
  // so the REAL margin is the difference, ~100ms, not the full 200ms. fastReacquirePointerLock
  // is tuned to fit inside that (no confirm-lock wait, no incidental-attack absorb, a cached
  // click target), but 100ms against real CDP round-trip + 20Hz server-tick-alignment jitter is
  // not a guaranteed win every single time — measured empirically ~50-60% first-try. That's a
  // property of racing two headed browser windows for OS focus, not a wrong mechanism (when it
  // lands, the full mitigation math — multiplier, charge-scaled blockedDamage range, exact
  // health delta — all check out below), so this is wrapped in a bounded retry rather than
  // loosened into a race-tolerant assertion.
  async function attemptExchange(): Promise<string | null> {
    const healthBefore = await readStoreField(victim.page, 'playerHealth', 'currentHealth', 'local');

    // Victim first: absorbs its own incidental attack_light here, off the clock.
    await acquirePointerLock(victim.page);
    // That just blurred the attacker (still frontmost from approachForMelee or the previous
    // attempt's cleanup, holding nothing yet), harmlessly. Bring it back and absorb whatever
    // incidental attack_light THAT re-click fires too, also off the clock.
    await acquirePointerLock(attacker.page);

    await pressSlot(attacker.page, primaryBinding.slot); // enters the charge-mode hold action's Charging
    const holdThresholdMs = primaryBinding.holdThresholdTicks * (1000 / 20);
    await attacker.page.waitForTimeout(holdThresholdMs + 100);

    // The one handoff left inside the timing-critical window — see this function's doc.
    await fastReacquirePointerLock(victim.page, victimCenter);
    await pressSlot(victim.page, blockCase.binding.slot);
    try {
      await waitForActionPhase(victim.page, Phase.Held, 2000);
    } catch (err) {
      return `victim never reached Held on ${blockCase.binding.slot}: ${err instanceof Error ? err.message : String(err)}`;
    }
    await victim.page.waitForTimeout(300); // margin past Held confirmation before releasing the attacker's charge

    await releaseSlot(attacker.page, primaryBinding.slot);

    let landed: ActionEventRow | undefined;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !landed) {
      const events = await actionEventsFrom(attacker.page, attackerHex);
      landed = events.find((e) => e.target === victimHex);
      if (!landed) await attacker.page.waitForTimeout(100);
    }
    await releaseSlot(victim.page, blockCase.binding.slot);
    await waitForIdle(victim.page).catch(() => {}); // best-effort settle before teardown

    if (!landed) return 'no action_event landed on the victim within the reap window';
    if (landed.kind !== 'blocked') return `expected kind=blocked, got kind=${landed.kind} amount=${landed.amount}`;
    // Charge-scaled: blockedDamage is a [min, max] range lerped by however long the charge was
    // actually held (docs/action-pipeline.md) — the exact fraction depends on real hand-off
    // timing, so assert the range, not a specific value.
    if (landed.amount < effect.blockedDamage.min || landed.amount > effect.blockedDamage.max) {
      return `expected blockedDamage in [${effect.blockedDamage.min}, ${effect.blockedDamage.max}], got ${landed.amount}`;
    }

    const healthAfter = await readStoreField(victim.page, 'playerHealth', 'currentHealth', 'local');
    if (healthBefore === null || healthAfter === null || healthAfter !== healthBefore - Number(landed.amount)) {
      return `victim health ${healthBefore} -> ${healthAfter}, expected -${landed.amount}`;
    }

    console.log(
      `[duel] block_absorb confirmed: victim hp ${healthBefore} -> ${healthAfter} (blocked for ${landed.amount}, ` +
        `raw would have been [${effect.damage.min}, ${effect.damage.max}])`,
    );
    return null;
  }

  const MAX_ATTEMPTS = 3;
  const attemptFailures: string[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const failure = await attemptExchange();
    if (!failure) return; // confirmed
    attemptFailures.push(failure);
    console.log(`[duel] block_absorb attempt ${attempt}/${MAX_ATTEMPTS} missed the window: ${failure}`);
    if (attempt === MAX_ATTEMPTS) break;
    // Cleanup before retrying: release anything still held on either side (best-effort — a
    // prior attempt may have already auto-released via blur) and let both settle to Idle.
    await releaseSlot(attacker.page, primaryBinding.slot).catch(() => {});
    await releaseSlot(victim.page, blockCase.binding.slot).catch(() => {});
    await waitForIdle(attacker.page).catch(() => {});
    await waitForIdle(victim.page).catch(() => {});
  }
  issues.push(
    `block_absorb: missed the mitigation window on all ${MAX_ATTEMPTS} attempts (racing two headed windows for OS ` +
      `focus — see runBlockAbsorb's doc): ${attemptFailures.join(' | ')}`,
  );
}

type DuelScenario = (attacker: BotSession, victim: BotSession, issues: string[]) => Promise<void>;
export const DUEL_SCENARIOS: Record<string, DuelScenario> = {
  block_absorb: runBlockAbsorb,
};

export async function runDuel(browser: Browser, cfg: SessionConfig, scenarioName: string): Promise<DuelResult> {
  const scenario = DUEL_SCENARIOS[scenarioName];
  if (!scenario) {
    throw new Error(`runDuel: unknown scenario "${scenarioName}" (known: ${Object.keys(DUEL_SCENARIOS).join(', ')})`);
  }

  const issues: string[] = [];
  const sessions: BotSession[] = [];
  const runsBySession = new Map<BotSession, RunData>();

  try {
    const attacker = await openBotSession(browser, 'attacker', cfg);
    sessions.push(attacker);
    const victim = await openBotSession(browser, 'victim', cfg);
    sessions.push(victim);

    await joinAs(attacker, cfg);
    await waitForRenderLoop(attacker.page, cfg.joinTimeoutMs);
    await joinAs(victim, cfg);
    await waitForRenderLoop(victim.page, cfg.joinTimeoutMs);

    await scenario(attacker, victim, issues);

    await setPhase(attacker.page, 'done');
    await setPhase(victim.page, 'done');
    await attacker.page.waitForTimeout(300);

    const attackerRun = await collectRun(attacker, cfg);
    const victimRun = await collectRun(victim, cfg);
    runsBySession.set(attacker, attackerRun);
    runsBySession.set(victim, victimRun);
    return { runs: [attackerRun, victimRun], issues };
  } catch (err) {
    for (const session of sessions) await saveFailureDiagnostics(session, cfg);
    throw err;
  } finally {
    for (const session of sessions) await closeSession(session, runsBySession.get(session));
  }
}
