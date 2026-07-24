import * as THREE from 'three';
import type { InputState, MovementState } from './generated/types';
import { isTerrainWalkableAt, terrainHeightAt } from './heightmap';
import { STATIC_TERRAIN_BLOCKERS } from './terrainCollision';
import {
  DEFAULT_LOCOMOTION_CONFIG,
  GRAVITY,
  GROUNDED_EPSILON,
  JUMP_FORCE,
  PLAYER_SPEED,
  SPRINT_MULTIPLIER,
  isMovingInput,
  locomotionStateFromMovementState,
  movementStateFromLocomotion,
  settleLocomotionAfterMove,
  sprintActiveForLocomotion,
  transitionLocomotion,
  type LocomotionState,
} from './locomotion';
export {
  DEFAULT_LOCOMOTION_CONFIG,
  GRAVITY,
  GROUNDED_EPSILON,
  GROUND_Y,
  JUMP_FORCE,
  PLAYER_SPEED,
  SPRINT_MULTIPLIER,
  type LocomotionPhase,
  type LocomotionState,
} from './locomotion';
export const PLAYER_COLLISION_RADIUS = 0.45;
export const MAX_WALKABLE_SLOPE_DEGREES = 70;
export const MAX_STEP_HEIGHT = 1.25;
export const MAX_SNAP_DOWN_HEIGHT = 6.0;

const WORLD_MIN_X = -1574.03;
const WORLD_MAX_X = 1574.03;
const WORLD_MIN_Z = -1231.44;
const WORLD_MAX_Z = 1231.44;
const MAX_WALKABLE_SLOPE = Math.tan(THREE.MathUtils.degToRad(MAX_WALKABLE_SLOPE_DEGREES));
const SLOPE_SAMPLE_DISTANCE = 1.0;

interface Aabb {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

// Generated from the dedicated Castle Collision mesh. The same bounds are
// enforced by the authoritative server.
const BLOCKERS: readonly Aabb[] = STATIC_TERRAIN_BLOCKERS;

export function isMoving(input: InputState): boolean {
  return isMovingInput(input);
}

export function isGroundedAt(position: THREE.Vector3): boolean {
  return position.y <= terrainHeightAt(position) + GROUNDED_EPSILON;
}

export function sprintActiveForState(
  isGrounded: boolean,
  input: InputState,
  previousSprintActive: boolean,
): boolean {
  return sprintActiveForLocomotion(isGrounded, input, previousSprintActive);
}

export function createMovementState(
  position: THREE.Vector3,
  input: InputState,
  wasGrounded = isGroundedAt(position),
  previousSprintActive = false,
): MovementState {
  const isGrounded = isGroundedAt(position);
  const sprintIntent = input.sprint;
  return {
    isGrounded,
    wasGrounded,
    isAirborne: !isGrounded,
    sprintIntent,
    sprintActive: sprintActiveForState(isGrounded, input, previousSprintActive),
  };
}

export function applyMovement(
  position: THREE.Vector3,
  rotationY: number,
  input: InputState,
  deltaSeconds: number,
  sprintActive?: boolean,
) {
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
  if (lengthSq <= 0.001) return;

  const speed = (sprintActive ?? createMovementState(position, input).sprintActive)
    ? PLAYER_SPEED * SPRINT_MULTIPLIER
    : PLAYER_SPEED;
  const movementScale = speed * deltaSeconds / Math.sqrt(lengthSq);
  const desired = position.clone();
  desired.x += moveX * movementScale;
  desired.z += moveZ * movementScale;
  const currentGround = terrainHeightAt(position);
  const wasGrounded = position.y <= currentGround + GROUNDED_EPSILON;
  const resolved = resolvePlayerMovement(position, desired);
  if (wasGrounded) {
    const resolvedGround = terrainHeightAt(resolved);
    if (currentGround - resolvedGround <= MAX_SNAP_DOWN_HEIGHT) {
      resolved.y = resolvedGround;
    }
  }
  position.copy(resolved);
}

export function resolvePlayerMovement(current: THREE.Vector3, desired: THREE.Vector3): THREE.Vector3 {
  const clampedDesired = clampToWorld(desired);
  if (canMoveTo(current, clampedDesired)) {
    return clampedDesired;
  }

  const xOnly = clampToWorld(new THREE.Vector3(clampedDesired.x, clampedDesired.y, current.z));
  if (canMoveTo(current, xOnly)) {
    return xOnly;
  }

  const zOnly = clampToWorld(new THREE.Vector3(current.x, clampedDesired.y, clampedDesired.z));
  if (canMoveTo(current, zOnly)) {
    return zOnly;
  }

  return clampToWorld(new THREE.Vector3(current.x, clampedDesired.y, current.z));
}

function clampToWorld(position: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    THREE.MathUtils.clamp(
      position.x,
      WORLD_MIN_X + PLAYER_COLLISION_RADIUS,
      WORLD_MAX_X - PLAYER_COLLISION_RADIUS,
    ),
    position.y,
    THREE.MathUtils.clamp(
      position.z,
      WORLD_MIN_Z + PLAYER_COLLISION_RADIUS,
      WORLD_MAX_Z - PLAYER_COLLISION_RADIUS,
    ),
  );
}

function collidesWithBlockers(position: THREE.Vector3): boolean {
  return BLOCKERS.some(blocker => containsCapsuleFootprint(blocker, position));
}

