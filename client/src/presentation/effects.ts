/**
 * Minimal pooled visuals: point-light pulses, melee-arc flashes, an aoe ring,
 * and projectile meshes — driven from `action_event` and `projectile` rows.
 *
 * Every pool is fixed-size and pre-allocated; `spawn` never calls `new` after
 * construction. This is the same discipline `PlayerLightPool.tsx` (see
 * `git show 9f9fc5c:client/src/components/PlayerLightPool.tsx`) already
 * established for player lights and this generalizes it: three.js bakes the
 * point-light COUNT into a shader key, so mounting or unmounting a light at
 * runtime can relink the whole scene. A borrowed-but-idle slot goes to zero
 * intensity; it never disappears.
 *
 * This module owns no THREE.Object3D/Mesh/Light instances and mounts nothing
 * — it is the same split `AnimationController` already draws between "plain
 * state a class owns" and "what actually renders it": a later wave's R3F
 * layer reads `EffectPool.entries` (position/params/remaining life) and
 * drives real `<pointLight>`/`<mesh>` elements from it, mounted once, exactly
 * like `PlayerLightPool`'s own `lightRefs` array.
 *
 * // integration: wave2-shell — mount N-per-pool `<pointLight>`/`<mesh>`
 * elements once (budgets below), bind each to its pool slot by index, and
 * call `Effects.update(deltaSeconds)` once per frame plus `onActionEvent`/
 * `syncProjectiles` whenever those rows change.
 */

import * as THREE from 'three';
import type { ActionDef } from '../actions/defs.generated';
import { boneNameCandidates, type MogBoneId } from '../content/rig';
import { MOG_REST_POSE } from '../content/restPose';
import { ACTION_PHASE, type ActionPhase } from './animBridge';

// ---------------------------------------------------------------------------
// The generic pool
// ---------------------------------------------------------------------------

export type PoolEntry<T> = {
  readonly resource: T;
  /** `null` when free. Row/event identity, not an array index — a slot can be re-borrowed by a new key. */
  key: string | null;
  remainingSeconds: number;
  /** The duration this slot was last spawned for, so a renderer can derive a fade fraction. */
  totalSeconds: number;
};

/**
 * A fixed-size, pre-allocated pool of resources, borrowed by key and either
 * auto-released after a duration (`spawn`) or explicitly released (`release`,
 * for row-presence-driven resources like a live projectile).
 *
 * When every slot is taken, a new request evicts whichever slot has the LEAST
 * time left — a flash about to disappear anyway is the cheapest one to cut
 * short, and capping N concurrent effects is the entire point of pooling.
 */
export class EffectPool<T> {
  readonly entries: readonly PoolEntry<T>[];

  constructor(size: number, create: (index: number) => T) {
    const entries: PoolEntry<T>[] = [];
    for (let index = 0; index < size; index += 1) {
      entries.push({ resource: create(index), key: null, remainingSeconds: 0, totalSeconds: 0 });
    }
    this.entries = entries;
  }

  /** Borrow (or re-borrow) the slot for `key`, alive for `seconds` (`Infinity` for row-presence-driven use). */
  spawn(key: string, seconds: number): T {
    const entry = this.entries.find(e => e.key === key)
      ?? this.entries.find(e => e.key === null)
      ?? this.weakestEntry();
    entry.key = key;
    entry.remainingSeconds = seconds;
    entry.totalSeconds = seconds;
    return entry.resource;
  }

  get(key: string): T | undefined {
    return this.entries.find(e => e.key === key)?.resource;
  }

  release(key: string): void {
    const entry = this.entries.find(e => e.key === key);
    if (!entry) return;
    entry.key = null;
    entry.remainingSeconds = 0;
    entry.totalSeconds = 0;
  }

  /** Decrement every borrowed slot's remaining life, releasing whatever reaches zero. */
  update(deltaSeconds: number): void {
    for (const entry of this.entries) {
      if (entry.key === null || entry.remainingSeconds === Number.POSITIVE_INFINITY) continue;
      entry.remainingSeconds -= deltaSeconds;
      if (entry.remainingSeconds <= 0) {
        entry.key = null;
        entry.remainingSeconds = 0;
        entry.totalSeconds = 0;
      }
    }
  }

