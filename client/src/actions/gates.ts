/**
 * Derives movement/rotation/interrupt gates from `(action_id, phase)` plus the
 * shared action defs — the client half of "no stored can_move/can_attack
 * flags" (docs/action-pipeline.md). The server derives the same gates from
 * the same defs on its side (`server/.../actions/state.rs`); this file must
 * never invent a rule the defs do not already encode.
 *
 * Pure and table-driven: every branch reads `ActionDef` fields, never an
 * action id by name.
 */

import { ACTION_DEFS, type ActionDef } from './defs.generated';

/** Mirrors `player_action_state.phase` (docs/action-pipeline.md's phase machine). */
export const Phase = {
  Idle: 0,
  Charging: 1,
  Windup: 2,
  Active: 3,
  Held: 4,
  Recovery: 5,
} as const;

export type PhaseValue = (typeof Phase)[keyof typeof Phase];

const DEFS_BY_ID: ReadonlyMap<string, ActionDef> = new Map(ACTION_DEFS.map(def => [def.id, def]));

export function actionDefById(actionId: string): ActionDef | undefined {
  return DEFS_BY_ID.get(actionId);
}

export interface ActionGates {
  /** Whether starting `newDef` is allowed to interrupt the current action. */
  canStartAction(newDef: ActionDef | null): boolean;
  /** Fraction of full move speed available in the current phase. */
  movementFraction: number;
  /** Whether aim yaw may update mid-action in the current phase. */
  canRotate: boolean;
}

const UNRESTRICTED: ActionGates = {
  canStartAction: newDef => newDef !== null,
  movementFraction: 1,
  canRotate: true,
};

/**
 * `actionId` is `""` (idle) or a def id from `ACTION_DEFS`; `phase` is a
 * `player_action_state.phase` value. Idle and unrecognized action ids both
 * fail open to the unrestricted gate — an action id the client's defs do not
 * know about should never lock movement, only a *recognized* action's own
 * rules should.
 */
export function deriveGates(actionId: string, phase: number): ActionGates {
  if (!actionId || phase === Phase.Idle) return UNRESTRICTED;

  const def = DEFS_BY_ID.get(actionId);
  if (!def) return UNRESTRICTED;

  return {
    canStartAction: newDef => canInterrupt(def, phase, newDef),
    movementFraction: movementFractionForPhase(def, phase),
    canRotate: def.canRotate,
  };
}

function canInterrupt(current: ActionDef, phase: number, newDef: ActionDef | null): boolean {
  if (!newDef) return false;
  switch (current.interrupt) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'recovery':
      return phase === Phase.Recovery;
  }
}

function movementFractionForPhase(def: ActionDef, phase: number): number {
  switch (phase) {
    case Phase.Charging:
      return def.movement.charging;
    case Phase.Windup:
      return def.movement.windup;
    case Phase.Active:
      return def.movement.active;
    case Phase.Held:
      return def.movement.held;
    case Phase.Recovery:
      return def.movement.recovery;
    default:
      // Idle is handled above; any other numeric value is out of the known
      // phase range and gets the def's most conservative reading: rooted.
      return 0;
  }
}
