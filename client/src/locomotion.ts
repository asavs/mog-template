import type { InputState, MovementState } from './generated/types';

export type LocomotionPhase =
  | 'grounded_idle'
  | 'grounded_walk'
  | 'grounded_sprint'
  | 'airborne_jump'
  | 'airborne_fall';

export interface Vec2 {
  x: number;
  z: number;
}

export interface LocomotionState {
  phase: LocomotionPhase;
  horizontalVelocity: Vec2;
  verticalVelocity: number;
  sprintActive: boolean;
  wasJumpPressed: boolean;
}

export interface LocomotionConfig {
  walkSpeed: number;
  sprintMultiplier: number;
  gravity: number;
  jumpForce: number;
  groundAcceleration: number;
  groundFriction: number;
  airAcceleration: number;
  airFriction: number;
  instantHorizontalVelocity: boolean;
}

export interface LocomotionContext {
  isGrounded: boolean;
  wasGrounded: boolean;
  rotationY: number;
  deltaSeconds: number;
}

export const PLAYER_SPEED = 6.0;
export const SPRINT_MULTIPLIER = 1.8;
// Tuned for roughly a 1.8m apex and 0.7s total airtime on flat ground.
export const GRAVITY = -28.8;
export const JUMP_FORCE = 10.2;
export const GROUND_Y = 0.0;
export const GROUNDED_EPSILON = 0.01;

export const DEFAULT_LOCOMOTION_CONFIG: LocomotionConfig = {
  walkSpeed: PLAYER_SPEED,
  sprintMultiplier: SPRINT_MULTIPLIER,
  gravity: GRAVITY,
  jumpForce: JUMP_FORCE,
  groundAcceleration: 1_000_000,
  groundFriction: 1_000_000,
  airAcceleration: 1_000_000,
  airFriction: 1_000_000,
  instantHorizontalVelocity: true,
};

export function isMovingInput(input: InputState): boolean {
  return input.forward || input.backward || input.left || input.right;
}

export function sprintActiveForLocomotion(
  isGrounded: boolean,
  input: InputState,
  previousSprintActive: boolean,
): boolean {
  return isGrounded ? isMovingInput(input) && input.sprint : previousSprintActive;
}

export function locomotionStateFromMovementState(
  movementState: MovementState,
  verticalVelocity: number,
  wasJumpPressed: boolean,
  input: InputState,
  rotationY: number,
): LocomotionState {
  return {
    phase: phaseFor(
      movementState.isGrounded,
      verticalVelocity,
      isMovingInput(input),
      movementState.sprintActive,
    ),
    horizontalVelocity: desiredHorizontalVelocity(
      input,
      rotationY,
      movementState.sprintActive,
      DEFAULT_LOCOMOTION_CONFIG,
    ),
    verticalVelocity,
    sprintActive: movementState.sprintActive,
    wasJumpPressed,
  };
}

export function transitionLocomotion(
  state: LocomotionState,
  input: InputState,
  context: LocomotionContext,
  config = DEFAULT_LOCOMOTION_CONFIG,
): LocomotionState {
  const moving = isMovingInput(input);
  const sprintActive = sprintActiveForLocomotion(context.isGrounded, input, state.sprintActive);
  const targetHorizontalVelocity = desiredHorizontalVelocity(input, context.rotationY, sprintActive, config);
  const horizontalVelocity = advanceHorizontalVelocity(
    state.horizontalVelocity,
    targetHorizontalVelocity,
    context.isGrounded,
    moving,
    context.deltaSeconds,
    config,
  );

  let verticalVelocity = state.verticalVelocity + config.gravity * context.deltaSeconds;
  const startedJump = input.jump && !state.wasJumpPressed && context.isGrounded;
  if (startedJump) {
    verticalVelocity = config.jumpForce;
  }

  const phase = context.isGrounded && !startedJump
    ? groundedPhase(moving, sprintActive)
    : startedJump || verticalVelocity > 0
      ? 'airborne_jump'
      : 'airborne_fall';

  return {
    phase,
    horizontalVelocity,
    verticalVelocity,
    sprintActive,
    wasJumpPressed: input.jump,
  };
}

export function settleLocomotionAfterMove(
  state: LocomotionState,
  input: InputState,
  resolvedGrounded: boolean,
): LocomotionState {
  // Re-apply the sprint rule against post-move groundedness. The pre-refactor
  // code applied it both before and after the move, so landing while holding
  // sprint activates it on the landing tick itself.
  const sprintActive = sprintActiveForLocomotion(resolvedGrounded, input, state.sprintActive);
  return {
    ...state,
    sprintActive,
    phase: phaseFor(resolvedGrounded, state.verticalVelocity, isMovingInput(input), sprintActive),
  };
}

export function movementStateFromLocomotion(
  state: LocomotionState,
  isGrounded: boolean,
  wasGrounded: boolean,
  input: InputState,
): MovementState {
  return {
    isGrounded,
    wasGrounded,
    isAirborne: !isGrounded,
    sprintIntent: input.sprint,
    sprintActive: state.sprintActive,
  };
}

export function phaseFor(
  isGrounded: boolean,
  verticalVelocity: number,
  moving: boolean,
  sprintActive: boolean,
): LocomotionPhase {
  if (isGrounded) return groundedPhase(moving, sprintActive);
  return verticalVelocity > 0 ? 'airborne_jump' : 'airborne_fall';
}

function groundedPhase(moving: boolean, sprintActive: boolean): LocomotionPhase {
  if (!moving) return 'grounded_idle';
  return sprintActive ? 'grounded_sprint' : 'grounded_walk';
}

function desiredHorizontalVelocity(
  input: InputState,
  rotationY: number,
  sprintActive: boolean,
  config: LocomotionConfig,
): Vec2 {
  let moveX = 0;
  let moveZ = 0;
  const sinYaw = Math.sin(rotationY);
  const cosYaw = Math.cos(rotationY);

  if (input.forward) {
    moveX -= sinYaw;
    moveZ -= cosYaw;
  }
  if (input.backward) {
    moveX += sinYaw;
    moveZ += cosYaw;
  }
  if (input.right) {
    moveX += cosYaw;
    moveZ -= sinYaw;
  }
  if (input.left) {
    moveX -= cosYaw;
    moveZ += sinYaw;
  }

  const lengthSq = moveX * moveX + moveZ * moveZ;
  if (lengthSq <= 0.001) return { x: 0, z: 0 };

  const speed = sprintActive ? config.walkSpeed * config.sprintMultiplier : config.walkSpeed;
  const scale = speed / Math.sqrt(lengthSq);
  return { x: moveX * scale, z: moveZ * scale };
}

function advanceHorizontalVelocity(
  current: Vec2,
  target: Vec2,
  isGrounded: boolean,
  moving: boolean,
  deltaSeconds: number,
  config: LocomotionConfig,
): Vec2 {
  if (config.instantHorizontalVelocity) return target;

  const rate = moving
    ? isGrounded ? config.groundAcceleration : config.airAcceleration
    : isGrounded ? config.groundFriction : config.airFriction;
  return moveToward(current, target, rate * deltaSeconds);
}

function moveToward(current: Vec2, target: Vec2, maxDelta: number): Vec2 {
  const dx = target.x - current.x;
  const dz = target.z - current.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= maxDelta || distance <= 0.0001) return target;
  const scale = maxDelta / distance;
  return {
    x: current.x + dx * scale,
    z: current.z + dz * scale,
  };
}