  private weakestEntry(): PoolEntry<T> {
    return this.entries.reduce((min, entry) => (entry.remainingSeconds < min.remainingSeconds ? entry : min));
  }
}

// ---------------------------------------------------------------------------
// Concrete pools
// ---------------------------------------------------------------------------

/** Player-light budget (8, see `PlayerLightPool.tsx`) is separate from this one. */
export const NUM_EFFECT_LIGHTS = 16;
export const NUM_MELEE_FLASHES = 8;
export const NUM_AOE_RINGS = 6;
export const NUM_PROJECTILES = 24;

export type PointLightState = {
  position: THREE.Vector3;
  color: THREE.Color;
  /** Peak intensity at spawn; a renderer fades it against `remainingSeconds`/`totalSeconds`. */
  intensity: number;
  /**
   * Identity hex of the actor this pulse should keep tracking every frame (`Effects.update`
   * re-reads their live position via `actorObjects`), or `null` for a pulse anchored to a fixed
   * point in space (an impact/miss location) that should stay put once spawned. Every spawn site
   * on the shared `lights` pool MUST set this explicitly, same discipline as `.color` above — a
   * slot re-borrowed from a following pulse would otherwise keep chasing the old actor forever.
   */
  followActor: string | null;
  /**
   * Which anchor this pulse was spawned at, so `refreshFollowingLights` can re-derive
   * the SAME offset from the actor every frame rather than snapping a torso glow back
   * down to their feet on the first update. Same must-set-on-every-spawn rule as
   * `.color`/`.followActor` — only read while `followActor` is set, but a stale value
   * on a re-borrowed following slot would put the glow at the wrong height.
   */
  anchor: EffectAnchorId;
};

export type MeleeFlashState = {
  position: THREE.Vector3;
};

export type AoeRingState = {
  position: THREE.Vector3;
  radius: number;
};

export type ProjectileVisualState = {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  /** Which action's projectile this slot is currently rendering — selects geometry/color, not pool identity. */
  actionId: string;
};

export function createPointLightPool(size: number = NUM_EFFECT_LIGHTS): EffectPool<PointLightState> {
  return new EffectPool(size, () => ({
    position: new THREE.Vector3(),
    color: new THREE.Color('white'),
    intensity: 0,
    followActor: null,
    anchor: 'feet',
  }));
}

export function createMeleeFlashPool(size: number = NUM_MELEE_FLASHES): EffectPool<MeleeFlashState> {
  return new EffectPool(size, () => ({ position: new THREE.Vector3() }));
}

export function createAoeRingPool(size: number = NUM_AOE_RINGS): EffectPool<AoeRingState> {
  return new EffectPool(size, () => ({ position: new THREE.Vector3(), radius: 0 }));
}

export function createProjectilePool(size: number = NUM_PROJECTILES): EffectPool<ProjectileVisualState> {
  return new EffectPool(size, () => ({
    position: new THREE.Vector3(),
    direction: new THREE.Vector3(0, 0, 1),
    actionId: '',
  }));
}

// ---------------------------------------------------------------------------
// Where an effect originates — the anchor table
// ---------------------------------------------------------------------------

/**
 * A player's authoritative position is their FEET. `player_transform.position.y`
 * is 0 for a grounded player (see `shared/arena.json`'s spawns and
 * `collision::resolve_player_movement`, which never lifts y), and the
 * `Object3D` `PlayerBody` registers is the rig's root group — also at the feet,
 * since `content/restPose.ts` puts `hips` at y=1.09 so the soles land on y=0.
 *
 * So "anchor the visual to the actor" — which is what every spawn site here
 * used to do, literally — means "put it on the floor between their boots". A
 * sword flash, a muzzle spark and a heal glow all came out of the ankles. That
 * is the whole bug: the effects were attached to the right PERSON and to the
 * wrong PART of them.
 *
 * The fix is one table rather than five sprinkled `+1.2`s. Each effect KIND
 * names an anchor; each anchor is a height and a forward reach expressed as
 * FRACTIONS of the rig's own reference height, so a rig re-scale moves every
 * effect with it instead of stranding a pile of hardcoded metres. This is the
 * same "adding an effect kind touches one table" discipline `onActionEvent`
 * already follows for the pools themselves.
 */
