/**
 * Live-SpacetimeDB regression test for the action pipeline (docs/action-pipeline.md).
 * No browser: connects directly with the generated SDK client, like test-reconnect.ts.
 *
 * Two passes:
 * 1. Generic, data-driven loop over EVERY row in ACTION_DEFS (shared/actions.json via
 *    defs.generated) — never a hardcoded action id. For each def: drive it through
 *    action_input using its own SLOT_BINDINGS row, and assert (from the def's own data):
 *      - phase progression timing (Windup/Active/Recovery tick deltas match the def exactly)
 *      - cooldown rejection (a same-slot Press right after completion is rejected iff
 *        cooldownTicks > 0)
 *      - resource decrement (defs with a `resource` cost spend exactly that amount)
 *      - event emission (melee_arc/aoe_at_target -> a miss event with no other player in
 *        range; heal_self -> a heal event; projectile -> a spawned projectile row; a
 *        charge-mode hold action released past its slot's hold threshold -> a release event)
 * 2. One hand-written two-identity case: an attacker and a victim, proving arc hit, block
 *    mitigation, and roll invulnerability all read real server-authoritative rows.
 *
 * Every wait below is event-driven off the SDK's own table callbacks (push, not poll) or
 * derived from the rows' own tick fields (never wall-clock assumptions about server timing).
 */
import { Identity } from "spacetimedb";
import { DbConnection } from "./src/generated";
import { InputEdge } from "./src/generated/types";
import type {
  ActionEvent,
  PlayerActionState,
  PlayerHealth,
  PlayerResource,
  PlayerTransform,
  Projectile,
  Vector3,
} from "./src/generated/types";
import { ACTION_DEFS, ACTIONS_TICK_RATE, SLOT_BINDINGS, type ActionDef, type SlotBinding } from "./src/actions/defs.generated";
import { Phase } from "./src/actions/gates";

const STDB_URL = process.env.STDB_URL ?? "ws://127.0.0.1:3000";
const STDB_DB_NAME = process.env.STDB_DB_NAME ?? "mog-game-v1";
const TICK_MS = 1000 / ACTIONS_TICK_RATE; // 50ms @ 20Hz
const DEFAULT_TIMEOUT_MS = 15_000;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function ticks(from: bigint, to: bigint): number {
  return Number(to - from);
}

// ---------------------------------------------------------------------------
// Connection — every bot here wants a fresh identity, so no token is saved/loaded
// (unlike test-reconnect.ts, which specifically exercises token persistence).
// ---------------------------------------------------------------------------

function connect(label: string): Promise<{ conn: DbConnection; identity: Identity }> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(STDB_URL)
      .withDatabaseName(STDB_DB_NAME)
      .onConnect((conn, identity) => {
        console.log(`[${label}] connected: ${identity.toHexString()}`);
        resolve({ conn, identity });
      })
      .onConnectError((_ctx, err) => {
        reject(new Error(
          `[${label}] failed to connect to ${STDB_URL}. Check the target SpacetimeDB is reachable.`,
          { cause: err },
        ));
      })
      .build();
  });
}

function subscribeAll(conn: DbConnection): Promise<void> {
  return new Promise(resolve => {
    conn.subscriptionBuilder()
      .onApplied(() => resolve())
      .subscribe([
        "SELECT * FROM action_event",
        "SELECT * FROM config",
        "SELECT * FROM player",
        "SELECT * FROM player_action_state",
        "SELECT * FROM player_cooldown",
        "SELECT * FROM player_health",
        "SELECT * FROM player_input_ack",
        "SELECT * FROM player_resource",
        "SELECT * FROM player_slot_binding",
        "SELECT * FROM player_transform",
        "SELECT * FROM projectile",
      ]);
  });
}

async function joinAndWait(conn: DbConnection, identity: Identity, username: string) {
  await conn.reducers.joinGame({ username });
  await waitForRow(
    () => Array.from(conn.db.player.iter()).find(row => row.identity.toHexString() === identity.toHexString()),
    `player row for ${username}`,
  );
}

// ---------------------------------------------------------------------------
// Event-driven table watchers — push-based (table onInsert/onUpdate callbacks), never a
// poll loop: a predicate is checked against every row event as it arrives, and against the
// already-seen log for predicates that already came true before the waiter was registered.
// ---------------------------------------------------------------------------

