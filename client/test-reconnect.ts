/**
 * Live-SpacetimeDB regression test for join/disconnect/rejoin state persistence.
 * No browser: connects directly with the generated SDK client (vite-node style), like the
 * pre-rewrite `client/test-reconnect.ts` (`git show 9f9fc5c:client/test-reconnect.ts`) this
 * recreates for the v2 schema (single `join_game(username)` reducer, no character class).
 *
 * A raw websocket close (no explicit `leave_game`) triggers the server's
 * `identity_disconnected` reducer, which — once no session for that identity remains —
 * calls `player::cleanup_player`: the live rows (`player`, `player_transform`,
 * `player_health`, ...) are deleted and folded into `logged_out_player`, keyed by identity.
 * Reconnecting with the SAME saved auth token restores the same identity; calling
 * `join_game` again restores from `logged_out_player` rather than creating a new player —
 * notably, it restores the ORIGINAL username and ignores whatever username the reconnect
 * call passes, which this test uses to prove restoration (not renaming) is what happened.
 */
import { Identity } from "spacetimedb";
import { DbConnection } from "./src/generated";
import { loadSavedAuthToken, saveAuthToken } from "./src/authStorage";
import type { PlayerData, PlayerHealth, PlayerInputAck, PlayerTransform } from "./src/generated/types";