const RIG_HEIGHT = MOG_REST_POSE.referenceHeight;

/** Fractions of `RIG_HEIGHT`. Named so the table below reads as anatomy, not as numbers. */
const TORSO_HEIGHT_FRACTION = 0.5; // 1.0u — sternum on a 2.0u rig
const CHEST_HEIGHT_FRACTION = 0.6; // 1.2u — collarbone, where a swing crosses the body
const HAND_HEIGHT_FRACTION = 0.65; // 1.3u — a hand held out at throwing height
const CHEST_FORWARD_FRACTION = 0.4; // 0.8u — out in front, inside a 2.8u melee arc
const HAND_FORWARD_FRACTION = 0.2; // 0.4u — just past the knuckles

export type EffectAnchorId =
  /** On the floor, between the actor's feet. Ground rings and dash scuffs. */
  | 'feet'
  /** Centre of mass. Anything that reads as happening TO a body. */
  | 'torso'
  /** Chest height and out in front, so a swing/impact sits in the arc, not inside the ribcage. */
  | 'aheadOfChest'
  /** The throwing hand itself. Muzzle flashes and anything a hand releases. */
  | 'hand';

export type EffectAnchor = {
  /** World units above the actor's root. */
  readonly height: number;
  /** World units along the actor's facing (their local −Z, matching `sim/movement.ts`'s forward). */
  readonly forward: number;
  /**
   * A rig bone whose live world position wins OUTRIGHT when the actor's
   * skeleton has it — this is the socket-anchored VFX story, arrived at through
   * the bone the rig already ships rather than a parallel socket config. The
   * `height`/`forward` pair above is the fallback for an actor whose body has
   * not resolved yet (`PlayerBody` registers its group immediately, then loads
   * the rig asynchronously) or a rig that simply lacks the bone.
   */
  readonly bone: MogBoneId | null;
};

export const EFFECT_ANCHORS: Record<EffectAnchorId, EffectAnchor> = {
  feet: { height: 0, forward: 0, bone: null },
  torso: { height: RIG_HEIGHT * TORSO_HEIGHT_FRACTION, forward: 0, bone: null },
  aheadOfChest: {
    height: RIG_HEIGHT * CHEST_HEIGHT_FRACTION,
    forward: RIG_HEIGHT * CHEST_FORWARD_FRACTION,
    bone: null,
  },
  hand: {
    height: RIG_HEIGHT * HAND_HEIGHT_FRACTION,
    forward: RIG_HEIGHT * HAND_FORWARD_FRACTION,
    bone: 'rightHand',
  },
};

/**
 * Where each effect KIND's actor-anchored visual comes out of the actor.
 * Keyed by kind, never by `actionId` — same rule as `onActionEvent`'s dispatch,
 * so a new ability inherits a sane origin from the effect it already declares.
 */
export const EFFECT_KIND_ANCHORS: Record<string, EffectAnchorId> = {
  // The swing crosses the body at chest height and lands out in front of it.
  melee_arc: 'aheadOfChest',
  // A thrown bolt leaves the hand. `bone: 'rightHand'` makes this literal once the rig loads.
  projectile: 'hand',
  // A ground ring is on the ground, by definition.
  aoe_at_target: 'feet',
  // A heal is something happening to a body, so it sits in the middle of one.
  heal_self: 'torso',
  // A roll's dash scuff belongs on the floor the roll is scuffing.
  displace_self: 'feet',
};

