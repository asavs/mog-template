import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ACTION_DEFS } from '../actions/defs.generated';
import { ACTION_PHASE } from './animBridge';
import {
  Effects,
  EffectPool,
  NUM_AOE_RINGS,
  NUM_EFFECT_LIGHTS,
  NUM_MELEE_FLASHES,
  NUM_PROJECTILES,
} from './effects';

describe('EffectPool', () => {
  it('never allocates after construction: create() runs exactly `size` times', () => {
    let created = 0;
    const pool = new EffectPool(4, () => {
      created += 1;
      return { id: created };
    });
    expect(created).toBe(4);
    pool.spawn('a', 1);
    pool.spawn('b', 1);
    pool.spawn('c', 1);
    expect(created).toBe(4);
  });

  it('re-borrowing the same key returns the same resource', () => {
    const pool = new EffectPool(2, index => ({ index }));
    const first = pool.spawn('a', 1);
    const second = pool.spawn('a', 5);
    expect(second).toBe(first);
  });

  it('auto-releases a slot once its remaining life reaches zero', () => {
    const pool = new EffectPool(2, () => ({}));
    pool.spawn('a', 0.5);
    pool.update(0.3);
    expect(pool.get('a')).toBeDefined();
    pool.update(0.3);
    expect(pool.get('a')).toBeUndefined();
  });

  it('evicts the slot with the least time left when the pool is full', () => {
    const pool = new EffectPool(2, () => ({}));
    pool.spawn('old', 0.1);
    pool.spawn('newer', 5);
    // Both slots taken; a third spawn must steal from 'old' (least time left).
    pool.spawn('third', 1);
    expect(pool.get('old')).toBeUndefined();
    expect(pool.get('newer')).toBeDefined();
    expect(pool.get('third')).toBeDefined();
  });

  it('never grows past its budget', () => {
    const pool = new EffectPool(3, () => ({}));
    for (let i = 0; i < 20; i += 1) pool.spawn(`key-${i}`, 10);
    expect(pool.entries).toHaveLength(3);
  });

  it('explicit release frees the slot immediately, independent of remaining life', () => {
    const pool = new EffectPool(1, () => ({}));
    pool.spawn('a', 100);
    pool.release('a');
    expect(pool.get('a')).toBeUndefined();
  });

  it('leaves an Infinity-duration slot alone across update() ticks', () => {
    const pool = new EffectPool(1, () => ({}));
    pool.spawn('a', Number.POSITIVE_INFINITY);
    pool.update(1000);
    expect(pool.get('a')).toBeDefined();
  });
});

describe('Effects.onActionEvent', () => {
  const melee = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'melee_arc'))!;
  const aoe = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'aoe_at_target'))!;
  const projectile = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'projectile'))!;
  const heal = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'heal_self'))!;
  const position = { x: 1, y: 2, z: 3 };
  const actor = 'attacker-1';

  it('spawns a melee flash at the row position when the actor has no registered object (fallback)', () => {
    const effects = new Effects();
    effects.onActionEvent({ id: 'evt-1', actionId: melee.id, kind: 'hit', position, actor }, ACTION_DEFS);

    const state = effects.meleeFlashes.get('evt-1');
    expect(state).toBeDefined();
    expect(state!.position.toArray()).toEqual([1, 2, 3]);
  });

  it('spawns an aoe ring sized from the effect def', () => {
    const effects = new Effects();
    const effect = aoe.effects.find(e => e.kind === 'aoe_at_target')!;
    effects.onActionEvent({ id: 'evt-2', actionId: aoe.id, kind: 'hit', position, actor }, ACTION_DEFS);

    const state = effects.aoeRings.get('evt-2');
    expect(state).toBeDefined();
    expect(state!.radius).toBe((effect as { radius: number }).radius);
  });

  it('spawns an impact light pulse for a projectile def', () => {
    const effects = new Effects();
    effects.onActionEvent({ id: 'evt-3', actionId: projectile.id, kind: 'hit', position, actor }, ACTION_DEFS);

    const state = effects.lights.get('evt-3');
    expect(state).toBeDefined();
    expect(state!.intensity).toBeGreaterThan(0);
    // Anchored to the row's own point in space (a hit/release location), not the actor.
    expect(state!.followActor).toBeNull();
  });

  it('spawns a heal glow at the row position (fallback) and marks it to follow the actor', () => {
    const effects = new Effects();
    effects.onActionEvent({ id: 'evt-heal-fallback', actionId: heal.id, kind: 'heal', position, actor }, ACTION_DEFS);

    const state = effects.lights.get('evt-heal-fallback');
    expect(state).toBeDefined();
    expect(state!.position.toArray()).toEqual([1, 2, 3]);
    expect(state!.followActor).toBe(actor);
  });

  it('does nothing for an event with no position', () => {
    const effects = new Effects();
    effects.onActionEvent({ id: 'evt-4', actionId: melee.id, kind: 'hit', position: null, actor }, ACTION_DEFS);
    expect(effects.meleeFlashes.get('evt-4')).toBeUndefined();
  });

  it('does nothing for an unknown action id', () => {
    const effects = new Effects();
    effects.onActionEvent({ id: 'evt-5', actionId: 'not_a_real_action', kind: 'hit', position, actor }, ACTION_DEFS);
    expect(effects.meleeFlashes.entries.every(e => e.key === null)).toBe(true);
    expect(effects.aoeRings.entries.every(e => e.key === null)).toBe(true);
    expect(effects.lights.entries.every(e => e.key === null)).toBe(true);
  });

  it('never exceeds its fixed budgets under a burst of events', () => {
    const effects = new Effects();
    for (let i = 0; i < NUM_MELEE_FLASHES + 10; i += 1) {
      effects.onActionEvent({ id: `melee-${i}`, actionId: melee.id, kind: 'hit', position, actor }, ACTION_DEFS);
    }
    for (let i = 0; i < NUM_AOE_RINGS + 10; i += 1) {
      effects.onActionEvent({ id: `aoe-${i}`, actionId: aoe.id, kind: 'hit', position, actor }, ACTION_DEFS);
    }
    expect(effects.meleeFlashes.entries).toHaveLength(NUM_MELEE_FLASHES);
    expect(effects.aoeRings.entries).toHaveLength(NUM_AOE_RINGS);
  });
});

