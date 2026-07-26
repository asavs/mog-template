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

  constructor(budgets: EffectBudgets = {}) {
    this.lights = createPointLightPool(budgets.lights ?? NUM_EFFECT_LIGHTS);
    this.meleeFlashes = createMeleeFlashPool(budgets.meleeFlashes ?? NUM_MELEE_FLASHES);
    this.aoeRings = createAoeRingPool(budgets.aoeRings ?? NUM_AOE_RINGS);
    this.projectiles = createProjectilePool(budgets.projectiles ?? NUM_PROJECTILES);
  }

  update(deltaSeconds: number): void {
    this.lights.update(deltaSeconds);
    this.meleeFlashes.update(deltaSeconds);
    this.aoeRings.update(deltaSeconds);
    // Projectiles are row-presence-driven (`syncProjectiles`), not timed —
    // their entries spawn with `Infinity` and `update` leaves them alone.
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
          const state = this.meleeFlashes.spawn(event.id, MELEE_FLASH_SECONDS);
          state.position.set(event.position.x, event.position.y, event.position.z);
          break;
        }
        case 'aoe_at_target': {
          const state = this.aoeRings.spawn(event.id, AOE_RING_SECONDS);
          state.position.set(event.position.x, event.position.y, event.position.z);
          state.radius = effect.radius;
          break;
        }
        case 'projectile': {
          // The projectile mesh itself is reconciled from `projectile` rows
          // (`syncProjectiles`); a release/impact event still gets a brief
          // point-light pulse, the same as melee's flash.
          const state = this.lights.spawn(event.id, IMPACT_LIGHT_SECONDS);
          state.position.set(event.position.x, event.position.y, event.position.z);
          state.color.setHex(IMPACT_LIGHT_COLOR);
          state.intensity = 1;
          break;
        }
        case 'heal_self': {
          // potion / mend: a soft green pulse on the actor so "something
          // happened" reads even though the effect itself (health going up)
          // has no shape of its own.
          const state = this.lights.spawn(event.id, HEAL_LIGHT_SECONDS);
          state.position.set(event.position.x, event.position.y, event.position.z);
          state.color.setHex(HEAL_LIGHT_COLOR);
          state.intensity = 1.4;
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
   */
  syncProjectiles(rows: readonly EffectProjectileRow[]): void {
    const liveIds = new Set(rows.map(row => row.id));
    for (const entry of this.projectiles.entries) {
      if (entry.key !== null && !liveIds.has(entry.key)) {
        this.projectiles.release(entry.key);
      }
    }
    for (const row of rows) {
      const state = this.projectiles.get(row.id) ?? this.projectiles.spawn(row.id, Number.POSITIVE_INFINITY);
      state.position.set(row.position.x, row.position.y, row.position.z);
      state.direction.set(row.direction.x, row.direction.y, row.direction.z);
      state.actionId = row.actionId;
    }
  }

  /**
   * The client-local counterpart to `onActionEvent`, for effect kinds that
   * never get an `action_event` row: `displace_self` (today, only `roll`)
   * fires every server tick through `apply_active_tick`, updating position
   * directly with no accompanying event — from here, all that's visible is
   * `player_action_state.phase` reaching Active. Driven straight off that row
   * (`identityHex`'s own `player_transform.position` for where to put it), one
   * call per player per frame, cheap to call unconditionally the same way
   * `driveAnimationFromActionState` is.
   *
   * Picked by effect KIND on the def, same discipline as `onActionEvent` —
   * never by `actionId`.
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
    if (!def?.effects.some(effect => effect.kind === 'displace_self')) return;

    const light = this.lights.spawn(`local:${identityHex}:${edgeKey}`, ROLL_DASH_LIGHT_SECONDS);
    light.position.set(position.x, position.y, position.z);
    light.color.setHex(ROLL_DASH_LIGHT_COLOR);
    light.intensity = 1.1;
  }
}

export function createEffects(budgets?: EffectBudgets): Effects {
  return new Effects(budgets);
}