type Waiter<T> = { pred: (row: T) => boolean; resolve: (row: T) => void; timer: ReturnType<typeof setTimeout> };

class RowWatcher<T> {
  readonly log: T[] = [];
  private waiters: Waiter<T>[] = [];

  push(row: T) {
    this.log.push(row);
    const remaining: Waiter<T>[] = [];
    for (const waiter of this.waiters) {
      if (waiter.pred(row)) {
        clearTimeout(waiter.timer);
        waiter.resolve(row);
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;
  }

  waitUntil(description: string, pred: (row: T) => boolean, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const already = this.log.find(pred);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w.resolve !== resolve);
        reject(new Error(`Timeout waiting for ${description} (${this.log.length} rows observed)`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, timer });
    });
  }
}

function watchActionState(conn: DbConnection, identity: Identity): RowWatcher<PlayerActionState> {
  const watcher = new RowWatcher<PlayerActionState>();
  const hex = identity.toHexString();
  const onRow = (row: PlayerActionState) => {
    if (row.identity.toHexString() === hex) watcher.push(row);
  };
  conn.db.player_action_state.onInsert((_ctx, row) => onRow(row));
  conn.db.player_action_state.onUpdate((_ctx, _old, row) => onRow(row));
  return watcher;
}

function watchActionEvents(conn: DbConnection): RowWatcher<ActionEvent> {
  const watcher = new RowWatcher<ActionEvent>();
  conn.db.action_event.onInsert((_ctx, row) => watcher.push(row));
  return watcher;
}

function watchProjectiles(conn: DbConnection): RowWatcher<Projectile> {
  const watcher = new RowWatcher<Projectile>();
  conn.db.projectile.onInsert((_ctx, row) => watcher.push(row));
  return watcher;
}

async function waitForRow<T>(read: () => T | undefined, description: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = read();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`Timeout waiting for ${description}`);
}

async function expectReject(fn: () => Promise<unknown>, descriptionOfExpectedError: string): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(`Expected rejection (${descriptionOfExpectedError}) but the reducer call succeeded`);
}

function findBinding(def: ActionDef): SlotBinding {
  const binding = SLOT_BINDINGS.find(b => b.tapAction === def.id || b.holdAction === def.id);
  assert(binding, `${def.id}: no SLOT_BINDINGS row binds it (shared/actions.json drift?)`);
  return binding;
}

function getResource(conn: DbConnection, identity: Identity, kind: string): PlayerResource | undefined {
  const hex = identity.toHexString();
  return Array.from(conn.db.player_resource.iter()).find(row => row.identity.toHexString() === hex && row.kind === kind);
}

function getTransform(conn: DbConnection, identity: Identity): PlayerTransform | undefined {
  const hex = identity.toHexString();
  return Array.from(conn.db.player_transform.iter()).find(row => row.identity.toHexString() === hex);
}

function getHealth(conn: DbConnection, identity: Identity): PlayerHealth | undefined {
  const hex = identity.toHexString();
  return Array.from(conn.db.player_health.iter()).find(row => row.identity.toHexString() === hex);
}

function getCooldown(conn: DbConnection, identity: Identity, actionId: string) {
  const hex = identity.toHexString();
  return Array.from(conn.db.player_cooldown.iter()).find(row => row.identity.toHexString() === hex && row.actionId === actionId);
}

async function press(conn: DbConnection, slot: string, aim?: Vector3) {
  await conn.reducers.actionInput({ slot, edge: InputEdge.Press, aim });
}
async function release(conn: DbConnection, slot: string, aim?: Vector3) {
  await conn.reducers.actionInput({ slot, edge: InputEdge.Release, aim });
}

/**
 * A dual-bound slot's Press always resolves through the HOLD action for the cooldown/resource
 * gate (`build_press_state` picks `holdAction.or(tapAction)` — see
 * `server/spacetimedb/src/actions/input.rs::handle_press`), even when the edge sequence ends up
 * resolving to the tap action. On "primary" that means driving `attack_light` still starts
 * `attack_heavy`'s cooldown, so immediately driving `attack_heavy` next (registry order) can
 * transiently 409 on a cooldown that isn't "its own" from the test's point of view. Retry
 * instead of hardcoding a wait for this one pair — it's a property of shared slots generically,
 * not of these two action ids.
 */
