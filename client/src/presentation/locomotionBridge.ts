/**
 * Locomotion presentation bridge: `sim/locomotion.ts`'s FSM phase (plus, for
 * the local player, the raw movement axes driving it) → a `motion.loco_*` /
 * `motion.air_*` key for `AnimationController.setLocomotion`.
 *
 * Pure and table-free (unlike `animBridge.ts`, there is no def to read —
 * locomotion is not an action). Split into two entry points because the two
 * sides of the network see different data:
 *
 * - The LOCAL player is predicted by `game/frame.ts` from real input, which
 *   exposes both the FSM phase (`FrameRenderState.localLocomotionPhase`) and
 *   the raw forward/backward/left/right axes that drove it, so idle/walk/run
 *   can pick a directional clip.
 * - REMOTE players are reconstructed from `player_transform.movementState` +
 *   `isMoving` (`docs/action-pipeline.md`'s wire tables), which carries
 *   grounded/airborne/sprint booleans but not raw input axes — the server
 *   does not broadcast another player's key state. See
 *   `locomotionKeyForRemoteState`'s doc for the resulting gap.
 */

import { MOTION_AIR, MOTION_LOCOMOTION } from '../content/keys';
import type { LocomotionPhase } from '../sim/locomotion';

export type DirectionalInput = {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
};

/** Local player: the sim's own FSM phase, plus the axes that produced it. */
export function locomotionKeyForPhase(phase: LocomotionPhase, input: DirectionalInput): string {
  switch (phase) {
    case 'airborne_jump':
    case 'airborne_fall':
      return MOTION_AIR.jump;
    case 'grounded_idle':
      return MOTION_LOCOMOTION.idle;
    case 'grounded_walk':
      return directionalKey(input, false);
    case 'grounded_sprint':
      return directionalKey(input, true);
  }
}

function directionalKey(input: DirectionalInput, running: boolean): string {
  if (input.forward) return running ? MOTION_LOCOMOTION.runForward : MOTION_LOCOMOTION.walkForward;
  if (input.backward) return running ? MOTION_LOCOMOTION.runBack : MOTION_LOCOMOTION.walkBack;
  if (input.left) return running ? MOTION_LOCOMOTION.runLeft : MOTION_LOCOMOTION.walkLeft;
  if (input.right) return running ? MOTION_LOCOMOTION.runRight : MOTION_LOCOMOTION.walkRight;
  return MOTION_LOCOMOTION.idle;
}

/**
 * Remote players: coarse booleans only, no raw input axes — so a remote body
 * always reads as facing/moving straight ahead (forward walk/run) rather than
 * strafing or backpedaling, even when the real player is doing exactly that.
 * Known gap, not a bug: fixing it needs the server (or the remote's own
 * client) to broadcast input axes, which is out of this wave's scope. Airborne
 * likewise collapses jump and fall to one key — `movementState` carries
 * `isAirborne`, not vertical velocity's sign.
 */
export function locomotionKeyForRemoteState(isAirborne: boolean, isMoving: boolean, sprintActive: boolean): string {
  if (isAirborne) return MOTION_AIR.jump;
  if (!isMoving) return MOTION_LOCOMOTION.idle;
  return sprintActive ? MOTION_LOCOMOTION.runForward : MOTION_LOCOMOTION.walkForward;
}
