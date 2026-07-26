/**
 * One generic table→store subscription mechanism for all 12 tables, in place
 * of the old per-table switch (the pre-rewrite `useGameTableSync` was a
 * 602-line hand-written case per table). Adding a 13th table is a row in
 * `TABLE_REGISTRY`, never a new function.
 *
 * Each row ties a table name to (a) the row's string key and (b) how to reach
 * the table's live handle off `connection.db`. `defineTable` binds those to
 * the same `Row` type parameter, so a mismatched key/accessor pair is a
 * compile error rather than a runtime one.
 *
 * SpacetimeDB delivers a subscription's initial rows as ordinary insert
 * events on the same table handle used for live updates (there is no
 * separate "initial batch" callback in this SDK), so attaching listeners
 * before `.subscribe()` resolves is sufficient to catch everything. `ready`
 * is still tracked explicitly: `markReady()` is called from the
 * `onSubscriptionApplied` callback (see `network/useSpacetimeConnection.ts`),
 * giving callers an explicit "the initial sync landed" signal instead of
 * inferring it from row counts.
 */

import type { DbConnection, EventContext } from '../generated';
import type {
  ActionEvent,
  Config,
  GameTickSchedule,
  PlayerActionState,
  PlayerCooldown,
  PlayerData,
  PlayerHealth,
  PlayerInputAck,
  PlayerResource,
  PlayerSlotBinding,
  PlayerTransform,
  Projectile,
} from '../generated/types';

/** The runtime shape SpacetimeDB table handles expose — kept local so this module only depends on `../generated`. */
interface TableHandle<Row> {
  onInsert(callback: (ctx: EventContext, row: Row) => void): void;
  removeOnInsert(callback: (ctx: EventContext, row: Row) => void): void;
  onUpdate(callback: (ctx: EventContext, oldRow: Row, newRow: Row) => void): void;
  removeOnUpdate(callback: (ctx: EventContext, oldRow: Row, newRow: Row) => void): void;
  onDelete(callback: (ctx: EventContext, row: Row) => void): void;
  removeOnDelete(callback: (ctx: EventContext, row: Row) => void): void;
}

/** Row type per table, by store key. The single place that lists all 12 tables' shapes. */
interface RowMap {
  player: PlayerData;
  playerTransform: PlayerTransform;
  playerHealth: PlayerHealth;
  playerActionState: PlayerActionState;
  playerInputAck: PlayerInputAck;
  playerCooldown: PlayerCooldown;
  playerResource: PlayerResource;
  playerSlotBinding: PlayerSlotBinding;
  projectile: Projectile;
  actionEvent: ActionEvent;
  config: Config;
  gameTickSchedule: GameTickSchedule;
}

export type TableName = keyof RowMap;

/** The live store: one Map per table, keyed by that table's primary key as a string. */
export type GameStore = { [K in TableName]: Map<string, RowMap[K]> } & {
  /** Flips true once `markReady()` runs — see module doc. */
  ready: boolean;
};

export function createGameStore(): GameStore {
  return {
    player: new Map(),
    playerTransform: new Map(),
    playerHealth: new Map(),
    playerActionState: new Map(),
    playerInputAck: new Map(),
    playerCooldown: new Map(),
    playerResource: new Map(),
    playerSlotBinding: new Map(),
    projectile: new Map(),
    actionEvent: new Map(),
    config: new Map(),
    gameTickSchedule: new Map(),
    ready: false,
  };
}

/**
 * A table's live-store wiring, with its row type erased: `attach` is a fully concrete closure
 * (no leftover type parameter) built while `K` was still known inside `defineTable`. This is
 * what makes TABLE_REGISTRY possible — TypeScript cannot infer a single `K` from a heterogeneous
 * array of `{key, handle}` pairs at the call site, but a closure captured per-table needs no such
 * inference later.
 */
interface RegisteredTable {
  name: TableName;
  attach: (connection: DbConnection, store: GameStore) => () => void;
}

function defineTable<K extends TableName>(
  name: K,
  key: (row: RowMap[K]) => string,
  handle: (db: DbConnection['db']) => TableHandle<RowMap[K]>,
): RegisteredTable {
  return {
    name,
    attach: (connection, store) => {
      // Indexing GameStore by the still-abstract `K` (rather than a literal property access)
      // does not simplify back down to `Map<string, RowMap[K]>` on its own — the cast asserts
      // what's true by construction: `store[name]` for this table's own `name` is that map.
      const map = store[name] as Map<string, RowMap[K]>;
      const table = handle(connection.db);

      const onInsert = (_ctx: EventContext, row: RowMap[K]) => {
        map.set(key(row), row);
      };
      const onUpdate = (_ctx: EventContext, _old: RowMap[K], next: RowMap[K]) => {
        map.set(key(next), next);
      };
      const onDelete = (_ctx: EventContext, row: RowMap[K]) => {
        map.delete(key(row));
      };

      table.onInsert(onInsert);
      table.onUpdate(onUpdate);
      table.onDelete(onDelete);

      return () => {
        table.removeOnInsert(onInsert);
        table.removeOnUpdate(onUpdate);
        table.removeOnDelete(onDelete);
      };
    },
  };
}

// The 12-row table registry. Everything downstream (attachGameStore) is generic over this list.
// The third argument reaches `connection.db`'s snake_case accessor (the SDK does not camelCase
// table names the way it does reducer names); the first argument is this module's own store key.
const TABLE_REGISTRY: readonly RegisteredTable[] = [
  defineTable('player', row => row.identity.toHexString(), db => db.player),
  defineTable('playerTransform', row => row.identity.toHexString(), db => db.player_transform),
  defineTable('playerHealth', row => row.identity.toHexString(), db => db.player_health),
  defineTable('playerActionState', row => row.identity.toHexString(), db => db.player_action_state),
  defineTable('playerInputAck', row => row.identity.toHexString(), db => db.player_input_ack),
  defineTable('playerCooldown', row => String(row.id), db => db.player_cooldown),
  defineTable('playerResource', row => String(row.id), db => db.player_resource),
  defineTable('playerSlotBinding', row => String(row.id), db => db.player_slot_binding),
  defineTable('projectile', row => String(row.id), db => db.projectile),
  defineTable('actionEvent', row => String(row.id), db => db.action_event),
  defineTable('config', row => String(row.version), db => db.config),
  defineTable('gameTickSchedule', row => String(row.scheduledId), db => db.game_tick_schedule),
];

export interface AttachedGameStore {
  store: GameStore;
  /** Call from `onSubscriptionApplied` — flips `store.ready`. */
  markReady: () => void;
  /** Detaches every listener this attach registered. */
  unsubscribe: () => void;
}

/** The one generic mechanism: wires every table in TABLE_REGISTRY into `store`. */
export function attachGameStore(connection: DbConnection): AttachedGameStore {
  const store = createGameStore();
  const unsubs = TABLE_REGISTRY.map(entry => entry.attach(connection, store));

  return {
    store,
    markReady: () => {
      store.ready = true;
    },
    unsubscribe: () => {
      for (const unsub of unsubs) unsub();
    },
  };
}