function canMoveTo(current: THREE.Vector3, desired: THREE.Vector3): boolean {
  return !collidesWithBlockers(desired) && isTerrainStepWalkable(current, desired);
}

export function isTerrainStepWalkable(current: THREE.Vector3, desired: THREE.Vector3): boolean {
  const dx = desired.x - current.x;
  const dz = desired.z - current.z;
  const distance = Math.hypot(dx, dz);
  if (distance <= 0.001) return true;

  const segments = Math.max(1, Math.ceil(distance / SLOPE_SAMPLE_DISTANCE));
  let previousX = current.x;
  let previousZ = current.z;
  let previousGround = terrainHeightAt(current);

  for (let i = 1; i <= segments; i += 1) {
    const t = i / segments;
    const nextX = THREE.MathUtils.lerp(current.x, desired.x, t);
    const nextZ = THREE.MathUtils.lerp(current.z, desired.z, t);
    const nextGround = terrainHeightAt(new THREE.Vector3(nextX, desired.y, nextZ));
    const stepDistance = Math.hypot(nextX - previousX, nextZ - previousZ);
    const heightDelta = nextGround - previousGround;
    const uphillDelta = Math.max(0, heightDelta);
    const uphillSlope = uphillDelta / Math.max(stepDistance, 0.001);

    if (uphillDelta > 0.001
      && (!isTerrainWalkableAt(nextX, nextZ) || uphillSlope > MAX_WALKABLE_SLOPE)) {
      return false;
    }

    previousX = nextX;
    previousZ = nextZ;
    previousGround = nextGround;
  }

  return true;
}

function containsCapsuleFootprint(blocker: Aabb, position: THREE.Vector3): boolean {
  return position.x >= blocker.minX - PLAYER_COLLISION_RADIUS
    && position.x <= blocker.maxX + PLAYER_COLLISION_RADIUS
    && position.z >= blocker.minZ - PLAYER_COLLISION_RADIUS
    && position.z <= blocker.maxZ + PLAYER_COLLISION_RADIUS;
}

export function applyJumpPhysics(
  position: THREE.Vector3,
  input: InputState,
  deltaSeconds: number,
  verticalVelocity: number,
  wasJumpPressed: boolean,
  wasGrounded = isGroundedAt(position),
): { verticalVelocity: number; wasJumpPressed: boolean } {
  const groundY = terrainHeightAt(position);

  let nextVerticalVelocity = verticalVelocity + GRAVITY * deltaSeconds;

  if (input.jump && !wasJumpPressed && wasGrounded) {
    nextVerticalVelocity = JUMP_FORCE;
  }

  position.y += nextVerticalVelocity * deltaSeconds;

  if (position.y <= groundY) {
    position.y = groundY;
    nextVerticalVelocity = 0;
  }

  return {
    verticalVelocity: nextVerticalVelocity,
    wasJumpPressed: input.jump,
  };
}

export function lerpAngle(from: number, to: number, alpha: number): number {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * alpha;
}


export interface SimulateMovementTickResult {
  verticalVelocity: number;
  wasJumpPressed: boolean;
  movementState: MovementState;
  locomotionState: LocomotionState;
}

export function simulateMovementTick(
  position: THREE.Vector3,
  rotationY: number,
  input: InputState,
  deltaSeconds: number,
  verticalVelocity: number,
  wasJumpPressed: boolean,
  previousMovementState: MovementState | null = null,
): SimulateMovementTickResult {
  const movementStateBeforeTick = createMovementState(
    position,
    input,
    previousMovementState?.isGrounded,
    previousMovementState?.sprintActive ?? false,
  );
  const locomotionBeforeTick = locomotionStateFromMovementState(
    movementStateBeforeTick,
    verticalVelocity,
    wasJumpPressed,
    input,
    rotationY,
  );
  const locomotionAfterTransition = transitionLocomotion(
    locomotionBeforeTick,
    input,
    {
      isGrounded: movementStateBeforeTick.isGrounded,
      wasGrounded: movementStateBeforeTick.wasGrounded,
      rotationY,
      deltaSeconds,
    },
    DEFAULT_LOCOMOTION_CONFIG,
  );

  applyMovement(
    position,
    rotationY,
    input,
    deltaSeconds,
    locomotionAfterTransition.sprintActive,
  );
  const jumpPhysicsAfterTick = applyJumpPhysics(
    position,
    input,
    deltaSeconds,
    verticalVelocity,
    wasJumpPressed,
    movementStateBeforeTick.isGrounded,
  );
  const resolvedGrounded = isGroundedAt(position);
  const locomotionState = settleLocomotionAfterMove(
    {
      ...locomotionAfterTransition,
      verticalVelocity: jumpPhysicsAfterTick.verticalVelocity,
      wasJumpPressed: jumpPhysicsAfterTick.wasJumpPressed,
    },
    input,
    resolvedGrounded,
  );

  return {
    verticalVelocity: jumpPhysicsAfterTick.verticalVelocity,
    wasJumpPressed: jumpPhysicsAfterTick.wasJumpPressed,
    movementState: movementStateFromLocomotion(
      locomotionState,
      resolvedGrounded,
      movementStateBeforeTick.isGrounded,
      input,
    ),
    locomotionState,
  };
}
