import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ACTION_DEFS } from '../actions/defs.generated';
import { MOG_REST_POSE } from '../content/restPose';
import { ACTION_PHASE } from './animBridge';
import {
  anchorForKind,
  EFFECT_ANCHORS,
  EFFECT_KIND_ANCHORS,
  Effects,
  EffectPool,
  IMPACT_ANCHOR,
  NUM_AOE_RINGS,
  NUM_EFFECT_LIGHTS,
  NUM_MELEE_FLASHES,
  NUM_PROJECTILES,
} from './effects';

/** Shorthand for the anchor a kind resolves to, so expectations read as anatomy. */
const FEET = EFFECT_ANCHORS.feet;
const TORSO = EFFECT_ANCHORS.torso;
const CHEST = EFFECT_ANCHORS.aheadOfChest;
const HAND = EFFECT_ANCHORS.hand;

/** Round-trip float noise from quaternion maths — compare positions, not bit patterns. */
function expectNear(actual: THREE.Vector3, expected: readonly [number, number, number]): void {
  expect(actual.x).toBeCloseTo(expected[0], 5);
  expect(actual.y).toBeCloseTo(expected[1], 5);
  expect(actual.z).toBeCloseTo(expected[2], 5);
}

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

  it('spawns a melee flash above the row position when the actor has no registered object (fallback)', () => {
    const effects = new Effects();
    effects.onActionEvent({ id: 'evt-1', actionId: melee.id, kind: 'hit', position, actor }, ACTION_DEFS);

    const state = effects.meleeFlashes.get('evt-1');
    expect(state).toBeDefined();
    // No live object means no facing to reach along, so the fallback keeps the row's
    // XZ and takes the anchor's HEIGHT only.
    expectNear(state!.position, [1, 2 + CHEST.height, 3]);
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

  it('spawns a heal glow above the row position (fallback) and marks it to follow the actor', () => {
    const effects = new Effects();
    effects.onActionEvent({ id: 'evt-heal-fallback', actionId: heal.id, kind: 'heal', position, actor }, ACTION_DEFS);

    const state = effects.lights.get('evt-heal-fallback');
    expect(state).toBeDefined();
    expectNear(state!.position, [1, 2 + TORSO.height, 3]);
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
    // Actor's live XZ, chest height, and out along their facing (identity rotation → −Z).
    expectNear(state!.position, [40, CHEST.height, -60 - CHEST.forward]);
  });

  it('melee flash falls back to the row position for an actor with no registered object', () => {
    const effects = new Effects();
    effects.onActionEvent({ id: 'evt-live-2', actionId: melee.id, kind: 'hit', position: rowSnapshotPosition, actor: 'nobody-registered' }, ACTION_DEFS);

    const state = effects.meleeFlashes.get('evt-live-2');
    expectNear(state!.position, [rowSnapshotPosition.x, rowSnapshotPosition.y + CHEST.height, rowSnapshotPosition.z]);
  });

  it('unregisterActor reverts a later event for that identity back to the row-position fallback', () => {
    const effects = new Effects();
    const object = registerActorAt(effects, actor, 12, 0, 12);
    effects.unregisterActor(actor);

    effects.onActionEvent({ id: 'evt-live-3', actionId: melee.id, kind: 'hit', position: rowSnapshotPosition, actor }, ACTION_DEFS);

    const state = effects.meleeFlashes.get('evt-live-3');
    expectNear(state!.position, [rowSnapshotPosition.x, rowSnapshotPosition.y + CHEST.height, rowSnapshotPosition.z]);
    expect(state!.position.x).not.toBeCloseTo(object.position.x, 5);
  });

  it('heal glow spawns on the registered actor and keeps following, at torso height, as they move', () => {
    const effects = new Effects();
    const object = registerActorAt(effects, actor, 5, 0, 5);

    effects.onActionEvent({ id: 'evt-heal-1', actionId: heal.id, kind: 'heal', position: rowSnapshotPosition, actor }, ACTION_DEFS);
    const state = effects.lights.get('evt-heal-1');
    expectNear(state!.position, [5, TORSO.height, 5]);
    expect(state!.followActor).toBe(actor);

    // The actor keeps moving after the glow spawned (exactly the running-caster case) — the
    // pooled light must track it every frame, not stay frozen at the spawn-time snapshot,
    // and must stay at the torso rather than sliding back down to the feet on frame 2.
    object.position.set(9, 0, 5);
    effects.update(0.016);
    expectNear(effects.lights.get('evt-heal-1')!.position, [9, TORSO.height, 5]);

    object.position.set(20, 0, -3);
    effects.update(0.016);
    expectNear(effects.lights.get('evt-heal-1')!.position, [20, TORSO.height, -3]);
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

describe('Effect anchors (the "spells come out of my ankles" regression)', () => {
  // A player's authoritative position is their FEET — `player_transform.position.y` is 0
  // and the registered `Object3D` is the rig root, soles on the floor. Anchoring a visual
  // "to the actor" therefore used to mean, literally, on the ground between their boots:
  // swings, muzzle flashes and heal glows all came out of the ankles. These tests pin each
  // kind to the part of the body it should come out of instead.
  const melee = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'melee_arc'))!;
  const aoe = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'aoe_at_target'))!;
  const bolt = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'projectile'))!;
  const heal = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'heal_self'))!;
  const roll = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'displace_self'))!;

  const actor = 'caster-1';
  const rowSnapshot = { x: 1, y: 0, z: 1 };

  // A deliberately awkward actor transform: off the origin, and facing a yaw where the
  // forward reach lands on a different axis than the actor's own position, so a spawn site
  // that quietly forgot to apply facing cannot pass by coincidence.
  const ACTOR_X = 10;
  const ACTOR_Z = -4;
  const YAW = Math.PI / 2;
  // `sim/movement.ts`: forward = (-sin yaw, 0, -cos yaw). At yaw=PI/2 that is (-1, 0, ~0).
  const FORWARD_X = -Math.sin(YAW);
  const FORWARD_Z = -Math.cos(YAW);

  function registerPosedActor(effects: Effects): THREE.Object3D {
    const object = new THREE.Object3D();
    object.position.set(ACTOR_X, 0, ACTOR_Z);
    object.rotation.y = YAW;
    effects.registerActor(actor, object);
    return object;
  }

  /** Where a given anchor should land for `registerPosedActor`'s transform. */
  function expectedFor(anchorId: keyof typeof EFFECT_ANCHORS): [number, number, number] {
    const spec = EFFECT_ANCHORS[anchorId];
    return [ACTOR_X + FORWARD_X * spec.forward, spec.height, ACTOR_Z + FORWARD_Z * spec.forward];
  }

  it('states one anchor per effect kind that renders something', () => {
    // The table is the mechanism: adding an effect kind that spawns a visual means adding
    // a row here, not sprinkling another `+1.2` at a spawn site.
    const renderedKinds = new Set(
      ACTION_DEFS.flatMap(def => def.effects.map(e => e.kind)).filter(
        kind => kind !== 'invulnerable' && kind !== 'mitigation',
      ),
    );
    for (const kind of renderedKinds) {
      expect(EFFECT_KIND_ANCHORS[kind], `no anchor declared for effect kind "${kind}"`).toBeDefined();
    }
    // Anything unknown is grounded rather than thrown at the origin.
    expect(anchorForKind('not_a_real_kind')).toBe('feet');
  });

  it('measures every anchor as a fraction of the rig reference height, not raw metres', () => {
    // `content/restPose.ts` normalises every body to this height, so a rig re-scale must
    // carry the effects with it instead of stranding hardcoded offsets.
    const height = MOG_REST_POSE.referenceHeight;
    expect(FEET.height).toBe(0);
    expect(TORSO.height).toBeCloseTo(height * 0.5, 6);
    expect(CHEST.height).toBeCloseTo(height * 0.6, 6);
    expect(HAND.height).toBeCloseTo(height * 0.65, 6);
    // Everything that should be off the floor is off the floor, and by less than a body.
    for (const id of ['torso', 'aheadOfChest', 'hand'] as const) {
      expect(EFFECT_ANCHORS[id].height).toBeGreaterThan(0);
      expect(EFFECT_ANCHORS[id].height).toBeLessThan(height);
    }
    // Only the two "out in front of me" anchors reach along the facing.
    expect(FEET.forward).toBe(0);
    expect(TORSO.forward).toBe(0);
    expect(CHEST.forward).toBeGreaterThan(0);
    expect(HAND.forward).toBeGreaterThan(0);
  });

  it('melee_arc lands ahead of the chest of a posed, off-origin actor', () => {
    const effects = new Effects();
    registerPosedActor(effects);
    effects.onActionEvent({ id: 'a-melee', actionId: melee.id, kind: 'hit', position: rowSnapshot, actor }, ACTION_DEFS);
    expectNear(effects.meleeFlashes.get('a-melee')!.position, expectedFor('aheadOfChest'));
  });

  it('heal_self lands on the torso of a posed, off-origin actor', () => {
    const effects = new Effects();
    registerPosedActor(effects);
    effects.onActionEvent({ id: 'a-heal', actionId: heal.id, kind: 'heal', position: rowSnapshot, actor }, ACTION_DEFS);
    expectNear(effects.lights.get('a-heal')!.position, expectedFor('torso'));
  });

  it('the projectile muzzle flash lands at the hand of a posed, off-origin actor', () => {
    const effects = new Effects();
    registerPosedActor(effects);
    effects.onPlayerActionState(
      actor,
      { actionId: bolt.id, phase: ACTION_PHASE.active, phaseStartedTick: 1n },
      ACTION_DEFS,
      { x: ACTOR_X, y: 0, z: ACTOR_Z },
    );
    const match = effects.lights.entries.find(e => e.key?.endsWith(':projectile'));
    expect(match, 'no muzzle flash spawned for a projectile action entering Active').toBeDefined();
    expectNear(match!.resource.position, expectedFor('hand'));
  });

  it("prefers the rig's own hand bone over the fallback offset once the body has loaded", () => {
    // This is the socket-anchored story arriving through the bone the rig already ships:
    // `PlayerBody` mounts the resolved rig under the group it registered, so the hand is
    // reachable from the registry with no parallel socket config.
    const effects = new Effects();
    const object = registerPosedActor(effects);
    const hand = new THREE.Object3D();
    hand.name = 'hand_r'; // `content/rig.ts`'s canonical (UE5) spelling for `rightHand`
    hand.position.set(0.3, 1.42, 0.11);
    object.add(hand);

    effects.onPlayerActionState(
      actor,
      { actionId: bolt.id, phase: ACTION_PHASE.active, phaseStartedTick: 2n },
      ACTION_DEFS,
      { x: ACTOR_X, y: 0, z: ACTOR_Z },
    );

    const match = effects.lights.entries.find(e => e.key?.endsWith(':projectile'))!;
    const handWorld = hand.getWorldPosition(new THREE.Vector3());
    expectNear(match.resource.position, [handWorld.x, handWorld.y, handWorld.z]);
    // ...and that is genuinely a different point than the fallback would have produced.
    const fallback = expectedFor('hand');
    expect(match.resource.position.y).not.toBeCloseTo(fallback[1], 3);
  });

  it('unregisterActor drops the cached bone so a re-registered body resolves its own', () => {
    const effects = new Effects();
    const first = registerPosedActor(effects);
    const firstHand = new THREE.Object3D();
    firstHand.name = 'hand_r';
    firstHand.position.set(0, 1.4, 0);
    first.add(firstHand);
    effects.onPlayerActionState(actor, { actionId: bolt.id, phase: ACTION_PHASE.active, phaseStartedTick: 3n }, ACTION_DEFS, { x: ACTOR_X, y: 0, z: ACTOR_Z });
    effects.unregisterActor(actor);
    effects.clearPlayer(actor);

    const second = new THREE.Object3D();
    second.position.set(-30, 0, 30);
    const secondHand = new THREE.Object3D();
    secondHand.name = 'hand_r';
    secondHand.position.set(0, 1.4, 0);
    second.add(secondHand);
    effects.registerActor(actor, second);
    effects.onPlayerActionState(actor, { actionId: bolt.id, phase: ACTION_PHASE.active, phaseStartedTick: 4n }, ACTION_DEFS, { x: -30, y: 0, z: 30 });

    // The pool key carries the edge's `phaseStartedTick`, so the second cast is findable.
    const latest = effects.lights.entries.find(e => e.key?.endsWith(' 4:projectile'))!;
    expect(latest, 'no muzzle flash for the re-registered body').toBeDefined();
    expectNear(latest.resource.position, [-30, 1.4, 30]);
  });

  it('keeps ground-anchored kinds on the ground', () => {
    const effects = new Effects();
    registerPosedActor(effects);

    // An aoe ring is the server's own target point, flat on the floor — untouched.
    const target = { x: 3, y: 0, z: 7 };
    effects.onActionEvent({ id: 'a-aoe', actionId: aoe.id, kind: 'hit', position: target, actor }, ACTION_DEFS);
    expectNear(effects.aoeRings.get('a-aoe')!.position, [3, 0, 7]);

    // A roll's dash scuff belongs on the floor it is scuffing.
    effects.onPlayerActionState(
      actor,
      { actionId: roll.id, phase: ACTION_PHASE.active, phaseStartedTick: 9n },
      ACTION_DEFS,
      { x: ACTOR_X, y: 0, z: ACTOR_Z },
    );
    const dash = effects.lights.entries.find(e => e.key?.endsWith(':displace_self'))!;
    expectNear(dash.resource.position, [ACTOR_X, 0, ACTOR_Z]);
  });

  it('flashes a hit on the victim at torso height, not at their feet', () => {
    // `effects.rs::apply_damage` stamps the VICTIM's transform on the row, and that
    // transform is their feet — so a raw copy put the impact flash under them.
    const effects = new Effects();
    const victimFeet = { x: -8, y: 0, z: 2 };
    effects.onActionEvent({ id: 'a-impact', actionId: bolt.id, kind: 'hit', position: victimFeet, actor }, ACTION_DEFS);

    const state = effects.lights.get('a-impact')!;
    expectNear(state.position, [-8, EFFECT_ANCHORS[IMPACT_ANCHOR].height, 2]);
    expect(state.followActor).toBeNull();
    expect(state.anchor).toBe(IMPACT_ANCHOR);
  });

  it('leaves nothing on the floor that a body should be wearing', () => {
    // The felt bug in one assertion: cast everything and check what is at ankle height.
    const effects = new Effects();
    registerPosedActor(effects);
    effects.onActionEvent({ id: 'z-melee', actionId: melee.id, kind: 'hit', position: rowSnapshot, actor }, ACTION_DEFS);
    effects.onActionEvent({ id: 'z-heal', actionId: heal.id, kind: 'heal', position: rowSnapshot, actor }, ACTION_DEFS);
    effects.onActionEvent({ id: 'z-impact', actionId: bolt.id, kind: 'hit', position: rowSnapshot, actor }, ACTION_DEFS);
    effects.onPlayerActionState(actor, { actionId: bolt.id, phase: ACTION_PHASE.active, phaseStartedTick: 7n }, ACTION_DEFS, { x: ACTOR_X, y: 0, z: ACTOR_Z });
    effects.syncProjectiles([{ id: 'z-p', actionId: bolt.id, position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }]);

    const ANKLE = 0.3;
    expect(effects.meleeFlashes.get('z-melee')!.position.y).toBeGreaterThan(ANKLE);
    expect(effects.lights.get('z-heal')!.position.y).toBeGreaterThan(ANKLE);
    expect(effects.lights.get('z-impact')!.position.y).toBeGreaterThan(ANKLE);
    expect(effects.lights.entries.find(e => e.key?.endsWith(':projectile'))!.resource.position.y).toBeGreaterThan(ANKLE);
    expect(effects.projectiles.get('z-p')!.position.y).toBeGreaterThan(ANKLE);
  });
});

describe('Effects.syncProjectiles', () => {
  it('borrows a slot per live projectile row and tracks its motion', () => {
    const effects = new Effects();
    effects.syncProjectiles([
      { id: 'p1', actionId: 'ability_bolt', position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } },
    ]);
    // XZ verbatim from the row; Y lifted to the same `hand` anchor the muzzle uses,
    // because the server spawns projectiles at the caster's feet and hit-tests in 2D.
    expectNear(effects.projectiles.get('p1')!.position, [0, HAND.height, 0]);

    effects.syncProjectiles([
      { id: 'p1', actionId: 'ability_bolt', position: { x: 5, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } },
    ]);
    expectNear(effects.projectiles.get('p1')!.position, [5, HAND.height, 0]);
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
  // A def with NO kind that gets a local active-phase pulse (see `LOCAL_ACTIVE_PULSES`):
  // its visual, if any, arrives via an `action_event` row instead.
  const nonRoll = ACTION_DEFS.find(
    def => def.effects.length > 0 && def.effects.every(e => e.kind !== 'displace_self' && e.kind !== 'projectile'),
  )!;
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

  it('does nothing for an action def with no locally-pulsed effect kind', () => {
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
