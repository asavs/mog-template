import type { InputState } from '../generated/types';
import type { Ground, Vec3 } from './ground';
import {
  DEFAULT_LOCOMOTION_CONFIG,
  isGroundedAt,
  isMovingInput,
  phaseFor,
  settleLocomotionAfterMove,
  sprintActiveForLocomotion,
  transitionLocomotion,
  type LocomotionState,
} from './locomotion';

export interface PlayerSimState {
  position: Vec3;
  rotationY: number;
  verticalVelocity: number;
  wasJumpPressed: boolean;
  sprintActive: boolean;
}

/**
 * `movementFraction` is `actions/gates.ts`'s `deriveGates(actionId, phase).movementFraction`
 * — the client mirror of the server's `actions::state::movement_fraction(action_id, phase)`
 * (`docs/action-pipeline.md`'s "movement" field, wired into `tick.rs::game_tick` on the
 * server side). Defaults to 1 (unrestricted) so every existing caller — including the
 * golden-trace parity test, which predates the action pipeline entirely — is unaffected.
 */
export function simulateMovementTick(
  state: PlayerSimState,
  input: InputState,
  rotationY: number,
  ground: Ground,
  deltaSeconds: number,
  movementFraction: number = 1,
): PlayerSimState {
  const groundY = Math.fround(ground.groundY);
  const delta = Math.fround(deltaSeconds);
  const yaw = Math.fround(rotationY);
  const wasGrounded = isGroundedAt(state.position, groundY);
  const sprintActive = sprintActiveForLocomotion(
    wasGrounded,
    input,
    state.sprintActive,
  );
  const currentLocomotion: LocomotionState = {
    phase: phaseFor(
      wasGrounded,
      state.verticalVelocity,
      isMovingInput(input),
      sprintActive,
    ),
    horizontalVelocity: { x: 0, z: 0 },
    verticalVelocity: state.verticalVelocity,
    sprintActive,
    wasJumpPressed: state.wasJumpPressed,
  };
  const nextLocomotion = transitionLocomotion(
    currentLocomotion,
    input,
    {
      isGrounded: wasGrounded,
      wasGrounded,
      rotationY: yaw,
      deltaSeconds: delta,
    },
    DEFAULT_LOCOMOTION_CONFIG,
  );

  let moveX = Math.fround(0);
  let moveZ = Math.fround(0);
  const cosYaw = Math.fround(Math.cos(yaw));
  const sinYaw = Math.fround(Math.sin(yaw));
  const forwardX = Math.fround(-sinYaw);
  const forwardZ = Math.fround(-cosYaw);
  const rightX = cosYaw;
  const rightZ = Math.fround(-sinYaw);

  if (input.forward) {
    moveX = Math.fround(moveX + forwardX);
    moveZ = Math.fround(moveZ + forwardZ);
  }
  if (input.backward) {
    moveX = Math.fround(moveX - forwardX);
    moveZ = Math.fround(moveZ - forwardZ);
  }
  if (input.right) {
    moveX = Math.fround(moveX + rightX);
    moveZ = Math.fround(moveZ + rightZ);
  }
  if (input.left) {
    moveX = Math.fround(moveX - rightX);
    moveZ = Math.fround(moveZ - rightZ);
  }

  const desired: Vec3 = {
    x: state.position.x,
    y: state.position.y,
    z: state.position.z,
  };
  const lengthSquared = Math.fround(
    Math.fround(moveX * moveX) + Math.fround(moveZ * moveZ),
  );
  if (lengthSquared > Math.fround(0.001)) {
    const length = Math.fround(Math.sqrt(lengthSquared));
    const baseSpeed = nextLocomotion.sprintActive
      ? Math.fround(
        DEFAULT_LOCOMOTION_CONFIG.walkSpeed
          * DEFAULT_LOCOMOTION_CONFIG.sprintMultiplier,
      )
      : DEFAULT_LOCOMOTION_CONFIG.walkSpeed;
    const speed = Math.fround(baseSpeed * Math.fround(movementFraction));
    const moveDistance = Math.fround(speed * delta);
    const normalizedX = Math.fround(moveX / length);
    const normalizedZ = Math.fround(moveZ / length);
    desired.x = Math.fround(
      desired.x + Math.fround(normalizedX * moveDistance),
    );
    desired.z = Math.fround(
      desired.z + Math.fround(normalizedZ * moveDistance),
    );
  }

  desired.y = Math.fround(
    desired.y + Math.fround(nextLocomotion.verticalVelocity * delta),
  );
  let verticalVelocity = nextLocomotion.verticalVelocity;
  if (desired.y <= groundY) {
    desired.y = groundY;
    verticalVelocity = 0;
  }

  const collisionResolved = ground.resolveMovement(state.position, desired);
  const resolvedPosition: Vec3 = {
    x: collisionResolved.x,
    y: collisionResolved.y,
    z: collisionResolved.z,
  };
  if (resolvedPosition.y <= groundY) {
    resolvedPosition.y = groundY;
    verticalVelocity = 0;
  }

  const resolvedGrounded = isGroundedAt(resolvedPosition, groundY);
  const locomotionAfterMove = settleLocomotionAfterMove(
    {
      phase: phaseFor(
        resolvedGrounded,
        verticalVelocity,
        isMovingInput(input),
        sprintActive,
      ),
      horizontalVelocity: { x: 0, z: 0 },
      verticalVelocity,
      sprintActive,
      wasJumpPressed: nextLocomotion.wasJumpPressed,
    },
    input,
    resolvedGrounded,
  );

  return {
    position: resolvedPosition,
    rotationY: yaw,
    verticalVelocity,
    wasJumpPressed: nextLocomotion.wasJumpPressed,
    sprintActive: locomotionAfterMove.sprintActive,
  };
}
