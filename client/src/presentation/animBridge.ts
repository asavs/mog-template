/**
 * The presentation bridge: `(player_action_state row, ACTION_DEFS)` →
 * `AnimationController` calls. See `docs/action-pipeline.md` §Presentation
 * bridge for the contract this implements.
 *
 * Pure and table-driven — every call here is derived from a def's own fields
 * (`hold`, `motionLayer`, `movement`) and the row's `phase`, never from an
 * `action_id` string. Adding an action never touches this file; it is a row
 * in `shared/actions.json` and nothing here.
 *
 * Every exported `drive*` function is a stateless, idempotent-safe function of
 * its inputs — see the doc comment on each for why repeated calls with the
 * same row are always safe. That is what lets a caller simply invoke these
 * every tick/frame with whatever the current row says, for as many players as
 * exist: the SAME functions drive a remote player's presentation, called with
 * that player's own `AnimationController` and their own rows. There is no
 * per-call setup — one controller instance per player is the only state.
 */

import type { ActionDef } from '../actions/defs.generated';
import type { AbilityPlaybackOptions, PhasedKeys, PhasedRuleNames } from '../anim/AnimationController';

/**
 * Mirrors the server's `player_action_state.phase` (see
 * `docs/action-pipeline.md` §Tables): 0 Idle, 1 Charging, 2 Windup, 3 Active,
 * 4 Held, 5 Recovery.
 */
export const ACTION_PHASE = {
  idle: 0,
  charging: 1,
  windup: 2,
  active: 3,
  held: 4,
  recovery: 5,
} as const;

export type ActionPhase = (typeof ACTION_PHASE)[keyof typeof ACTION_PHASE];

/**
 * The minimal shape this bridge needs from a `player_action_state` row.
 *
 * Deliberately NOT the generated SpacetimeDB row type
 * (`client/src/generated/player_action_state_table.ts`) — `presentation/`
 * does not own `generated/`, and a structural subset here keeps this module
 * testable against plain objects and decoupled from codegen churn.
 *
 * // integration: wave2-shell — wire the real `player_action_state` row to
 * this shape at the call site (it already has `actionId` and `phase` fields
 * under those exact names, so this may be usable as-is).
 */
export type ActionStateRow = {
  /** `''` when idle. */
  actionId: string;
  phase: ActionPhase;
};

/**
 * The controller surface this bridge drives. Structurally satisfied by
 * `AnimationController` — kept as its own interface so bridge logic is
 * unit-testable against a plain mock instead of a real mixer, and so this
 * file does not need to know the controller is backed by three.js at all.
 */
export interface PresentationController {
  playPhased(desired: boolean, keys: PhasedKeys, ruleNames: PhasedRuleNames): boolean;
  playAbility(key: string, options?: AbilityPlaybackOptions): boolean;
  enterAbilityRecovery(): void;
  playHitReaction(key?: string): boolean;
  playDeath(key?: string): boolean;
}

/**
 * The generic (non-guard) phased rule triplet — see `config.ts`'s
 * `holdEnter`/`holdHeld`/`holdExit`. Every hold-capable, upper-layer def
 * shares this one triplet; guard keeps its own dedicated priority because it
 * is not driven through this bridge.
 */
const HOLD_RULE_NAMES: PhasedRuleNames = {
  enter: 'holdEnter',
  held: 'holdHeld',
  exit: 'holdExit',
};

/**
 * The `<motion>_enter` / `<motion>_hold` / `<motion>_exit` lookup convention
 * from `docs/action-pipeline.md` §Presentation bridge, restated as the exact
 * degradation `playPhased` already implements: `held` is the def's own
 * `motion` key unqualified — the gesture's base name already names the pose
 * being held (`act_guard_hold`, not `act_guard_hold_hold`) — and `enter`/
 * `exit` are optional suffixed variants. `playPhased` resolves each key
 * itself and silently skips whichever ones have no authored clip, so this
 * function only builds candidate strings; it needs no resolver of its own,
 * which is what keeps this module pure.
 */
export function phasedKeysFor(motion: string): PhasedKeys {
  return {
    enter: `${motion}_enter`,
    held: motion,
    exit: `${motion}_exit`,
  };
}