describe('Effects actor anchoring (the R3 effect-anchor regression)', () => {
  // Regression coverage for: ability visuals rendering at a fixed point instead of
  // tracking the moving caster. Root cause was `action_event.position`/`player_transform`
  // being a server-tick SNAPSHOT, read while the caster is actually rendered at a
  // different (client-predicted / interpolated) position every frame — see
  // `Effects.registerActor`'s doc. These tests prove melee/heal visuals anchor to the
  // actor's LIVE registered object, not the stale row snapshot, and that nothing here
  // ever silently lands at the origin.
  const melee = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'melee_arc'))!;
  const heal = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'heal_self'))!;
  const rowSnapshotPosition = { x: 1, y: 0, z: 1 }; // deliberately NOT the origin, and NOT where the live object is
  const actor = 'caster-1';

  function registerActorAt(effects: Effects, identityHex: string, x: number, y: number, z: number): THREE.Object3D {
    const object = new THREE.Object3D();
    object.position.set(x, y, z);
    effects.registerActor(identityHex, object);
    return object;
  }

  it('melee flash anchors to the registered actor object, not the row position', () => {
    const effects = new Effects();
    registerActorAt(effects, actor, 40, 0, -60);

    effects.onActionEvent({ id: 'evt-live-1', actionId: melee.id, kind: 'hit', position: rowSnapshotPosition, actor }, ACTION_DEFS);

    const state = effects.meleeFlashes.get('evt-live-1');
    expect(state!.position.toArray()).toEqual([40, 0, -60]);
    expect(state!.position.toArray()).not.toEqual([rowSnapshotPosition.x, rowSnapshotPosition.y, rowSnapshotPosition.z]);
  });

  it('melee flash falls back to the row position for an actor with no registered object', () => {
    const effects = new Effects();
    effects.onActionEvent({ id: 'evt-live-2', actionId: melee.id, kind: 'hit', position: rowSnapshotPosition, actor: 'nobody-registered' }, ACTION_DEFS);

    const state = effects.meleeFlashes.get('evt-live-2');
    expect(state!.position.toArray()).toEqual([rowSnapshotPosition.x, rowSnapshotPosition.y, rowSnapshotPosition.z]);
  });

  it('unregisterActor reverts a later event for that identity back to the row-position fallback', () => {
    const effects = new Effects();
    const object = registerActorAt(effects, actor, 12, 0, 12);
    effects.unregisterActor(actor);

    effects.onActionEvent({ id: 'evt-live-3', actionId: melee.id, kind: 'hit', position: rowSnapshotPosition, actor }, ACTION_DEFS);

    const state = effects.meleeFlashes.get('evt-live-3');
    expect(state!.position.toArray()).toEqual([rowSnapshotPosition.x, rowSnapshotPosition.y, rowSnapshotPosition.z]);
    expect(state!.position.toArray()).not.toEqual([object.position.x, object.position.y, object.position.z]);
  });

  it('heal glow spawns at the registered actor position and keeps following as the actor moves', () => {
    const effects = new Effects();
    const object = registerActorAt(effects, actor, 5, 0, 5);

    effects.onActionEvent({ id: 'evt-heal-1', actionId: heal.id, kind: 'heal', position: rowSnapshotPosition, actor }, ACTION_DEFS);
    const state = effects.lights.get('evt-heal-1');
    expect(state!.position.toArray()).toEqual([5, 0, 5]);
    expect(state!.followActor).toBe(actor);

    // The actor keeps moving after the glow spawned (exactly the running-caster case) — the
    // pooled light must track it every frame, not stay frozen at the spawn-time snapshot.
    object.position.set(9, 0, 5);
    effects.update(0.016);
    expect(effects.lights.get('evt-heal-1')!.position.toArray()).toEqual([9, 0, 5]);

    object.position.set(20, 0, -3);
    effects.update(0.016);
    expect(effects.lights.get('evt-heal-1')!.position.toArray()).toEqual([20, 0, -3]);
  });

  it('a non-following light (impact pulse) does NOT move when its actor moves afterward', () => {
    const effects = new Effects();
    const projectile = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'projectile'))!;
    const object = registerActorAt(effects, actor, 7, 0, 7);

    effects.onActionEvent({ id: 'evt-impact-1', actionId: projectile.id, kind: 'hit', position: rowSnapshotPosition, actor }, ACTION_DEFS);
    const before = effects.lights.get('evt-impact-1')!.position.toArray();

    object.position.set(99, 0, 99);
    effects.update(0.016);

    expect(effects.lights.get('evt-impact-1')!.position.toArray()).toEqual(before);
  });

  it('re-borrowing a followed slot for a non-following kind stops it from chasing the old actor', () => {
    // Pool-hygiene regression: `followActor` is a resource field the pool never resets on
    // spawn (same discipline as `.color` — see the module doc), so every light spawn site
    // MUST set it explicitly or a re-borrowed slot keeps tracking whoever it followed last.
    const effects = new Effects();
    const projectile = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'projectile'))!;
    const object = registerActorAt(effects, actor, 1, 0, 1);

    effects.onActionEvent({ id: 'evt-follow', actionId: heal.id, kind: 'heal', position: rowSnapshotPosition, actor }, ACTION_DEFS);
    expect(effects.lights.get('evt-follow')!.followActor).toBe(actor);

    // Drain the heal light's own remaining life (0.5s) down to less than an impact light's
    // full duration (0.2s) WITHOUT letting it expire, so it becomes the pool's weakest slot
    // once the other 15 are filled with fresh (0.2s) impact lights — proving the eviction
    // path specifically, not just a naturally-expired-then-refilled free slot.
    effects.update(0.45);
    for (let i = 0; i < NUM_EFFECT_LIGHTS - 1; i += 1) {
      effects.onActionEvent({ id: `fill-${i}`, actionId: projectile.id, kind: 'hit', position: rowSnapshotPosition, actor }, ACTION_DEFS);
    }
    expect(effects.lights.get('evt-follow')).toBeDefined(); // still alive, just weakest

    effects.onActionEvent({ id: 'evict-winner', actionId: projectile.id, kind: 'hit', position: rowSnapshotPosition, actor }, ACTION_DEFS);

    expect(effects.lights.get('evt-follow')).toBeUndefined(); // evicted
    const reborrowed = effects.lights.get('evict-winner')!;
    expect(reborrowed.followActor).toBeNull();

    object.position.set(-40, 0, -40);
    effects.update(0.016);
    expect(reborrowed.position.toArray()).not.toEqual([-40, 0, -40]);
  });
});

