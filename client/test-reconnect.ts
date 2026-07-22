import { Identity } from "spacetimedb";
import { DbConnection } from "./src/generated";
import {
  loadSavedAuthToken,
  saveAuthToken,
  saveJoinPreferences,
} from "./src/authStorage";
import type { PlayerCharacter, PlayerData, PlayerHealth, PlayerInputAck, PlayerTransform } from "./src/generated/types";

const STDB_URL = process.env.STDB_URL ?? "ws://127.0.0.1:3000";
const STDB_DB_NAME = process.env.STDB_DB_NAME ?? "mog-game-v1";
const TEST_USERNAME = process.env.STDB_TEST_USERNAME ?? `ReconnectBot-${Date.now()}`;
const SKIP_CONCURRENT_SESSION = process.env.STDB_SKIP_CONCURRENT_SESSION === "1";
const CONCURRENT_PLAYER_ONLY = process.env.STDB_CONCURRENT_PLAYER_ONLY === "1";
const CONCURRENT_OBSERVE_MS = Number(process.env.STDB_CONCURRENT_OBSERVE_MS ?? "0");
const TEST_TIMEOUT_MS = 10000;

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor<T>(description: string, read: () => T | undefined): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < TEST_TIMEOUT_MS) {
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

function getHealth(conn: DbConnection, identity: Identity | undefined): PlayerHealth | undefined {
  return Array.from(conn.db.player_health.iter()).find(identityMatches(identity));
}

function getCharacter(conn: DbConnection, identity: Identity | undefined): PlayerCharacter | undefined {
  return Array.from(conn.db.player_character.iter()).find(identityMatches(identity));
}

function getTransform(conn: DbConnection, identity: Identity | undefined): PlayerTransform | undefined {
  return Array.from(conn.db.player_transform.iter()).find(identityMatches(identity));
}

function getInputAck(conn: DbConnection, identity: Identity | undefined): PlayerInputAck | undefined {
  return Array.from(conn.db.player_input_ack.iter()).find(identityMatches(identity));
}

async function subscribe(conn: DbConnection, queries = [
  "SELECT * FROM player",
  "SELECT * FROM player_health",
  "SELECT * FROM player_character",
  "SELECT * FROM player_transform",
  "SELECT * FROM player_input_ack",
]) {
  await new Promise<void>((resolve) => {
    conn.subscriptionBuilder()
      .onApplied(() => resolve())
      .subscribe(queries);
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
          `Failed to connect to ${STDB_URL}. ` +
          "Check that the target SpacetimeDB websocket is reachable and that sandboxed runs have network approval.",
          { cause: err },
        ));
      });

    if (savedToken) {
      builder.withToken(savedToken);
    }

    builder.build();
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function runTest() {
  console.log("Starting reconnection test...");
  console.log(`Using SpacetimeDB URL: ${STDB_URL}`);
  console.log(`Using database: ${STDB_DB_NAME}`);
  console.log(`Using test username: ${TEST_USERNAME}`);
  console.log(`Concurrent session step: ${SKIP_CONCURRENT_SESSION ? "skipped" : "enabled"}`);
  if (!SKIP_CONCURRENT_SESSION && CONCURRENT_OBSERVE_MS > 0) {
    console.log(`Concurrent observation window: ${CONCURRENT_OBSERVE_MS}ms`);
  }
  const storage = new MemoryStorage();

  let conn1: DbConnection | undefined;
  let conn2: DbConnection | undefined;
  let conn3: DbConnection | undefined;

  try {
    console.log("\n--- STEP 1: Initial join saves token and preferences ---");
    const first = await connect(storage);
    conn1 = first.conn;
    await subscribe(conn1);

    saveJoinPreferences({ username: TEST_USERNAME, characterClass: "paladin" }, storage);
    conn1.reducers.joinGameAs({ username: TEST_USERNAME, characterClass: "paladin" });

    const player1 = await waitFor("initial player row", () => getPlayer(conn1!, first.identity));
    const health1 = await waitFor("initial health row", () => getHealth(conn1!, first.identity));
    const class1 = await waitFor("initial class row", () => getCharacter(conn1!, first.identity));
    assert(loadSavedAuthToken(storage) === first.token, "Expected first token to be saved");
    assert(player1.username === TEST_USERNAME, `Expected username ${TEST_USERNAME}, got ${player1.username}`);
    assert(class1.characterClass === "paladin", `Expected paladin class, got ${class1.characterClass}`);
    console.log(`Initial state: username=${player1.username}, class=${class1.characterClass}, health=${health1.currentHealth}`);

    conn1.reducers.updatePlayerInput({
      input: {
        forward: true,
        backward: false,
        left: false,
        right: false,
        sprint: false,
        jump: false,
        sequence: 1,
      },
      rotationY: 0,
    });
    const movedTransform = await waitFor("movement before disconnect", () => {
      const transform = getTransform(conn1!, first.identity);
      const ack = getInputAck(conn1!, first.identity);
      return transform && ack && ack.lastInputSeq >= 1 ? transform : undefined;
    });
    console.log(`Moved to z=${movedTransform.position.z.toFixed(3)} before disconnect`);

    conn1.reducers.updatePlayerInput({
      input: {
        forward: false,
        backward: false,
        left: false,
        right: false,
        sprint: false,
        jump: false,
        sequence: 2,
      },
      rotationY: 0,
    });
    const settledTransform = await waitFor("settled movement before disconnect", () => {
      const transform = getTransform(conn1!, first.identity);
      const ack = getInputAck(conn1!, first.identity);
      return transform && ack && ack.lastInputSeq >= 2 ? transform : undefined;
    });
    console.log(`Settled at z=${settledTransform.position.z.toFixed(3)} before disconnect`);

    console.log("\n--- STEP 2: Reconnect with saved token after logout cleanup ---");
    conn1.disconnect();
    conn1 = undefined;
    await sleep(2000);

    const second = await connect(storage);
    conn2 = second.conn;
    await subscribe(conn2);

    assert(
      second.identity.toHexString() === first.identity.toHexString(),
      "Expected saved token to restore the original identity",
    );

    const isAlreadyJoined = !!getPlayer(conn2, second.identity);
    console.log(`Already joined before reducer call: ${isAlreadyJoined}`);

    conn2.reducers.joinGameAs({ username: `${TEST_USERNAME}-ResetAttempt`, characterClass: "wizard" });
    const player2 = await waitFor("restored player row", () => getPlayer(conn2!, second.identity));
    const health2 = await waitFor("restored health row", () => getHealth(conn2!, second.identity));
    const class2 = await waitFor("restored class row", () => getCharacter(conn2!, second.identity));
    const transform2 = await waitFor("restored transform row", () => getTransform(conn2!, second.identity));

    assert(player2.username === TEST_USERNAME, `Expected restored username ${TEST_USERNAME}, got ${player2.username}`);
    assert(class2.characterClass === "paladin", `Expected restored paladin class, got ${class2.characterClass}`);
    assert(health2.currentHealth === health1.currentHealth, "Expected health to be preserved across reconnect");
    assert(
      Math.abs(transform2.position.z - settledTransform.position.z) < 0.25,
      `Expected restored z near ${settledTransform.position.z}, got ${transform2.position.z}`,
    );

    console.log(
      `Restored state: username=${player2.username}, class=${class2.characterClass}, health=${health2.currentHealth}, z=${transform2.position.z.toFixed(3)}`,
    );

    if (SKIP_CONCURRENT_SESSION) {
      console.log("\n--- STEP 3: Concurrent tab check skipped ---");
      console.log("\nReconnect test passed.");
      return;
    }

    console.log("\n--- STEP 3: Concurrent tab with saved token sees active player ---");
    const third = await connect(storage);
    conn3 = third.conn;
    await subscribe(conn3, CONCURRENT_PLAYER_ONLY ? ["SELECT * FROM player"] : undefined);

    assert(
      third.identity.toHexString() === first.identity.toHexString(),
      "Expected concurrent saved-token connection to use the same identity",
    );
    assert(!!getPlayer(conn3, third.identity), "Expected concurrent connection to see the active player row");
    if (CONCURRENT_OBSERVE_MS > 0) {
      await sleep(CONCURRENT_OBSERVE_MS);
    }

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
