import { Identity } from "spacetimedb";
import { DbConnection } from "./src/generated";
import type { CombatEvent, PlayerActionState, PlayerAnimation, PlayerData } from "./src/generated/types";

const STDB_URL = process.env.STDB_URL ?? "ws://127.0.0.1:3000";
const STDB_DB_NAME = process.env.STDB_DB_NAME ?? "mog-game-v1";
const TEST_USERNAME = process.env.STDB_TEST_USERNAME ?? `ActionBot-${Date.now()}`;
const TEST_TIMEOUT_MS = 10000;
const COMBAT_EVENT_CLEANUP_TIMEOUT_MS = Number(process.env.COMBAT_EVENT_CLEANUP_TIMEOUT_MS ?? "20000");

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor<T>(
  description: string,
  read: () => T | undefined,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = read();
    if (value) return value;
    await sleep(100);
  }

  throw new Error(`Timeout waiting for ${description}`);
}

function identityMatches(identity: Identity | undefined) {
  const identityHex = identity?.toHexString();
  return (row: { identity: Identity }) => row.identity.toHexString() === identityHex;
}

function getPlayer(conn: DbConnection, identity: Identity | undefined): PlayerData | undefined {
  return Array.from(conn.db.player.iter()).find(identityMatches(identity));
}

function getActionState(conn: DbConnection, identity: Identity | undefined): PlayerActionState | undefined {
  return Array.from(conn.db.player_action_state.iter()).find(identityMatches(identity));
}

function getPlayerAnimation(conn: DbConnection, identity: Identity | undefined): PlayerAnimation | undefined {
  return Array.from(conn.db.player_animation.iter()).find(identityMatches(identity));
}

function getCombatEvents(conn: DbConnection, identity: Identity | undefined): CombatEvent[] {
  const identityHex = identity?.toHexString();
  return Array.from(conn.db.combat_event.iter()).filter(event =>
    event.attacker.toHexString() === identityHex || event.target.toHexString() === identityHex
  );
}

function connect(): Promise<{ conn: DbConnection; identity: Identity }> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(STDB_URL)
      .withDatabaseName(STDB_DB_NAME)
      .onConnect((conn, identity) => {
        console.log(`Connected: ${identity.toHexString()}`);
        resolve({ conn, identity });
      })
      .onConnectError((_ctx, err) => {
        reject(new Error(
          `Failed to connect to ${STDB_URL}. Publish the action-state module before running this test against a shared VM.`,
          { cause: err },
        ));
      })
      .build();
  });
}