const STDB_URL = process.env.STDB_URL ?? "ws://127.0.0.1:3000";
const STDB_DB_NAME = process.env.STDB_DB_NAME ?? "mog-game-v1";
const TEST_USERNAME = process.env.STDB_TEST_USERNAME ?? `ReconnectBot-${Date.now()}`;
const SKIP_CONCURRENT_SESSION = process.env.STDB_SKIP_CONCURRENT_SESSION === "1";
const TEST_TIMEOUT_MS = 15000;

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor<T>(description: string, read: () => T | undefined): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < TEST_TIMEOUT_MS) {
    const value = read();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timeout waiting for ${description}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function identityMatches(identity: Identity | undefined) {
  const hex = identity?.toHexString();
  return (row: { identity: Identity }) => row.identity.toHexString() === hex;
}

function getPlayer(conn: DbConnection, identity: Identity | undefined): PlayerData | undefined {
  return Array.from(conn.db.player.iter()).find(identityMatches(identity));
}
function getHealth(conn: DbConnection, identity: Identity | undefined): PlayerHealth | undefined {
  return Array.from(conn.db.player_health.iter()).find(identityMatches(identity));
}
function getTransform(conn: DbConnection, identity: Identity | undefined): PlayerTransform | undefined {
  return Array.from(conn.db.player_transform.iter()).find(identityMatches(identity));
}
function getInputAck(conn: DbConnection, identity: Identity | undefined): PlayerInputAck | undefined {
  return Array.from(conn.db.player_input_ack.iter()).find(identityMatches(identity));
}

const SUBSCRIPTIONS = [
  "SELECT * FROM player",
  "SELECT * FROM player_health",
  "SELECT * FROM player_transform",
  "SELECT * FROM player_input_ack",
];

async function subscribe(conn: DbConnection, queries = SUBSCRIPTIONS) {
  await new Promise<void>(resolve => {
    conn.subscriptionBuilder().onApplied(() => resolve()).subscribe(queries);
  });
}

function connect(storage: MemoryStorage): Promise<{ conn: DbConnection; identity: Identity; token: string }> {
  return new Promise((resolve, reject) => {
    const savedToken = loadSavedAuthToken(storage);
    console.log(savedToken ? "Connecting with saved token..." : "Connecting with new anonymous identity...");

    const builder = DbConnection.builder()
      .withUri(STDB_URL)
      .withDatabaseName(STDB_DB_NAME)
      .onConnect((conn, identity, token) => {
        saveAuthToken(token, storage);
        console.log(`Connected: ${identity.toHexString()}`);
        resolve({ conn, identity, token });
      })
      .onConnectError((_ctx, err) => {
        reject(new Error(
          `Failed to connect to ${STDB_URL}. Check that the target SpacetimeDB websocket is reachable.`,
          { cause: err },
        ));
      });

    if (savedToken) builder.withToken(savedToken);
    builder.build();
  });
}

async function runTest() {
  console.log("Starting reconnection test...");
  console.log(`Using SpacetimeDB URL: ${STDB_URL}`);
  console.log(`Using database: ${STDB_DB_NAME}`);
  console.log(`Using test username: ${TEST_USERNAME}`);
  console.log(`Concurrent session step: ${SKIP_CONCURRENT_SESSION ? "skipped" : "enabled"}`);
  const storage = new MemoryStorage();

  let conn1: DbConnection | undefined;
  let conn2: DbConnection | undefined;
  let conn3: DbConnection | undefined;

  try {
    console.log("\n--- STEP 1: Initial join saves token ---");
    const first = await connect(storage);
    conn1 = first.conn;
    await subscribe(conn1);

    await conn1.reducers.joinGame({ username: TEST_USERNAME });

    const player1 = await waitFor("initial player row", () => getPlayer(conn1!, first.identity));
    const health1 = await waitFor("initial health row", () => getHealth(conn1!, first.identity));
    assert(loadSavedAuthToken(storage) === first.token, "Expected first token to be saved");
    assert(player1.username === TEST_USERNAME, `Expected username ${TEST_USERNAME}, got ${player1.username}`);
    console.log(`Initial state: username=${player1.username}, health=${health1.currentHealth}`);

    let sequence = 0;
    let clientTick = 0;
    const sendMovement = async (forward: boolean) => {
      sequence += 1;
      clientTick += 1;
      conn1!.reducers.updatePlayerInput({
        input: { forward, backward: false, left: false, right: false, sprint: false, jump: false, sequence, clientTick },
        rotationY: 0,
      });
      return sequence;
    };

    const movedSeq = await sendMovement(true);
    const movedTransform = await waitFor("movement before disconnect", () => {
      const transform = getTransform(conn1!, first.identity);
      const ack = getInputAck(conn1!, first.identity);
      return transform && ack && ack.lastInputSeq >= movedSeq ? transform : undefined;
    });
    console.log(`Moved to z=${movedTransform.position.z.toFixed(3)} before disconnect`);
    await sleep(300); // let a couple more ticks of forward motion land before stopping

    const settledSeq = await sendMovement(false);
    const settledTransform = await waitFor("settled movement before disconnect", () => {
      const transform = getTransform(conn1!, first.identity);
      const ack = getInputAck(conn1!, first.identity);
      return transform && ack && ack.lastInputSeq >= settledSeq ? transform : undefined;
    });
    console.log(`Settled at z=${settledTransform.position.z.toFixed(3)} before disconnect`);
    assert(settledTransform.position.z !== movedTransform.position.z || movedTransform.position.z !== 0, "expected the player to have actually moved before disconnect");

    console.log("\n--- STEP 2: Reconnect with saved token restores identity + state ---");
    conn1.disconnect();
    conn1 = undefined;
    await sleep(2000); // give identity_disconnected -> cleanup_player time to run server-side

    const second = await connect(storage);
    conn2 = second.conn;
    await subscribe(conn2);

    assert(
      second.identity.toHexString() === first.identity.toHexString(),
      "Expected saved token to restore the original identity",
    );

    const isAlreadyJoined = !!getPlayer(conn2, second.identity);
    console.log(`Player row present before re-join: ${isAlreadyJoined}`);
    assert(!isAlreadyJoined, "Expected cleanup_player to have deleted the live player row on disconnect");

    // join_game restores from logged_out_player and ignores this username — proving restore,
    // not accidental rename, is what happened (docs/action-pipeline.md's schema is silent on
    // this; behavior is asserted directly against the server, see player.rs::join_game).
    await conn2.reducers.joinGame({ username: `${TEST_USERNAME}-ResetAttempt` });
    const player2 = await waitFor("restored player row", () => getPlayer(conn2!, second.identity));
    const health2 = await waitFor("restored health row", () => getHealth(conn2!, second.identity));
    const transform2 = await waitFor("restored transform row", () => getTransform(conn2!, second.identity));

    assert(player2.username === TEST_USERNAME, `Expected restored username ${TEST_USERNAME}, got ${player2.username}`);
    assert(health2.currentHealth === health1.currentHealth, "Expected health to be preserved across reconnect");
    assert(
      Math.abs(transform2.position.z - settledTransform.position.z) < 0.25,
      `Expected restored z near ${settledTransform.position.z}, got ${transform2.position.z}`,
    );

    console.log(
      `Restored state: username=${player2.username}, health=${health2.currentHealth}, z=${transform2.position.z.toFixed(3)}`,
    );

    if (SKIP_CONCURRENT_SESSION) {
      console.log("\n--- STEP 3: Concurrent tab check skipped ---");
      console.log("\nReconnect test passed.");
      return;
    }

    console.log("\n--- STEP 3: Concurrent tab with saved token sees the active player ---");
    const third = await connect(storage);
    conn3 = third.conn;
    await subscribe(conn3, ["SELECT * FROM player"]);

    assert(
      third.identity.toHexString() === first.identity.toHexString(),
      "Expected concurrent saved-token connection to use the same identity",
    );
    assert(!!getPlayer(conn3, third.identity), "Expected concurrent connection to see the active player row");

    console.log("\nReconnect test passed.");
  } finally {
    conn1?.disconnect();
    conn2?.disconnect();
    conn3?.disconnect();
  }
}

runTest().catch(err => {
  console.error("\nReconnect test failed:", err);
  process.exit(1);
});