/**
 * Where a DAMAGE flash sits on the person taking it. Separate from the table
 * above because it is anchored to a different body: `action_event.position` on
 * a hit is the VICTIM's transform (`effects.rs::apply_damage`), and a flash on
 * a victim reads as a body blow wherever the hit came from.
 */
export const IMPACT_ANCHOR: EffectAnchorId = 'torso';

export function anchorForKind(kind: string): EffectAnchorId {
  return EFFECT_KIND_ANCHORS[kind] ?? 'feet';
}

/** Scratch, module-level: anchoring runs every frame for following lights and must not allocate. */
const SCRATCH_QUATERNION = new THREE.Quaternion();
const SCRATCH_FORWARD = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Driven from data — row shapes and the `Effects` facade
// ---------------------------------------------------------------------------

/**
 * The minimal shape this module needs from an `action_event` row.
 *
 * Deliberately not the generated SpacetimeDB row type — see the same note in
 * `animBridge.ts`. // integration: wave2-shell — `id` must be a per-row
 * identity stable enough to key a pool slot (the generated row's own `id`,
 * stringified, is fine).
 */
export type EffectActionEventRow = {
  id: string;
  actionId: string;
  kind: string;
  position: { x: number; y: number; z: number } | null;
  /**
   * Identity hex of whoever fired this event — needed to anchor an
   * actor-following visual (melee flash, heal glow) on the caster's own
   * LIVE position rather than the row's `position` snapshot. See
   * `Effects.registerActor`'s doc for why the row snapshot alone is not
   * where the caster visually is by the time this event is read.
   */
  actor: string;
};

/** The minimal shape this module needs from a `projectile` row. */
export type EffectProjectileRow = {
  id: string;
  actionId: string;
  position: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
};

const MELEE_FLASH_SECONDS = 0.15;
const AOE_RING_SECONDS = 0.4;
const IMPACT_LIGHT_SECONDS = 0.2;
const HEAL_LIGHT_SECONDS = 0.5;
const ROLL_DASH_LIGHT_SECONDS = 0.25;

/**
 * `lights` is one shared, re-tinted pool (`PointLightState.color`) rather than a
 * pool per kind of pulse — every caller MUST set `.color` on every spawn, not
 * just the ones that care, or a slot re-borrowed from a differently-colored
 * pulse silently keeps the old tint (the pool only resets `key`/`remainingSeconds`
 * on `spawn`, never the resource's own fields — see `EffectPool.spawn`).
 */
const IMPACT_LIGHT_COLOR = 0xffffff;
const HEAL_LIGHT_COLOR = 0x7dffb2;
const ROLL_DASH_LIGHT_COLOR = 0xd9e8ff;
const MUZZLE_LIGHT_COLOR = 0x9fd7ff;
const MUZZLE_LIGHT_SECONDS = 0.18;

/**
 * Effect kinds whose visual is driven off the caster's own
 * `player_action_state` reaching Active rather than off an `action_event` row,
 * because the server emits no row for them (see `Effects.onPlayerActionState`).
 *
 * Two kinds qualify, for the same reason from opposite ends:
 *  - `displace_self` never produces an event at all (it is a per-tick position
 *    write in `apply_active_tick`);
 *  - `projectile` produces one only on IMPACT — a bolt LEAVING a hand is just a
 *    `projectile` row appearing, so the muzzle flash has to come from here or
 *    there is nothing marking where the shot came from.
 *
 * A table rather than a chain of `if (kind === ...)`, so the answer to "does
 * this kind get a local pulse, and where" is one row per kind in one place.
 */
const LOCAL_ACTIVE_PULSES: Record<string, { color: number; intensity: number; seconds: number }> = {
  displace_self: { color: ROLL_DASH_LIGHT_COLOR, intensity: 1.1, seconds: ROLL_DASH_LIGHT_SECONDS },
  projectile: { color: MUZZLE_LIGHT_COLOR, intensity: 1.6, seconds: MUZZLE_LIGHT_SECONDS },
};

export type EffectBudgets = {
  lights?: number;
  meleeFlashes?: number;
  aoeRings?: number;
  projectiles?: number;
};

