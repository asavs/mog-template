import { describe, expect, it } from 'vitest';
import type { DbConnection, EventContext } from '../generated';
import type { PlayerCooldown, PlayerData } from '../generated/types';
import { attachGameStore, createGameStore } from './sync';

/** A fake table handle: same on/removeOn surface as the real SDK, driven manually. */
class FakeTable<Row> {
  private inserters = new Set<(ctx: EventContext, row: Row) => void>();
  private updaters = new Set<(ctx: EventContext, oldRow: Row, newRow: Row) => void>();
  private deleters = new Set<(ctx: EventContext, row: Row) => void>();

  onInsert = (cb: (ctx: EventContext, row: Row) => void) => this.inserters.add(cb);
  removeOnInsert = (cb: (ctx: EventContext, row: Row) => void) => this.inserters.delete(cb);
  onUpdate = (cb: (ctx: EventContext, oldRow: Row, newRow: Row) => void) => this.updaters.add(cb);
  removeOnUpdate = (cb: (ctx: EventContext, oldRow: Row, newRow: Row) => void) => this.updaters.delete(cb);
  onDelete = (cb: (ctx: EventContext, row: Row) => void) => this.deleters.add(cb);
  removeOnDelete = (cb: (ctx: EventContext, row: Row) => void) => this.deleters.delete(cb);

  emitInsert(row: Row) {
    for (const cb of this.inserters) cb({} as EventContext, row);
  }
  emitUpdate(oldRow: Row, newRow: Row) {
    for (const cb of this.updaters) cb({} as EventContext, oldRow, newRow);
  }
  emitDelete(row: Row) {
    for (const cb of this.deleters) cb({} as EventContext, row);
  }
  listenerCount() {
    return this.inserters.size + this.updaters.size + this.deleters.size;
  }
}

function fakeIdentity(hex: string) {
  return { toHexString: () => hex };
}

function fakeConnection() {
  const tables = {
    player: new FakeTable<PlayerData>(),
    playerTransform: new FakeTable<unknown>(),
    playerHealth: new FakeTable<unknown>(),
    playerActionState: new FakeTable<unknown>(),
    playerInputAck: new FakeTable<unknown>(),
    playerCooldown: new FakeTable<PlayerCooldown>(),
    playerResource: new FakeTable<unknown>(),
    playerSlotBinding: new FakeTable<unknown>(),
    projectile: new FakeTable<unknown>(),
    actionEvent: new FakeTable<unknown>(),
    config: new FakeTable<unknown>(),
    gameTickSchedule: new FakeTable<unknown>(),
  };
  // The real SDK exposes `connection.db` with snake_case accessors (see sync.ts's comment on
  // TABLE_REGISTRY); this fixture's own `tables` object stays camelCase for readability below.
  const db = {
    player: tables.player,
    player_transform: tables.playerTransform,
    player_health: tables.playerHealth,
    player_action_state: tables.playerActionState,
    player_input_ack: tables.playerInputAck,
    player_cooldown: tables.playerCooldown,
    player_resource: tables.playerResource,
    player_slot_binding: tables.playerSlotBinding,
    projectile: tables.projectile,
    action_event: tables.actionEvent,
    config: tables.config,
    game_tick_schedule: tables.gameTickSchedule,
  };
  const connection = { db } as unknown as DbConnection;
  return { connection, tables };
}

function player(hex: string, username: string): PlayerData {
  return {
    identity: fakeIdentity(hex),
    username,
    connected: true,
    joinedAt: {} as PlayerData['joinedAt'],
  } as unknown as PlayerData;
}

function cooldown(id: bigint, actionId: string): PlayerCooldown {
  return {
    id,
    identity: fakeIdentity('owner'),
    actionId,
    readyTick: 0n,
  } as unknown as PlayerCooldown;
}

describe('createGameStore', () => {
  it('starts with an empty, not-ready store for every table', () => {
    const store = createGameStore();
    expect(store.ready).toBe(false);
    expect(store.player.size).toBe(0);
    expect(store.playerCooldown.size).toBe(0);
    expect(store.gameTickSchedule.size).toBe(0);
  });
});

describe('attachGameStore — the generic mechanism', () => {
  it('routes insert/update/delete for an identity-keyed table into the right map', () => {
    const { connection, tables } = fakeConnection();
    const { store } = attachGameStore(connection);

    tables.player.emitInsert(player('aa', 'alice'));
    expect(store.player.get('aa')?.username).toBe('alice');

    tables.player.emitUpdate(player('aa', 'alice'), player('aa', 'alice-renamed'));
    expect(store.player.get('aa')?.username).toBe('alice-renamed');

    tables.player.emitDelete(player('aa', 'alice-renamed'));
    expect(store.player.has('aa')).toBe(false);
  });

  it('routes an id-keyed table (u64 PK) the same generic way', () => {
    const { connection, tables } = fakeConnection();
    const { store } = attachGameStore(connection);

    tables.playerCooldown.emitInsert(cooldown(7n, 'attack_light'));
    expect(store.playerCooldown.get('7')?.actionId).toBe('attack_light');

    tables.playerCooldown.emitDelete(cooldown(7n, 'attack_light'));
    expect(store.playerCooldown.has('7')).toBe(false);
  });

  it('keeps every table independent — an insert on one never touches another', () => {
    const { connection, tables } = fakeConnection();
    const { store } = attachGameStore(connection);
    tables.player.emitInsert(player('aa', 'alice'));
    expect(store.playerCooldown.size).toBe(0);
    expect(store.player.size).toBe(1);
  });

  it('markReady flips the flag exactly when called, not before', () => {
    const { connection } = fakeConnection();
    const { store, markReady } = attachGameStore(connection);
    expect(store.ready).toBe(false);
    markReady();
    expect(store.ready).toBe(true);
  });

  it('unsubscribe detaches every listener this attach registered', () => {
    const { connection, tables } = fakeConnection();
    const { store, unsubscribe } = attachGameStore(connection);
    expect(tables.player.listenerCount()).toBe(3); // insert + update + delete

    unsubscribe();
    expect(tables.player.listenerCount()).toBe(0);

    tables.player.emitInsert(player('aa', 'alice'));
    expect(store.player.size).toBe(0);
  });
});
