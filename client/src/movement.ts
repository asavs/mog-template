import * as THREE from 'three';
import type { InputState, MovementState } from './generated/types';
import {
  CASTLE_GROUND_SNAP_DISTANCE,
  castleGroundSupport,
  resolveCastleCapsuleSweep,
} from './castleController';
import { castleCollisionAsset, isCastleCollisionReady } from './castleCollision';
import { isTerrainWalkableAt, terrainHeightAt } from './heightmap';
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
export const PLAYER_CAPSULE_HEIGHT = 1.8;
export const MAX_WALKABLE_SLOPE_DEGREES = 70;
export const MAX_STEP_HEIGHT = 1.25;
export const MAX_SNAP_DOWN_HEIGHT = 6.0;

const WORLD_MIN_X = -1574.03;
const WORLD_MAX_X = 1574.03;
const WORLD_MIN_Z = -1231.44;
const WORLD_MAX_Z = 1231.44;
const MAX_WALKABLE_SLOPE = Math.tan(THREE.MathUtils.degToRad(MAX_WALKABLE_SLOPE_DEGREES));
const SLOPE_SAMPLE_DISTANCE = 1.0;

export function isMoving(input: InputState): boolean {
  return isMovingInput(input);
}

export function isGroundedAt(position: THREE.Vector3): boolean {
  return position.y <= groundHeightAt(position) + GROUNDED_EPSILON;
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
  const currentGround = groundHeightAt(position);
  const wasGrounded = position.y <= currentGround + GROUNDED_EPSILON;
  const resolved = resolvePlayerMovement(position, desired);
  if (wasGrounded) {
    const resolvedGround = groundHeightAt(resolved);
    if (currentGround - resolvedGround <= MAX_SNAP_DOWN_HEIGHT) {
      resolved.y = resolvedGround;
    }
  }
  position.copy(resolved);
}