async function pressWithCooldownRetry(conn: DbConnection, slot: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await press(conn, slot);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/cooldown/i.test(message) || Date.now() > deadline) throw err;
      await sleep(100);
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 1: generic per-def drive + assert
// ---------------------------------------------------------------------------

/** Drives `def` to completion via its own slot binding, resolving tap-vs-hold correctly for
 * dual-bound slots (see docs/action-pipeline.md "Input: one reducer, raw edges"). */
async function driveDef(conn: DbConnection, def: ActionDef, binding: SlotBinding, watcher: RowWatcher<PlayerActionState>) {
  const isHoldSide = binding.holdAction === def.id;
  const dualBound = binding.tapAction !== null && binding.holdAction !== null;

  if (isHoldSide && def.hold) {
    await pressWithCooldownRetry(conn, binding.slot);
    if (def.hold.mode === "charge") {
      // Must clear the slot's own hold threshold, or the release resolves back to the TAP
      // action instead (docs/action-pipeline.md) — even though we pressed the hold action.
      const holdTicks = dualBound ? binding.holdThresholdTicks + 2 : 2;
      await sleep(holdTicks * TICK_MS);
      await release(conn, binding.slot);
    } else {
      // sustain: Press -> Windup -> Held (indefinite); wait for Held, then release.
      await watcher.waitUntil(`${def.id} reaches Held`, row => row.actionId === def.id && row.phase === Phase.Held);
      await sleep(2 * TICK_MS);
      await release(conn, binding.slot);
    }
  } else {
    // Tap path (possibly the tap side of a dual-bound slot, which enters the HOLD action's
    // Charging on Press — releasing well within the hold threshold resolves it back to tap).
    await pressWithCooldownRetry(conn, binding.slot);
    if (dualBound) await release(conn, binding.slot);
  }

  return watcher.waitUntil(`${def.id} returns to Idle`, row => row.phase === Phase.Idle, DEFAULT_TIMEOUT_MS);
}

function assertPhaseDurations(def: ActionDef, log: PlayerActionState[]) {
  const forDef = log.filter(row => row.actionId === def.id);

  const windup = forDef.find(row => row.phase === Phase.Windup);
  if (def.phases.windupTicks > 0) assert(windup, `${def.id}: expected a Windup row`);
  if (windup) {
    assert(
      ticks(windup.phaseStartedTick, windup.phaseEndsTick) === def.phases.windupTicks,
      `${def.id}: Windup duration ${ticks(windup.phaseStartedTick, windup.phaseEndsTick)} != windupTicks ${def.phases.windupTicks}`,
    );
  }

  const active = forDef.find(row => row.phase === Phase.Active);
  if (def.phases.activeTicks > 0) {
    assert(active, `${def.id}: expected an Active row`);
    assert(
      ticks(active!.phaseStartedTick, active!.phaseEndsTick) === def.phases.activeTicks,
      `${def.id}: Active duration mismatch`,
    );
  }

  const recovery = forDef.find(row => row.phase === Phase.Recovery);
  assert(recovery, `${def.id}: expected a Recovery row`);
  assert(
    ticks(recovery.phaseStartedTick, recovery.phaseEndsTick) === def.phases.recoveryTicks,
    `${def.id}: Recovery duration ${ticks(recovery.phaseStartedTick, recovery.phaseEndsTick)} != recoveryTicks ${def.phases.recoveryTicks}`,
  );
}

async function assertEventEmission(def: ActionDef, identity: Identity, events: RowWatcher<ActionEvent>, projectiles: RowWatcher<Projectile>) {
  const hex = identity.toHexString();
  const hasMeleeOrAoe = def.effects.some(e => e.kind === "melee_arc" || e.kind === "aoe_at_target");
  const hasHeal = def.effects.some(e => e.kind === "heal_self");
  const hasProjectile = def.effects.some(e => e.kind === "projectile");

  if (hasMeleeOrAoe) {
    // Solo run, no other player in range: must resolve to a miss, never silently nothing.
    await events.waitUntil(
      `${def.id} miss event (no target in range)`,
      row => row.actor.toHexString() === hex && row.actionId === def.id && row.kind === "miss",
    );
  }
  if (hasHeal) {
    await events.waitUntil(
      `${def.id} heal event`,
      row => row.actor.toHexString() === hex && row.actionId === def.id && row.kind === "heal",
    );
  }
  if (hasProjectile) {
    await projectiles.waitUntil(
      `${def.id} projectile spawn`,
      row => row.owner.toHexString() === hex && row.actionId === def.id,
    );
  }
}