export class Effects {
  readonly lights: EffectPool<PointLightState>;
  readonly meleeFlashes: EffectPool<MeleeFlashState>;
  readonly aoeRings: EffectPool<AoeRingState>;
  readonly projectiles: EffectPool<ProjectileVisualState>;

  /**
   * Last `(actionId, phase, phaseStartedTick)` `onPlayerActionState` has already
   * reacted to, per player (`identityHex`) — the same edge-detection reason
   * `animBridge.ts`'s `lastFiredAbilityEdge` exists, restated here because this
   * is driven straight off `player_action_state`, not an `action_event` row, and
   * a scene-wide `Effects` singleton (not one instance per player) needs the key
   * to keep each player's edge separate.
   */
  private readonly lastLocalEffectEdge = new Map<string, string>();

  /**
   * Live three.js object per player (`identityHex`), registered by
   * `PlayerBody` on mount / removed on unmount — the SAME `Object3D` its
   * parent group is positioned with each frame (`localGroupRef`'s CSP-predicted
   * position for the local player, a remote's interpolated snapshot position
   * for anyone else — see `game/frame.ts`'s `stepFrame`).
   *
   * `action_event.position` is a snapshot of `player_transform.position` at
   * the tick the server fired the event — authoritative for gameplay, but
   * NOT what is on screen: local prediction, the visual-correction glide,
   * and remote interpolation all deliberately render a different position
   * than the raw transform row, every single frame, by design. An effect
   * anchored straight to the row therefore visibly lags or detaches from
   * the caster's own rendered body — this registry is how an actor-anchored
   * visual (melee flash, heal glow) reads "wherever the caster is actually
   * drawn" instead, via `Object3D.getWorldPosition` (walks the parent chain,
   * so it already accounts for whatever position the owning group was set
   * to this frame). A kind that legitimately IS about a fixed point in space
   * (an impact/miss location, an aoe target point) keeps reading the row.
   */
  private readonly actorObjects = new Map<string, THREE.Object3D>();

  constructor(budgets: EffectBudgets = {}) {
    this.lights = createPointLightPool(budgets.lights ?? NUM_EFFECT_LIGHTS);
    this.meleeFlashes = createMeleeFlashPool(budgets.meleeFlashes ?? NUM_MELEE_FLASHES);
    this.aoeRings = createAoeRingPool(budgets.aoeRings ?? NUM_AOE_RINGS);
    this.projectiles = createProjectilePool(budgets.projectiles ?? NUM_PROJECTILES);
  }

  /**
   * Resolved anchor bones per `${identityHex}:${boneId}`. A bone lookup is a
   * subtree walk, and `PlayerBody` registers its group BEFORE the rig finishes
   * loading, so only successful finds are cached — a miss stays a miss and is
   * retried on the next cast, by which point the body has usually arrived.
   */
  private readonly anchorBones = new Map<string, THREE.Object3D>();

  /** Called from `PlayerBody`'s mount effect — see `actorObjects`' doc. */
  registerActor(identityHex: string, object: THREE.Object3D): void {
    this.actorObjects.set(identityHex, object);
  }

  /** Called from `PlayerBody`'s unmount cleanup, paired with `registerActor`. */
  unregisterActor(identityHex: string): void {
    this.actorObjects.delete(identityHex);
    for (const key of this.anchorBones.keys()) {
      if (key.startsWith(`${identityHex}:`)) this.anchorBones.delete(key);
    }
  }

