/**
 * Hit-flash / death glue: composes `animBridge`'s per-player animation
 * reactions with `effects`'s scene-wide pooled visuals, on the same
 * row-driven pattern as the rest of `presentation/`.
 *
 * The two halves are driven by different scopes, deliberately kept separate
 * rather than merged into one class: an `AnimationController` is per-player
 * (one skeleton, one mixer) and only the OWNER of the row's target should
 * flinch; an `Effects` pool is scene-wide (one shared light/flash/ring
 * budget) and everyone nearby should see the flash, witness or victim alike.
 * `driveReactionsFromEvent` takes both because it drives one player's own
 * reaction for one event, but a caller looping over remote players calls
 * `driveHitReaction` directly (re-exported from `animBridge`) per player,
 * against the ONE shared `Effects` instance, so the visual never doubles up.
 */

import type { ActionDef } from '../actions/defs.generated';
import {
  driveDeath,
  driveHitReaction,
  type ActionEventRow,
  type HealthRow,
  type PresentationController,
} from './animBridge';
import { Effects, type EffectActionEventRow } from './effects';

export { driveDeath, driveHitReaction } from './animBridge';
export type { ActionEventRow, HealthRow, PresentationController } from './animBridge';

/**
 * The union of what `driveHitReaction` and `Effects.onActionEvent` each need
 * from an `action_event` row — one row shape for both halves of the glue.
 */
export type ReactionEventRow = ActionEventRow & EffectActionEventRow;

/**
 * One `action_event` row → this player's own hit-flinch (only if `row.target`
 * is them) AND the scene-wide visual (melee flash / aoe ring / impact light,
 * for anyone watching). Call once per row per player whose `controller` this
 * is — for a crowd of remote players, that means once per row per remote
 * controller, all sharing the SAME `effects` instance so the visual is not
 * spawned once per witness.
 */
export function driveReactionsFromEvent(
  controller: PresentationController,
  effects: Effects,
  defs: readonly ActionDef[],
  event: ReactionEventRow,
): void {
  driveHitReaction(controller, event);
  effects.onActionEvent(event, defs);
}

/**
 * One `player_health` row → this player's death override. No scene-wide
 * visual is wired here yet — death reads from the motion alone
 * (`react_death`'s own collapse, per `docs/motion-vocabulary.md`) and a
 * death-specific effect (a dimming light, a ground mark) is future budget,
 * not something this wave's "minimal pooled visuals" scope asked for.
 */
export function driveDeathReaction(controller: PresentationController, health: HealthRow): void {
  driveDeath(controller, health);
}