/**
 * A def's own cooldown is gated from action START (Press), not completion — so a def whose
 * own drive duration (esp. a charge hold, e.g. attack_heavy's mandatory hold past the slot's
 * threshold) exceeds its own `cooldownTicks` can legitimately have already come off cooldown
 * by the time it returns to Idle. Compute the expectation from the actual `player_cooldown`
 * row instead of assuming "just finished -> still on cooldown" universally.
 */
async function assertCooldownRejection(conn: DbConnection, identity: Identity, def: ActionDef, binding: SlotBinding, idleRow: PlayerActionState) {
  if (def.cooldownTicks <= 0) return; // nothing to reject; a same-tick re-press must succeed
  const cooldown = getCooldown(conn, identity, def.id);
  const stillOnCooldown = !!cooldown && cooldown.readyTick > idleRow.serverTick;
  if (!stillOnCooldown) {
    console.log(`  cooldown already elapsed by completion (own cycle > cooldownTicks) — skipping rejection check`);
    return;
  }
  const message = await expectReject(() => press(conn, binding.slot), `${def.id} on cooldown`);
  assert(/cooldown/i.test(message), `${def.id}: expected a cooldown rejection, got: ${message}`);
  console.log(`  cooldown rejection ok: ${message}`);
}

async function assertResourceDecrement(conn: DbConnection, identity: Identity, def: ActionDef, binding: SlotBinding) {
  if (!def.resource) return;
  const before = getResource(conn, identity, def.resource.kind);
  assert(before, `${def.id}: expected a seeded player_resource row for kind ${def.resource.kind}`);
  const beforeAmount = before.amount;
  const cost = def.resource.cost;

  const watcher = watchActionState(conn, identity);
  await driveDef(conn, def, binding, watcher);

  const after = await waitForRow(
    () => getResource(conn, identity, def.resource!.kind),
    `${def.id}: player_resource row for ${def.resource.kind} after drive`,
  );
  assert(after.amount === beforeAmount - cost, `${def.id}: resource ${beforeAmount} -> ${after.amount}, expected -${cost}`);
}

async function runGenericPass(conn: DbConnection, identity: Identity) {
  console.log("\n--- PASS 1: generic per-def drive over every ACTION_DEFS row ---");
  const events = watchActionEvents(conn);
  const projectiles = watchProjectiles(conn);

  for (const def of ACTION_DEFS) {
    console.log(`[${def.id}] driving...`);
    const binding = findBinding(def);
    const watcher = watchActionState(conn, identity);

    const idleRow = await driveDef(conn, def, binding, watcher);
    assertPhaseDurations(def, watcher.log);
    await assertEventEmission(def, identity, events, projectiles);

    if (def.hold?.mode === "charge") {
      // Our drive holds well past the slot's threshold -> must resolve to the HOLD action and
      // emit a release event (ResolvedToTap, the other branch, does not emit one).
      await events.waitUntil(
        `${def.id} release event (charge resolved to hold)`,
        row => row.actor.toHexString() === identity.toHexString() && row.actionId === def.id && row.kind === "release",
      );
    }

    await assertCooldownRejection(conn, identity, def, binding, idleRow);
    console.log(`[${def.id}] ok (windup=${def.phases.windupTicks} active=${def.phases.activeTicks} recovery=${def.phases.recoveryTicks} cooldown=${def.cooldownTicks})`);
  }

  for (const def of ACTION_DEFS) {
    if (!def.resource) continue;
    console.log(`[${def.id}] resource decrement...`);
    await assertResourceDecrement(conn, identity, def, findBinding(def));
    console.log(`[${def.id}] resource ok`);
  }

  console.log("PASS 1 complete: every ActionDef drove, phased, gated, and emitted correctly.");
}

// ---------------------------------------------------------------------------
// Pass 2: two-identity damage case — arc hit, mitigation, i-frame
// ---------------------------------------------------------------------------