/** Phases in which a hold-capable def's held pose should be showing. */
const HOLD_DESIRED_PHASES: ReadonlySet<ActionPhase> = new Set([
  ACTION_PHASE.charging,
  ACTION_PHASE.windup,
  ACTION_PHASE.held,
]);

/** Phases in which an instant (or a hold-capable-but-full-layer) def's motion should be playing. */
const INSTANT_PLAY_PHASES: ReadonlySet<ActionPhase> = new Set([
  ACTION_PHASE.windup,
  ACTION_PHASE.active,
]);

/**
 * Drive every def's presentation from the current action-state row.
 *
 * Two independent, data-driven passes, per `docs/action-pipeline.md`:
 *
 * 1. Every def with `hold !== null` AND `motionLayer === 'upper'` runs the
 *    phased path (`playPhased`) — hold-capable, full-layer defs (today, only
 *    `attack_heavy`, a charge-mode two-hander) fall through to the instant
 *    path instead: `playPhased` only ever occupies the upper overlay (guard's
 *    original scope, and every hold-capable def introduced so far but that
 *    one is upper too), and a full-body held pose is not a mechanism this
 *    wave built. The charge itself is presentation-silent; the swing plays
 *    normally once the charge releases into Windup. Flagged in the wave
 *    report as a gap for whichever wave next needs a visible charge-up pose
 *    on a two-hander.
 * 2. Every def plays its `motion` once via `playAbility` on entering
 *    Windup/Active — `playAbility`/`playFullBody` are themselves idempotent
 *    under a repeated call for the action already in flight (they require
 *    `enterAbilityRecovery` before a same-layer re-fire succeeds), so calling
 *    this every tick while a def is mid-flight is safe and does not restart
 *    the clip.
 *
 * `enterAbilityRecovery()` is called whenever the row is in Recovery,
 * regardless of which def — also idempotent, and it only has any effect at
 * all if the currently-playing overlay/override is actually an ability.
 */
export function driveAnimationFromActionState(
  controller: PresentationController,
  defs: readonly ActionDef[],
  state: ActionStateRow,
): void {
  for (const def of defs) {
    if (def.hold === null || def.motionLayer !== 'upper') continue;
    const desired = state.actionId === def.id && HOLD_DESIRED_PHASES.has(state.phase);
    controller.playPhased(desired, phasedKeysFor(def.motion), HOLD_RULE_NAMES);
  }

  const current = defs.find(def => def.id === state.actionId);
  if (!current) return;

  if (INSTANT_PLAY_PHASES.has(state.phase)) {
    controller.playAbility(current.motion, {
      upperBodyOnly: current.motionLayer === 'upper',
      // The clip's mask width is fixed for its whole one-shot duration (see
      // `AbilityPlaybackOptions.movement`), so one phase has to be the
      // representative value. Windup is where the clip starts and where an
      // authored gesture's freedom-to-move is most meaningful to read, so
      // that is the one this uses rather than averaging across phases.
      movement: current.movement.windup,
    });
  }

  if (state.phase === ACTION_PHASE.recovery) {
    controller.enterAbilityRecovery();
  }
}

/**
 * The minimal shape this bridge needs from an `action_event` row, for hit
 * reactions. See `presentation/reactions.ts`, which composes this with the
 * matching visual effect.
 */
export type ActionEventRow = {
  kind: string;
  /** Whether this row's `target` is the identity driving `controller`. */
  targetIsSelf: boolean;
};

/**
 * `playHitReaction` retriggers rather than queuing (see `MOTION_RULES.reactHit`),
 * so calling this once per `hit` event row — even several in the same tick —
 * is exactly the intended behavior, not a bug to debounce.
 */
export function driveHitReaction(controller: PresentationController, event: ActionEventRow): void {
  if (!event.targetIsSelf || event.kind !== 'hit') return;
  controller.playHitReaction();
}

/** The minimal shape this bridge needs from a `player_health` row. */
export type HealthRow = {
  isDead: boolean;
};

/** `playDeath` is a no-op once already dead, so calling this every tick while dead is safe. */
export function driveDeath(controller: PresentationController, health: HealthRow): void {
  if (health.isDead) controller.playDeath();
}