  /**
   * Writes the world point an effect of this ANCHOR should originate at for
   * `identityHex` into `target`.
   *
   * Three sources, in descending order of truth:
   *
   *  1. the anchor's own rig bone on the actor's live skeleton (a hand really
   *     is where the hand is, whatever the animation is doing this frame);
   *  2. the actor's live registered `Object3D` plus the anchor's height/forward
   *     offset (correct body, approximated part);
   *  3. `fallback` — an `action_event` row's own snapshot — plus the anchor's
   *     HEIGHT only, since without a live object there is no facing to reach
   *     along. Also the path for a genuinely actor-less anchor (an aoe target
   *     point, a flash on a victim whose position came from the row), which
   *     passes `identityHex: null`.
   *
   * Never allocates: callers own `target`, and the facing maths uses
   * module-level scratch.
   */
  private anchorPoint(
    target: THREE.Vector3,
    anchor: EffectAnchorId,
    identityHex: string | null,
    fallback: { x: number; y: number; z: number },
  ): void {
    const object = identityHex === null ? undefined : this.actorObjects.get(identityHex);
    if (object && identityHex !== null) {
      this.anchorOnObject(target, anchor, identityHex, object);
      return;
    }
    const spec = EFFECT_ANCHORS[anchor];
    target.set(fallback.x, fallback.y + spec.height, fallback.z);
  }

  /** Source (1)/(2) of `anchorPoint`, split out so `refreshFollowingLights` can reuse it. */
  private anchorOnObject(
    target: THREE.Vector3,
    anchor: EffectAnchorId,
    identityHex: string,
    object: THREE.Object3D,
  ): void {
    const spec = EFFECT_ANCHORS[anchor];
    if (spec.bone !== null) {
      const bone = this.anchorBone(identityHex, object, spec.bone);
      if (bone) {
        bone.getWorldPosition(target);
        return;
      }
    }
    object.getWorldPosition(target);
    target.y += spec.height;
    if (spec.forward !== 0) {
      // The registered object is the rig's parent group, whose world rotation IS the
      // sim yaw (`game/App.tsx` sets it; `PlayerBody` puts the rig's own 180° facing
      // correction on a CHILD of it). A yaw-rotated object's local −Z lands on
      // `(-sin y, 0, -cos y)`, which is exactly `sim/movement.ts`'s forward vector.
      object.getWorldQuaternion(SCRATCH_QUATERNION);
      SCRATCH_FORWARD.set(0, 0, -1).applyQuaternion(SCRATCH_QUATERNION);
      target.addScaledVector(SCRATCH_FORWARD, spec.forward);
    }
  }

  private anchorBone(identityHex: string, object: THREE.Object3D, boneId: MogBoneId): THREE.Object3D | null {
    const key = `${identityHex}:${boneId}`;
    const cached = this.anchorBones.get(key);
    if (cached) return cached;
    for (const name of boneNameCandidates(boneId)) {
      const found = object.getObjectByName(name);
      if (found) {
        this.anchorBones.set(key, found);
        return found;
      }
    }
    return null;
  }

  update(deltaSeconds: number): void {
    this.refreshFollowingLights();
    this.lights.update(deltaSeconds);
    this.meleeFlashes.update(deltaSeconds);
    this.aoeRings.update(deltaSeconds);
    // Projectiles are row-presence-driven (`syncProjectiles`), not timed —
    // their entries spawn with `Infinity` and `update` leaves them alone.
  }

  /**
   * Re-anchors every live `followActor` light to that actor's CURRENT position,
   * once per frame — at the SAME anchor it was spawned at, or a torso glow would
   * drop to the actor's feet on the first frame after it spawned.
   */
  private refreshFollowingLights(): void {
    for (const entry of this.lights.entries) {
      const follow = entry.resource.followActor;
      if (entry.key === null || follow === null) continue;
      const object = this.actorObjects.get(follow);
      if (object) this.anchorOnObject(entry.resource.position, entry.resource.anchor, follow, object);
    }
  }