export function resolvePlayerMovement(current: THREE.Vector3, desired: THREE.Vector3): THREE.Vector3 {
  const clampedDesired = clampToWorld(desired);
  if (isCastleCollisionReady()
    && (castleGroundSupport(current, CASTLE_GROUND_SNAP_DISTANCE, PLAYER_COLLISION_RADIUS, PLAYER_CAPSULE_HEIGHT)
      || isInsideCastleCollisionBounds(current)
      || isInsideCastleCollisionBounds(clampedDesired))) {
    return clampedDesired;
  }
  let terrainResolved: THREE.Vector3;
  if (canMoveTo(current, clampedDesired)) {
    terrainResolved = clampedDesired;
  } else {
    const xOnly = clampToWorld(new THREE.Vector3(clampedDesired.x, clampedDesired.y, current.z));
    if (canMoveTo(current, xOnly)) terrainResolved = xOnly;
    else {
      const zOnly = clampToWorld(new THREE.Vector3(current.x, clampedDesired.y, clampedDesired.z));
      terrainResolved = canMoveTo(current, zOnly)
        ? zOnly
        : clampToWorld(new THREE.Vector3(current.x, clampedDesired.y, current.z));
    }
  }
  // Castle collision is resolved once, at the end of simulateMovementTick,
  // after jump/gravity have produced the complete desired XYZ displacement.
  // Resolving it here as well would make prediction sweep a horizontal path
  // and then a second, different combined path.
  return terrainResolved;
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

function canMoveTo(current: THREE.Vector3, desired: THREE.Vector3): boolean {
  return isTerrainStepWalkable(current, desired);
}

function isInsideCastleCollisionBounds(position: THREE.Vector3): boolean {
  if (!isCastleCollisionReady()) return false;
  const asset = castleCollisionAsset();
  return position.x >= asset.min[0] - PLAYER_COLLISION_RADIUS
    && position.x <= asset.max[0] + PLAYER_COLLISION_RADIUS
    && position.z >= asset.min[2] - PLAYER_COLLISION_RADIUS
    && position.z <= asset.max[2] + PLAYER_COLLISION_RADIUS;
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

export function applyJumpPhysics(
  position: THREE.Vector3,
  input: InputState,
  deltaSeconds: number,
  verticalVelocity: number,
  wasJumpPressed: boolean,
  wasGrounded = isGroundedAt(position),
): { verticalVelocity: number; wasJumpPressed: boolean } {
  const groundY = groundHeightAt(position);

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

export function groundHeightAt(position: THREE.Vector3): number {
  const terrain = terrainHeightAt(position);
  if (!isCastleCollisionReady()) return terrain;
  const support = castleGroundSupport(position, CASTLE_GROUND_SNAP_DISTANCE, PLAYER_COLLISION_RADIUS, PLAYER_CAPSULE_HEIGHT);
  return support ? support.y : terrain;
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

  const fullTickStart = position.clone();
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
  // Locomotion above deliberately remains unchanged. This is only the final
  // full-XYZ reachability pass, so upward jumps and falls cannot bypass castle
  // ceilings, undersides, or ramps after horizontal prediction has run.
  let resolvedVerticalVelocity = jumpPhysicsAfterTick.verticalVelocity;
  if (isCastleCollisionReady()) {
    const wasGrounded = movementStateBeforeTick.isGrounded;
    const isStartingJump = input.jump && !wasJumpPressed && wasGrounded;
    const sweepTarget = position.clone();
    if (wasGrounded && !isStartingJump) {
      const endingTerrainY = terrainHeightAt(sweepTarget);
      const endingCastleGround = castleGroundSupport(
        sweepTarget,
        CASTLE_GROUND_SNAP_DISTANCE,
        PLAYER_COLLISION_RADIUS,
        PLAYER_CAPSULE_HEIGHT,
      );
      const endingGroundY = endingCastleGround ? endingCastleGround.y : endingTerrainY;
      sweepTarget.y = Math.max(fullTickStart.y, endingGroundY);
    }
    const desiredBeforeCastle = sweepTarget.clone();
    const collision = resolveCastleCapsuleSweep(
      fullTickStart,
      sweepTarget,
      PLAYER_COLLISION_RADIUS,
      PLAYER_CAPSULE_HEIGHT,
    );
    position.copy(collision.position);
    if ((collision.hitCeiling && resolvedVerticalVelocity > 0)
      || (collision.groundNormal && resolvedVerticalVelocity < 0)) {
      resolvedVerticalVelocity = 0;
    }
    const terrainGroundY = terrainHeightAt(fullTickStart);
    const startedOnCastle = castleGroundSupport(
      fullTickStart,
      CASTLE_GROUND_SNAP_DISTANCE,
      PLAYER_COLLISION_RADIUS,
      PLAYER_CAPSULE_HEIGHT,
    ) !== null;
    const terrainResolvedGroundY = terrainHeightAt(position);
    const castleResolvedGround = castleGroundSupport(
      position,
      CASTLE_GROUND_SNAP_DISTANCE,
      PLAYER_COLLISION_RADIUS,
      PLAYER_CAPSULE_HEIGHT,
    );
    const resolvedGroundY = castleResolvedGround ? castleResolvedGround.y : terrainResolvedGroundY;
    if (wasGrounded && isStartingJump) {
      if (!startedOnCastle && terrainGroundY - terrainResolvedGroundY <= MAX_SNAP_DOWN_HEIGHT) {
        position.y = terrainResolvedGroundY + resolvedVerticalVelocity * deltaSeconds;
      }
    } else if (wasGrounded) {
      if (castleResolvedGround) {
        if (resolvedVerticalVelocity <= 0 && desiredBeforeCastle.y <= fullTickStart.y) {
          position.y = castleResolvedGround.y;
          resolvedVerticalVelocity = 0;
        }
      } else if (!startedOnCastle && terrainGroundY - terrainResolvedGroundY <= MAX_SNAP_DOWN_HEIGHT) {
        position.y = terrainResolvedGroundY;
        resolvedVerticalVelocity = 0;
      }
    } else if (position.y <= resolvedGroundY) {
      position.y = resolvedGroundY;
      resolvedVerticalVelocity = 0;
    }
  }
  const resolvedGrounded = isGroundedAt(position);
  const locomotionState = settleLocomotionAfterMove(
    {
      ...locomotionAfterTransition,
      verticalVelocity: resolvedVerticalVelocity,
      wasJumpPressed: jumpPhysicsAfterTick.wasJumpPressed,
    },
    input,
    resolvedGrounded,
  );

  return {
    verticalVelocity: resolvedVerticalVelocity,
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