async function subscribe(conn: DbConnection) {
  await new Promise<void>((resolve) => {
    conn.subscriptionBuilder()
      .onApplied(() => resolve())
      .subscribe([
        "SELECT * FROM player",
        "SELECT * FROM player_action_state",
        "SELECT * FROM player_animation",
        "SELECT * FROM player_character",
        "SELECT * FROM combat_event",
      ]);
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function runTest() {
  console.log("Starting combat action-state test...");
  console.log(`Using SpacetimeDB URL: ${STDB_URL}`);
  console.log(`Using database: ${STDB_DB_NAME}`);
  console.log(`Using test username: ${TEST_USERNAME}`);

  let conn: DbConnection | undefined;

  try {
    const connected = await connect();
    conn = connected.conn;
    await subscribe(conn);

    conn.reducers.joinGameAs({ username: TEST_USERNAME, characterClass: "paladin" });
    await waitFor("joined player row", () => getPlayer(conn!, connected.identity));

    const idleState = await waitFor("idle action state after join", () => {
      const actionState = getActionState(conn!, connected.identity);
      return actionState?.currentAction === "idle" ? actionState : undefined;
    });
    assert(idleState.canMove, "Idle state should allow movement");
    assert(idleState.canRotate, "Idle state should allow rotation");
    assert(idleState.canAttack, "Idle state should allow attack");
    assert(idleState.canBlock, "Idle state should allow block");
    assert(idleState.feedbackPolicy === "server_accepted", `Unexpected feedback policy ${idleState.feedbackPolicy}`);
    console.log("Idle action state accepted.");

    conn.reducers.triggerSlashAttack({});
    const slashState = await waitFor("attacking action state after slash", () => {
      const actionState = getActionState(conn!, connected.identity);
      return actionState?.currentAction === "attacking" ? actionState : undefined;
    });
    const slashAnimation = await waitFor("slash animation after slash", () => {
      const playerAnimation = getPlayerAnimation(conn!, connected.identity);
      return playerAnimation?.activeAnimation === "slash" ? playerAnimation : undefined;
    });
    assert(slashState.canMove, "Slash state should currently allow movement");
    assert(slashState.canRotate, "Slash state should currently allow rotation");
    assert(!slashState.canAttack, "Slash state should disallow another attack");
    assert(!slashState.canBlock, "Slash state should disallow block during recovery");
    assert(slashState.actionActiveTick >= slashState.actionStartedTick, "Slash active tick should be at or after start");
    assert(slashState.actionEndsTick >= slashState.actionActiveTick, "Slash end tick should be at or after active tick");
    assert(slashState.actionEndsTick >= slashState.cooldownEndsTick, "Slash action end should cover cooldown");
    console.log("Slash action state accepted.");

    const firstSlashAttackSeq = slashAnimation.attackSeq;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      conn.reducers.triggerSlashAttack({});
      await sleep(50);
    }
    const spammedSlashAnimation = getPlayerAnimation(conn, connected.identity);
    assert(
      spammedSlashAnimation?.attackSeq === firstSlashAttackSeq,
      `Slash spam should not trigger accepted animations during cooldown; expected attackSeq ${firstSlashAttackSeq}, got ${spammedSlashAnimation?.attackSeq}`,
    );
    const slashMissEvent = await waitFor("authoritative slash miss event", () => {
      const event = getCombatEvents(conn!, connected.identity)
        .find(combatEvent =>
          combatEvent.eventType === "slash_miss" &&
          combatEvent.attacker.toHexString() === connected.identity.toHexString() &&
          combatEvent.target.toHexString() === connected.identity.toHexString()
        );
      return event?.amount === 0 ? event : undefined;
    });
    console.log("Slash spam cooldown rejected.");

    conn.reducers.startBlock({});
    await sleep(200);
    const blockedDuringSlashState = getActionState(conn, connected.identity);
    assert(
      blockedDuringSlashState?.currentAction !== "blocking",
      "Block should not start while slash action is recovering",
    );

    await waitFor("idle action state after slash cooldown", () => {
      const actionState = getActionState(conn!, connected.identity);
      return actionState?.currentAction === "idle" && actionState.canAttack ? actionState : undefined;
    });

    conn.reducers.startBlock({});
    const blockState = await waitFor("blocking action state after block", () => {
      const actionState = getActionState(conn!, connected.identity);
      return actionState?.currentAction === "blocking" ? actionState : undefined;
    });
    assert(blockState.canMove, "Block state should currently allow movement");
    assert(blockState.canRotate, "Block state should currently allow rotation");
    assert(!blockState.canAttack, "Block state should disallow attack");
    assert(!blockState.canBlock, "Block state should disallow repeated block");
    assert(
      Number(blockState.actionEndsTick) === 0,
      `Held block should not have a fixed action end tick; observed actionEndsTick=${blockState.actionEndsTick}, cooldownEndsTick=${blockState.cooldownEndsTick}, serverTick=${blockState.serverTick}`,
    );
    console.log("Held block action state accepted.");

    await sleep(900);
    const heldBlockState = getActionState(conn, connected.identity);
    assert(
      heldBlockState?.currentAction === "blocking",
      "Block should remain active while held instead of expiring on the old timed window",
    );

    const blockAttackSeq = getPlayerAnimation(conn, connected.identity)?.attackSeq ?? firstSlashAttackSeq;
    conn.reducers.triggerSlashAttack({});
    await sleep(200);
    const slashDuringBlockAnimation = getPlayerAnimation(conn, connected.identity);
    assert(
      slashDuringBlockAnimation?.attackSeq === blockAttackSeq,
      "Slash should not be accepted while block is held",
    );

    conn.reducers.stopBlock({});
    const blockRecoveryState = await waitFor("block recovery state after release", () => {
      const actionState = getActionState(conn!, connected.identity);
      return actionState?.currentAction === "idle" && !actionState.canAttack && !actionState.canBlock
        ? actionState
        : undefined;
    });
    assert(
      blockRecoveryState.actionRecoveryUntilTick >= blockRecoveryState.serverTick,
      "Released block should enter a short recovery",
    );

    await waitFor("idle action state after block recovery", () => {
      const actionState = getActionState(conn!, connected.identity);
      return actionState?.currentAction === "idle" && actionState.canAttack && actionState.canBlock
        ? actionState
        : undefined;
    });
    console.log("Held block release and recovery accepted.");

    conn.reducers.triggerBlockAnimation({});
    const legacyBlockState = await waitFor("finite legacy block state after trigger_block_animation", () => {
      const actionState = getActionState(conn!, connected.identity);
      return actionState?.currentAction === "blocking" && Number(actionState.actionEndsTick) > 0
        ? actionState
        : undefined;
    });
    assert(
      legacyBlockState.actionEndsTick > legacyBlockState.serverTick,
      `Legacy block should have a finite end tick; observed actionEndsTick=${legacyBlockState.actionEndsTick}, serverTick=${legacyBlockState.serverTick}`,
    );

    await waitFor("idle action state after legacy block window expires", () => {
      const actionState = getActionState(conn!, connected.identity);
      return actionState?.currentAction === "idle" && actionState.canAttack && actionState.canBlock
        ? actionState
        : undefined;
    });
    console.log("Legacy block reducer compatibility accepted.");

    await waitFor("old combat event cleanup", () => {
      const stillPresent = getCombatEvents(conn!, connected.identity)
        .some(combatEvent => combatEvent.id.toString() === slashMissEvent.id.toString());
      return stillPresent ? undefined : true;
    }, COMBAT_EVENT_CLEANUP_TIMEOUT_MS);
    console.log("Combat event retention cleanup accepted.");

    console.log("\nCombat action-state test passed.");
  } finally {
    conn?.disconnect();
  }
}

runTest().catch(err => {
  console.error("\nCombat action-state test failed:", err);
  process.exit(1);
});