  /**
   * One `action_event` row → zero or more pooled visuals, picked from the
   * def's OWN `effects` list by effect KIND — never by `actionId`. This is
   * the client-side mirror of `server/spacetimedb/src/actions/effects.rs`'s
   * one-match-arm-per-kind shape: adding an effect kind is the only place
   * that ever needs a new branch here, and it is the same place gameplay
   * added one.
   */
  onActionEvent(event: EffectActionEventRow, defs: readonly ActionDef[]): void {
    if (!event.position) return;
    const def = defs.find(d => d.id === event.actionId);
    if (!def) return;

    for (const effect of def.effects) {
      switch (effect.kind) {
        case 'melee_arc': {
          // Always the ACTOR's own position, never `event.position` — the row's own
          // position is the server's damage-resolution point (the TARGET's transform
          // on a hit, the attacker's on a miss, see `effects.rs::apply_melee_arc`), which
          // is the right anchor for a damage number but the wrong one for "the swing
          // came from the person swinging." `anchorPoint` also sidesteps the raw
          // `player_transform` snapshot's lag behind what's actually on screen — see
          // `actorObjects`' doc — and lifts the flash off the floor into the arc the
          // swing actually sweeps (`aheadOfChest`).
          const state = this.meleeFlashes.spawn(event.id, MELEE_FLASH_SECONDS);
          this.anchorPoint(state.position, anchorForKind('melee_arc'), event.actor, event.position);
          break;
        }
        case 'aoe_at_target': {
          // `event.position` IS the meaningful anchor here (the server-computed
          // target point, not just "where the actor stands"), and the ring belongs
          // flat on the ground at it — so: the row, at the `feet` anchor, which
          // adds nothing. Routed through the table anyway so every kind's origin
          // is stated in the same one place.
          const state = this.aoeRings.spawn(event.id, AOE_RING_SECONDS);
          this.anchorPoint(state.position, anchorForKind('aoe_at_target'), null, event.position);
          state.radius = effect.radius;
          break;
        }
        case 'projectile': {
          // The projectile mesh itself is reconciled from `projectile` rows
          // (`syncProjectiles`) and its MUZZLE flash comes from the caster's own
          // action state (`onPlayerActionState`) — the server emits no event for a
          // projectile leaving a hand. What lands here is the far end: an impact,
          // whose row position is the VICTIM's transform. So this is a hit flash on
          // a body, anchored to the row (a specific, already-past point in space,
          // not something to keep following) at torso height rather than at the
          // victim's ankles.
          const state = this.lights.spawn(event.id, IMPACT_LIGHT_SECONDS);
          this.anchorPoint(state.position, IMPACT_ANCHOR, null, event.position);
          state.color.setHex(IMPACT_LIGHT_COLOR);
          state.intensity = 1;
          state.followActor = null;
          state.anchor = IMPACT_ANCHOR;
          break;
        }
        case 'heal_self': {
          // potion / mend: a soft green pulse that FOLLOWS the actor for its whole
          // lifetime (`refreshFollowingLights`), not just a one-shot spawn position —
          // per spec, "heal/potion glow follows the actor" — centred on the body it
          // is healing rather than pooled around their boots.
          const anchor = anchorForKind('heal_self');
          const state = this.lights.spawn(event.id, HEAL_LIGHT_SECONDS);
          this.anchorPoint(state.position, anchor, event.actor, event.position);
          state.color.setHex(HEAL_LIGHT_COLOR);
          state.intensity = 1.4;
          state.followActor = event.actor;
          state.anchor = anchor;
          break;
        }
        default:
          // displace_self / invulnerable / mitigation: no `action_event` row
          // exists for these on the server (they are passive/self-status
          // checks, not one-shot occurrences — see `effects.rs`'s
          // `apply_active_enter`), so there is nothing here to react to. The
          // roll dash gets its visual from `onPlayerActionState` instead,
          // driven off the action-state row directly rather than an event.
          break;
      }
    }
  }

