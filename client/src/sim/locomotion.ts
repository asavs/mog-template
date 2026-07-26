import type { InputState } from '../generated/types';
import type { Vec3 } from './ground';

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

// These f32 values must stay in lockstep with server/spacetimedb/src/common.rs.
export const PLAYER_SPEED = Math.fround(6.0);
export const SPRINT_MULTIPLIER = Math.fround(1.8);
export const GRAVITY = Math.fround(-28.8);
export const JUMP_FORCE = Math.fround(10.2);
export const GROUND_Y = Math.fround(0.0);
export const GROUNDED_EPSILON = Math.fround(0.01);
export const TICK_RATE = Math.fround(20.0);
export const DELTA_TIME = Math.fround(1.0 / TICK_RATE);

export const DEFAULT_LOCOMOTION_CONFIG: LocomotionConfig = {
  walkSpeed: PLAYER_SPEED,
  sprintMultiplier: SPRINT_MULTIPLIER,
  gravity: GRAVITY,
  jumpForce: JUMP_FORCE,
  groundAcceleration: Math.fround(1_000_000.0),
  groundFriction: Math.fround(1_000_000.0),
  airAcceleration: Math.fround(1_000_000.0),
  airFriction: Math.fround(1_000_000.0),
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
  if (isGrounded) {
    return isMovingInput(input) && input.sprint;
  }
  return previousSprintActive;
}

export function transitionLocomotion(
  state: LocomotionState,
  input: InputState,
  context: LocomotionContext,
  config: LocomotionConfig = DEFAULT_LOCOMOTION_CONFIG,
): LocomotionState {
  const moving = isMovingInput(input);
  const sprintActive = sprintActiveForLocomotion(
    context.isGrounded,
    input,
    state.sprintActive,
  );
  const targetHorizontalVelocity = desiredHorizontalVelocity(
    input,
    context.rotationY,
    sprintActive,
    config,
  );
  const horizontalVelocity = advanceHorizontalVelocity(
    state.horizontalVelocity,
    targetHorizontalVelocity,
    context.isGrounded,
    moving,
    context.deltaSeconds,
    config,
  );

  const gravityDelta = Math.fround(
    config.gravity * Math.fround(context.deltaSeconds),
  );
  let verticalVelocity = Math.fround(state.verticalVelocity + gravityDelta);
  const startedJump = input.jump && !state.wasJumpPressed && context.isGrounded;
  if (startedJump) {
    verticalVelocity = config.jumpForce;
  }

  let phase: LocomotionPhase;
  if (context.isGrounded && !startedJump) {
    phase = groundedPhase(moving, sprintActive);
  } else if (startedJump || verticalVelocity > 0) {
    phase = 'airborne_jump';
  } else {
    phase = 'airborne_fall';
  }

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
  const moving = isMovingInput(input);
  const sprintActive = sprintActiveForLocomotion(
    resolvedGrounded,
    input,
    state.sprintActive,
  );
  const phase = phaseFor(
    resolvedGrounded,
    state.verticalVelocity,
    moving,
    sprintActive,
  );

  return {
    phase,
    horizontalVelocity: state.horizontalVelocity,
    verticalVelocity: state.verticalVelocity,
    sprintActive,
    wasJumpPressed: state.wasJumpPressed,
  };
}

export function phaseFor(
  isGrounded: boolean,
  verticalVelocity: number,
  moving: boolean,
  sprintActive: boolean,
): LocomotionPhase {
  if (isGrounded) {
    return groundedPhase(moving, sprintActive);
  }
  if (verticalVelocity > 0) {
    return 'airborne_jump';
  }
  return 'airborne_fall';
}

export function groundedPhase(
  moving: boolean,
  sprintActive: boolean,
): LocomotionPhase {
  if (!moving) {
    return 'grounded_idle';
  }
  if (sprintActive) {
    return 'grounded_sprint';
  }
  return 'grounded_walk';
}

export function desiredHorizontalVelocity(
  input: InputState,
  rotationY: number,
  sprintActive: boolean,
  config: LocomotionConfig = DEFAULT_LOCOMOTION_CONFIG,
): Vec2 {
  let moveX = Math.fround(0);
  let moveZ = Math.fround(0);
  const yaw = Math.fround(rotationY);
  const cosYaw = Math.fround(Math.cos(yaw));
  const sinYaw = Math.fround(Math.sin(yaw));

  if (input.forward) {
    moveX = Math.fround(moveX - sinYaw);
    moveZ = Math.fround(moveZ - cosYaw);
  }
  if (input.backward) {
    moveX = Math.fround(moveX + sinYaw);
    moveZ = Math.fround(moveZ + cosYaw);
  }
  if (input.right) {
    moveX = Math.fround(moveX + cosYaw);
    moveZ = Math.fround(moveZ - sinYaw);
  }
  if (input.left) {
    moveX = Math.fround(moveX - cosYaw);
    moveZ = Math.fround(moveZ + sinYaw);
  }

  const lengthSquared = Math.fround(
    Math.fround(moveX * moveX) + Math.fround(moveZ * moveZ),
  );
  if (lengthSquared <= Math.fround(0.001)) {
    return { x: 0, z: 0 };
  }

  const speed = sprintActive
    ? Math.fround(config.walkSpeed * config.sprintMultiplier)
    : config.walkSpeed;
  const length = Math.fround(Math.sqrt(lengthSquared));
  const scale = Math.fround(speed / length);
  return {
    x: Math.fround(moveX * scale),
    z: Math.fround(moveZ * scale),
  };
}

export function advanceHorizontalVelocity(
  current: Vec2,
  target: Vec2,
  isGrounded: boolean,
  moving: boolean,
  deltaSeconds: number,
  config: LocomotionConfig = DEFAULT_LOCOMOTION_CONFIG,
): Vec2 {
  if (config.instantHorizontalVelocity) {
    return target;
  }

  let rate: number;
  if (moving) {
    rate = isGrounded ? config.groundAcceleration : config.airAcceleration;
  } else {
    rate = isGrounded ? config.groundFriction : config.airFriction;
  }
  const maxDelta = Math.fround(rate * Math.fround(deltaSeconds));
  return moveToward(current, target, maxDelta);
}

export function moveToward(
  current: Vec2,
  target: Vec2,
  maxDelta: number,
): Vec2 {
  const dx = Math.fround(target.x - current.x);
  const dz = Math.fround(target.z - current.z);
  const distanceSquared = Math.fround(
    Math.fround(dx * dx) + Math.fround(dz * dz),
  );
  const distance = Math.fround(Math.sqrt(distanceSquared));
  if (distance <= maxDelta || distance <= Math.fround(0.0001)) {
    return target;
  }

  const scale = Math.fround(maxDelta / distance);
  return {
    x: Math.fround(current.x + Math.fround(dx * scale)),
    z: Math.fround(current.z + Math.fround(dz * scale)),
  };
}

export function isGroundedAt(position: Vec3, groundY: number): boolean {
  const groundedThreshold = Math.fround(groundY + GROUNDED_EPSILON);
  return position.y <= groundedThreshold;
}
