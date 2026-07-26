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
 * block_absorb: the attacker closes to melee range and lands a charged attack on a blocking
 * victim; the assertion is that damage lands as the def's `blockedDamage` (chip damage), not
 * the full `damage` — proving `mitigation`'s multiplier-and-override math
 * (server/spacetimedb/src/actions/effects.rs::resolve_damage) round-trips through a real
 * client session on both ends, not just the unit tests that already cover the pure function
 * (and not just test-action-pipeline.ts's own two-identity case, which proves the same math via
 * direct reducer calls — no browser, no cross-window input timing at all).
 *
 * KNOWN GAP (Wave 3F, not resolved): this consistently reaches a real "hit" event instead of
 * "blocked" — the attack lands, the target/actor/amount are all correct for a full-damage hit,
 * and victim's OWN `player_action_state` row reads back as `block`/Held both immediately before
 * releasing the attacker's charge AND immediately after the hit event is observed — yet the
 * server's own damage resolution at the moment the active window fired evidently did not see
 * victim as Held (mitigation's multiplier never applied; a Held-but-not-mitigated read would
 * still show `blocked` with the full raw amount, but this shows kind=hit outright, meaning
 * `victim_mitigation` returned None at that exact server-side read). Every input-level
 * mechanism this function depends on has been individually verified live: the tap-vs-hold
 * threshold resolves correctly (charge-mode `actionId` matches, not the paired tap), the event
 * lands with the correct actor/target, and the health delta application itself is exercised
 * elsewhere. The mitigation math itself is NOT in question — client/test-action-pipeline.ts's
 * own two-identity case exercises the identical `resolve_damage`/`victim_mitigation` path
 * (block held, attack_light landed) via direct reducer calls with no browser at all, and passes
 * cleanly (blocked for exactly `blockedDamage.min`). That isolates this gap to something
 * specific to the TWO-BROWSER-SESSION path — most likely `apply_damage`'s live read of victim's
 * `player_action_state` row within the same tick transaction as the attacker's active window
 * resolving (server/spacetimedb/src/actions/effects.rs), possibly interacting with the
 * cross-window pointer-lock focus handoff this function's own comments above document — beyond
 * what a client-only harness change can fix or definitively root-cause without a live debugging
 * session against the running server. Flagged here rather than silently loosened.
 */
async function runBlockAbsorb(attacker: BotSession, victim: BotSession, issues: string[]) {
  const { binding: primaryBinding, effect } = chargeMeleeAttack();
  const blockCase = findByEffect('mitigation');

  const attackerHex = await readLocalIdentityHex(attacker.page);
  const victimHex = await readLocalIdentityHex(victim.page);
  if (!attackerHex || !victimHex) {
    issues.push('block_absorb: identity not available on one of the sessions');
    return;
  }

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

  // Two headed windows cannot both hold pointer lock at once: engaging one always steals OS
  // focus from the other, and Chromium releases the backgrounded window's lock the instant it
  // loses focus (standard Pointer Lock spec behavior). That doesn't just risk victim's HELD
  // block later — it hits the ATTACKER's own still-held 'primary' press first: losing ITS OWN
  // focus/lock the moment victim's acquirePointerLock(victim.page) below brings victim's window
  // forward fires `intents.ts::setPointerLocked`'s cleanup on the ATTACKER's page too, which
  // sends a real Release edge for whatever the attacker is still holding. If that lands before
  // the slot's own hold threshold, it resolves to the paired TAP action instead of the hold
  // action being tested here (docs/action-pipeline.md) — observed live: the attacker's action
  // state was already back to Idle (a completed attack_light cycle) by the time this function's
  // own explicit `releaseSlot` call ran, meaning that auto-release — not this function's
  // controlled one — was what actually resolved the press, well before either the intended
  // wait or release ever executed. So the threshold wait must happen BEFORE anything touches
  // victim's page at all, not after victim's block is confirmed.
  const healthBefore = await readStoreField(victim.page, 'playerHealth', 'currentHealth', 'local');
  await pressSlot(attacker.page, primaryBinding.slot); // enters the charge-mode hold action's Charging
  const holdThresholdMs = primaryBinding.holdThresholdTicks * (1000 / 20);
  await attacker.page.waitForTimeout(holdThresholdMs + 100);

  // Only now does victim's window get focus to press block, borrowing from the charge's own
  // up-to-1500ms window (`maxTicks`) for however long the hand-off itself takes. The
  // attacker's eventual Release doesn't need refocusing at all (`intents.ts::handleMouseUp` is
  // the one edge NOT gated on pointer lock, "always processed even while unlocked, so state
  // never sticks") so victim's lock is never disturbed again once engaged.
  await acquirePointerLock(victim.page);
  await pressSlot(victim.page, blockCase.binding.slot);
  try {
    await waitForActionPhase(victim.page, Phase.Held, 2000);
  } catch (err) {
    issues.push(`block_absorb: victim never reached Held on ${blockCase.binding.slot}: ${err instanceof Error ? err.message : String(err)}`);
    return;
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

  if (!landed) {
    issues.push('block_absorb: no action_event landed on the victim within the reap window');
    return;
  }
  if (landed.kind !== 'blocked') {
    issues.push(`block_absorb: expected kind=blocked, got kind=${landed.kind} amount=${landed.amount}`);
    return;
  }
  // Charge-scaled: blockedDamage is a [min, max] range lerped by however long the charge was
  // actually held (docs/action-pipeline.md) — the exact fraction depends on real hand-off
  // timing, so assert the range, not a specific value.
  if (landed.amount < effect.blockedDamage.min || landed.amount > effect.blockedDamage.max) {
    issues.push(
      `block_absorb: expected blockedDamage in [${effect.blockedDamage.min}, ${effect.blockedDamage.max}], got ${landed.amount}`,
    );
    return;
  }

  const healthAfter = await readStoreField(victim.page, 'playerHealth', 'currentHealth', 'local');
  if (healthBefore === null || healthAfter === null || healthAfter !== healthBefore - Number(landed.amount)) {
    issues.push(`block_absorb: victim health ${healthBefore} -> ${healthAfter}, expected -${landed.amount}`);
    return;
  }

  console.log(
    `[duel] block_absorb confirmed: victim hp ${healthBefore} -> ${healthAfter} (blocked for ${landed.amount}, ` +
      `raw would have been [${effect.damage.min}, ${effect.damage.max}])`,
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