function angleToward(from: Vector3, to: Vector3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

async function moveWithinRange(conn: DbConnection, myIdentity: Identity, targetPos: () => Vector3, range: number) {
  let sequence = 0;
  let clientTick = 0;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const transform = await waitForRow(() => getTransform(conn, myIdentity), "mover transform");
    const target = targetPos();
    const dx = target.x - transform.position.x;
    const dz = target.z - transform.position.z;
    const distance = Math.hypot(dx, dz);
    const rotationY = angleToward(transform.position, target);
    sequence += 1;
    clientTick += 1;
    if (distance <= range) {
      await conn.reducers.updatePlayerInput({
        input: { forward: false, backward: false, left: false, right: false, sprint: false, jump: false, sequence, clientTick },
        rotationY,
      });
      return;
    }
    await conn.reducers.updatePlayerInput({
      input: { forward: true, backward: false, left: false, right: false, sprint: false, jump: false, sequence, clientTick },
      rotationY,
    });
    await sleep(100);
  }
  throw new Error(`Timed out closing to within ${range}m`);
}

async function main() {
  console.log(`Using SpacetimeDB URL: ${STDB_URL}`);
  console.log(`Using database: ${STDB_DB_NAME}`);

  // --- Pass 1: solo, generic over every def ---
  const solo = await connect("solo");
  await subscribeAll(solo.conn);
  await joinAndWait(solo.conn, solo.identity, `PipelineBot-${Date.now()}`);
  await runGenericPass(solo.conn, solo.identity);
  solo.conn.disconnect();

  // --- Pass 2: two identities, arc hit / mitigation / i-frame ---
  console.log("\n--- PASS 2: two-identity damage case (arc hit, mitigation, i-frame) ---");
  const attacker = await connect("attacker");
  const victim = await connect("victim");
  await Promise.all([subscribeAll(attacker.conn), subscribeAll(victim.conn)]);
  await joinAndWait(attacker.conn, attacker.identity, `AttackerBot-${Date.now()}`);
  await joinAndWait(victim.conn, victim.identity, `VictimBot-${Date.now()}`);

  const attackLight = ACTION_DEFS.find(def => def.id === "attack_light");
  assert(attackLight, "expected an attack_light def for the damage case");
  const meleeEffect = attackLight.effects.find(e => e.kind === "melee_arc");
  assert(meleeEffect?.kind === "melee_arc", "attack_light must carry a melee_arc effect");
  const primaryBinding = SLOT_BINDINGS.find(b => b.tapAction === "attack_light");
  assert(primaryBinding, "expected a slot binding for attack_light");
  const blockBinding = SLOT_BINDINGS.find(b => b.holdAction === "block");
  assert(blockBinding, "expected a slot binding for block");
  const rollDef = ACTION_DEFS.find(def => def.id === "roll");
  assert(rollDef, "expected a roll def");
  const rollBinding = SLOT_BINDINGS.find(b => b.tapAction === "roll");
  assert(rollBinding, "expected a slot binding for roll");
  assert(rollDef.effects.some(e => e.kind === "invulnerable"), "sanity: roll must carry the invulnerable effect this case is testing");

  const attackerEvents = watchActionEvents(attacker.conn);
  const attackerHex = attacker.identity.toHexString();
  const victimHex = victim.identity.toHexString();

  console.log("closing distance between attacker and victim...");
  // Each identity's subscription is its own connection, delivered independently — wait until
  // the attacker's own connection has actually received the victim's transform row before
  // reading its position (a fresh join on one connection isn't guaranteed visible on another
  // the instant that connection's own join call resolves).
  await waitForRow(() => getTransform(attacker.conn, victim.identity), "attacker's view of victim transform");
  await moveWithinRange(attacker.conn, attacker.identity, () => getTransform(attacker.conn, victim.identity)!.position, 1.5);
  await sleep(200); // let the settle input land before combat timing starts

  // 1. Arc hit: plain attack_light against an idle victim -> full raw damage.
  console.log("case: arc hit");
  const healthBeforeHit = getHealth(victim.conn, victim.identity)!.currentHealth;
  await pressWithCooldownRetry(attacker.conn, primaryBinding.slot);
  await release(attacker.conn, primaryBinding.slot);
  const hitEvent = await attackerEvents.waitUntil(
    "attack_light hit event against victim",
    row => row.actor.toHexString() === attackerHex && row.target?.toHexString() === victimHex && row.kind === "hit",
  );
  assert(hitEvent.amount === meleeEffect.damage.min, `expected raw damage ${meleeEffect.damage.min}, got ${hitEvent.amount}`);
  const healthAfterHit = await waitForRow(
    () => {
      const health = getHealth(victim.conn, victim.identity);
      return health && health.currentHealth === healthBeforeHit - hitEvent.amount ? health : undefined;
    },
    "victim health decremented by hit amount",
  );
  console.log(`  ok: hit for ${hitEvent.amount} (${healthBeforeHit} -> ${healthAfterHit.currentHealth})`);

  // 2. Mitigation: victim blocks (Held) -> blockedDamage, not raw damage.
  console.log("case: block mitigation");
  const victimActionState = watchActionState(victim.conn, victim.identity);
  await press(victim.conn, blockBinding.slot);
  await victimActionState.waitUntil("victim block reaches Held", row => row.actionId === "block" && row.phase === Phase.Held);
  const healthBeforeBlock = getHealth(victim.conn, victim.identity)!.currentHealth;
  await pressWithCooldownRetry(attacker.conn, primaryBinding.slot);
  await release(attacker.conn, primaryBinding.slot);
  const blockedEvent = await attackerEvents.waitUntil(
    "attack_light blocked event against victim",
    row => row.actor.toHexString() === attackerHex && row.target?.toHexString() === victimHex && row.kind === "blocked" && row.serverTick > hitEvent.serverTick,
  );
  assert(blockedEvent.amount === meleeEffect.blockedDamage.min, `expected blocked damage ${meleeEffect.blockedDamage.min}, got ${blockedEvent.amount}`);
  const healthAfterBlock = await waitForRow(
    () => {
      const health = getHealth(victim.conn, victim.identity);
      return health && health.currentHealth === healthBeforeBlock - blockedEvent.amount ? health : undefined;
    },
    "victim health decremented by blocked amount",
  );
  console.log(`  ok: blocked for ${blockedEvent.amount} (${healthBeforeBlock} -> ${healthAfterBlock.currentHealth})`);
  await release(victim.conn, blockBinding.slot);
  await victimActionState.waitUntil("victim block exits to Idle", row => row.phase === Phase.Idle && row.actionId === "");

  // 3. I-frame: victim rolls (Active window is invulnerable) -> attack must miss entirely.
  console.log("case: roll invulnerability window");
  const healthBeforeRoll = getHealth(victim.conn, victim.identity)!.currentHealth;
  await press(victim.conn, rollBinding.slot);
  await victimActionState.waitUntil("victim roll reaches Active", row => row.actionId === "roll" && row.phase === Phase.Active);
  await pressWithCooldownRetry(attacker.conn, primaryBinding.slot);
  await release(attacker.conn, primaryBinding.slot);
  const missEvent = await attackerEvents.waitUntil(
    "attack_light event against invulnerable victim",
    row => row.actor.toHexString() === attackerHex && row.actionId === "attack_light" && row.serverTick > blockedEvent.serverTick,
  );
  assert(missEvent.kind === "miss", `expected a miss against an invulnerable victim, got kind=${missEvent.kind}`);
  assert(missEvent.amount === 0, `expected 0 damage against an invulnerable victim, got ${missEvent.amount}`);
  await victimActionState.waitUntil("victim roll returns to Idle", row => row.phase === Phase.Idle && row.actionId === "");
  const healthAfterRoll = getHealth(victim.conn, victim.identity)!.currentHealth;
  assert(healthAfterRoll === healthBeforeRoll, `expected health unchanged during the i-frame window, ${healthBeforeRoll} -> ${healthAfterRoll}`);
  console.log(`  ok: attack missed an invulnerable victim (health held at ${healthAfterRoll})`);

  attacker.conn.disconnect();
  victim.conn.disconnect();

  console.log("\nPASS 2 complete: arc hit, mitigation, and i-frame all verified against live server rows.");
  console.log("\nAction pipeline test passed.");
}

main().catch(err => {
  console.error("\nAction pipeline test failed:", err);
  process.exit(1);
});