describe('Effects.syncProjectiles', () => {
  it('borrows a slot per live projectile row and tracks its motion', () => {
    const effects = new Effects();
    effects.syncProjectiles([
      { id: 'p1', actionId: 'ability_bolt', position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } },
    ]);
    expect(effects.projectiles.get('p1')?.position.toArray()).toEqual([0, 0, 0]);

    effects.syncProjectiles([
      { id: 'p1', actionId: 'ability_bolt', position: { x: 5, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } },
    ]);
    expect(effects.projectiles.get('p1')?.position.toArray()).toEqual([5, 0, 0]);
  });

  it('releases a slot the tick its row disappears', () => {
    const effects = new Effects();
    effects.syncProjectiles([
      { id: 'p1', actionId: 'ability_bolt', position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } },
    ]);
    effects.syncProjectiles([]);
    expect(effects.projectiles.get('p1')).toBeUndefined();
  });

  it('never exceeds its fixed budget no matter how many rows arrive', () => {
    const effects = new Effects();
    const rows = Array.from({ length: NUM_PROJECTILES + 15 }, (_, i) => ({
      id: `p${i}`,
      actionId: 'ability_bolt',
      position: { x: i, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
    }));
    effects.syncProjectiles(rows);
    expect(effects.projectiles.entries).toHaveLength(NUM_PROJECTILES);
  });
});