  /**
   * Reconcile the projectile pool against the CURRENT set of live rows —
   * unlike `onActionEvent`, a projectile is a standing row, not a one-shot
   * event: borrow a slot the first time an id is seen, refresh it every tick
   * it is still present, and release it the tick it is gone (impact or
   * despawn are both just "the row disappeared" from here).
   *
   * The row's XZ is authoritative and copied straight through. Its Y is not
   * meaningful: the server spawns a projectile at the caster's transform (y=0,
   * their feet) and every hit test it does is 2D —
   * `effects.rs::distance_sq_to_segment_2d` and `step_projectile_position`
   * ignore y entirely — so rendering the row verbatim slides bolts along the
   * floor between two ankles. Lifting the visual to the same `hand` anchor the
   * muzzle flash uses is presentation-only by construction: nothing on the
   * server can observe the difference, and the bolt now leaves the hand it was
   * thrown from and stays at that height.
   */
  syncProjectiles(rows: readonly EffectProjectileRow[]): void {
    const flightHeight = EFFECT_ANCHORS[anchorForKind('projectile')].height;
    const liveIds = new Set(rows.map(row => row.id));
    for (const entry of this.projectiles.entries) {
      if (entry.key !== null && !liveIds.has(entry.key)) {
        this.projectiles.release(entry.key);
      }
    }
    for (const row of rows) {
      const state = this.projectiles.get(row.id) ?? this.projectiles.spawn(row.id, Number.POSITIVE_INFINITY);
      state.position.set(row.position.x, row.position.y + flightHeight, row.position.z);
      state.direction.set(row.direction.x, row.direction.y, row.direction.z);
      state.actionId = row.actionId;
    }
  }

  /**
   * The client-local counterpart to `onActionEvent`, for the effect kinds in
   * `LOCAL_ACTIVE_PULSES` — the ones the server emits no `action_event` row for
   * at the moment they happen, so `player_action_state.phase` reaching Active is
   * the only signal there is. `position` should be wherever this player is
   * actually RENDERED this frame (`PlayerBody` passes its own group's world
   * position — see `actorObjects`' doc for why that differs from the raw
   * `player_transform` row), one call per player per frame, cheap to call
   * unconditionally the same way `driveAnimationFromActionState` is.
   *
   * Picked by effect KIND on the def, same discipline as `onActionEvent` —
   * never by `actionId` — and anchored through the same table, so a roll's
   * scuff lands on the floor and a bolt's muzzle flash lands on the hand.
   */
  onPlayerActionState(
    identityHex: string,
    state: { actionId: string; phase: ActionPhase; phaseStartedTick: bigint },
    defs: readonly ActionDef[],
    position: { x: number; y: number; z: number } | null,
  ): void {
    if (state.phase !== ACTION_PHASE.active || !position) return;

    const edgeKey = `${state.actionId} ${state.phase} ${state.phaseStartedTick}`;
    if (this.lastLocalEffectEdge.get(identityHex) === edgeKey) return;
    this.lastLocalEffectEdge.set(identityHex, edgeKey);

    const def = defs.find(d => d.id === state.actionId);
    if (!def) return;

    for (const effect of def.effects) {
      const pulse = LOCAL_ACTIVE_PULSES[effect.kind];
      if (!pulse) continue;

      const anchor = anchorForKind(effect.kind);
      // Keyed per kind as well as per edge: a def with two pulsing kinds would
      // otherwise have the second silently re-borrow the first's slot.
      const light = this.lights.spawn(`local:${identityHex}:${edgeKey}:${effect.kind}`, pulse.seconds);
      this.anchorPoint(light.position, anchor, identityHex, position);
      light.color.setHex(pulse.color);
      light.intensity = pulse.intensity;
      light.anchor = anchor;
      // One-shot, not following: these pulses are over well within their own short
      // life, and `position`/the actor object is already this frame's live render
      // position (see the doc above).
      light.followActor = null;
    }
  }

  /**
   * `lastLocalEffectEdge` is keyed on `identityHex` on a scene-wide singleton
   * that outlives any one player, so a departed player's edge key would
   * otherwise sit there forever. Called from `PlayerBody`'s unmount cleanup
   * (one `PlayerBody` per player, so unmount is the right "this player is
   * gone" signal) — never called from `onPlayerActionState` itself, since
   * that runs every frame for players who are still very much present.
   */
  clearPlayer(identityHex: string): void {
    this.lastLocalEffectEdge.delete(identityHex);
  }
}

export function createEffects(budgets?: EffectBudgets): Effects {
  return new Effects(budgets);
}
