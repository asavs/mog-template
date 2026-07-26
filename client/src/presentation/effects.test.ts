import { describe, expect, it } from 'vitest';
import { ACTION_DEFS } from '../actions/defs.generated';
import {
  Effects,
  EffectPool,
  NUM_AOE_RINGS,
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
  const position = { x: 1, y: 2, z: 3 };

  it('spawns a melee flash at the event position for a melee_arc def', () => {
    const effects = new Effects();
    effects.onActionEvent({ id: 'evt-1', actionId: melee.id, kind: 'hit', position }, ACTION_DEFS);

    const state = effects.meleeFlashes.get('evt-1');
    expect(state).toBeDefined();
    expect(state!.position.toArray()).toEqual([1, 2, 3]);
  });

  it('spawns an aoe ring sized from the effect def', () => {
    const effects = new Effects();
    const effect = aoe.effects.find(e => e.kind === 'aoe_at_target')!;
    effects.onActionEvent({ id: 'evt-2', actionId: aoe.id, kind: 'hit', position }, ACTION_DEFS);

    const state = effects.aoeRings.get('evt-2');
    expect(state).toBeDefined();
    expect(state!.radius).toBe((effect as { radius: number }).radius);
  });

  it('spawns an impact light pulse for a projectile def', () => {
    const effects = new Effects();
    effects.onActionEvent({ id: 'evt-3', actionId: projectile.id, kind: 'hit', position }, ACTION_DEFS);

    const state = effects.lights.get('evt-3');
    expect(state).toBeDefined();
    expect(state!.intensity).toBeGreaterThan(0);
  });

  it('does nothing for an event with no position', () => {
    const effects = new Effects();
    effects.onActionEvent({ id: 'evt-4', actionId: melee.id, kind: 'hit', position: null }, ACTION_DEFS);
    expect(effects.meleeFlashes.get('evt-4')).toBeUndefined();
  });

  it('does nothing for an unknown action id', () => {
    const effects = new Effects();
    effects.onActionEvent({ id: 'evt-5', actionId: 'not_a_real_action', kind: 'hit', position }, ACTION_DEFS);
    expect(effects.meleeFlashes.entries.every(e => e.key === null)).toBe(true);
    expect(effects.aoeRings.entries.every(e => e.key === null)).toBe(true);
    expect(effects.lights.entries.every(e => e.key === null)).toBe(true);
  });

  it('never exceeds its fixed budgets under a burst of events', () => {
    const effects = new Effects();
    for (let i = 0; i < NUM_MELEE_FLASHES + 10; i += 1) {
      effects.onActionEvent({ id: `melee-${i}`, actionId: melee.id, kind: 'hit', position }, ACTION_DEFS);
    }
    for (let i = 0; i < NUM_AOE_RINGS + 10; i += 1) {
      effects.onActionEvent({ id: `aoe-${i}`, actionId: aoe.id, kind: 'hit', position }, ACTION_DEFS);
    }
    expect(effects.meleeFlashes.entries).toHaveLength(NUM_MELEE_FLASHES);
    expect(effects.aoeRings.entries).toHaveLength(NUM_AOE_RINGS);
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