describe('Effects.onPlayerActionState', () => {
  const roll = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'displace_self'))!;
  const nonRoll = ACTION_DEFS.find(def => !def.effects.some(e => e.kind === 'displace_self'))!;
  const position = { x: 1, y: 2, z: 3 };

  it('spawns a roll dash light at the player position when phase is active', () => {
    const effects = new Effects();
    effects.onPlayerActionState(
      'player1',
      { actionId: roll.id, phase: ACTION_PHASE.active, phaseStartedTick: 1n },
      ACTION_DEFS,
      position,
    );

    const match = effects.lights.entries.find(e => e.key?.startsWith('local:player1:'));
    expect(match).toBeDefined();
    expect(match!.resource.position.toArray()).toEqual([1, 2, 3]);
  });

  it('does nothing outside the active phase', () => {
    const effects = new Effects();
    effects.onPlayerActionState(
      'player1',
      { actionId: roll.id, phase: ACTION_PHASE.windup, phaseStartedTick: 1n },
      ACTION_DEFS,
      position,
    );
    expect(effects.lights.entries.every(e => e.key === null)).toBe(true);
  });

  it('does nothing when position is null', () => {
    const effects = new Effects();
    effects.onPlayerActionState(
      'player1',
      { actionId: roll.id, phase: ACTION_PHASE.active, phaseStartedTick: 1n },
      ACTION_DEFS,
      null,
    );
    expect(effects.lights.entries.every(e => e.key === null)).toBe(true);
  });

  it('does nothing for an action def with no displace_self effect', () => {
    const effects = new Effects();
    effects.onPlayerActionState(
      'player1',
      { actionId: nonRoll.id, phase: ACTION_PHASE.active, phaseStartedTick: 1n },
      ACTION_DEFS,
      position,
    );
    expect(effects.lights.entries.every(e => e.key === null)).toBe(true);
  });

  it('fires only once per (actionId, phase, phaseStartedTick) edge, even across repeated frames', () => {
    const effects = new Effects();
    let spawnCount = 0;
    const originalSpawn = effects.lights.spawn.bind(effects.lights);
    effects.lights.spawn = (key, seconds) => {
      spawnCount += 1;
      return originalSpawn(key, seconds);
    };

    const row = { actionId: roll.id, phase: ACTION_PHASE.active, phaseStartedTick: 1n };
    effects.onPlayerActionState('player1', row, ACTION_DEFS, position);
    effects.onPlayerActionState('player1', row, ACTION_DEFS, position);
    effects.onPlayerActionState('player1', row, ACTION_DEFS, position);

    expect(spawnCount).toBe(1);
  });

  it('re-fires when phaseStartedTick advances to a new active phase', () => {
    const effects = new Effects();
    effects.onPlayerActionState(
      'player1',
      { actionId: roll.id, phase: ACTION_PHASE.active, phaseStartedTick: 1n },
      ACTION_DEFS,
      position,
    );
    effects.onPlayerActionState(
      'player1',
      { actionId: roll.id, phase: ACTION_PHASE.active, phaseStartedTick: 2n },
      ACTION_DEFS,
      position,
    );

    const matches = effects.lights.entries.filter(e => e.key?.startsWith('local:player1:'));
    expect(matches).toHaveLength(2);
  });

  it('tracks edges per player independently', () => {
    const effects = new Effects();
    const row = { actionId: roll.id, phase: ACTION_PHASE.active, phaseStartedTick: 1n };
    effects.onPlayerActionState('player1', row, ACTION_DEFS, position);
    effects.onPlayerActionState('player2', row, ACTION_DEFS, position);

    const matches = effects.lights.entries.filter(e => e.key?.startsWith('local:'));
    expect(matches).toHaveLength(2);
  });

  it('clearPlayer forgets the edge, letting the same (actionId, phase, tick) fire again', () => {
    const effects = new Effects();
    let spawnCount = 0;
    const originalSpawn = effects.lights.spawn.bind(effects.lights);
    effects.lights.spawn = (key, seconds) => {
      spawnCount += 1;
      return originalSpawn(key, seconds);
    };

    const row = { actionId: roll.id, phase: ACTION_PHASE.active, phaseStartedTick: 1n };
    effects.onPlayerActionState('player1', row, ACTION_DEFS, position);
    effects.clearPlayer('player1');
    effects.onPlayerActionState('player1', row, ACTION_DEFS, position);

    expect(spawnCount).toBe(2);
  });
});
