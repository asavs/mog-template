import * as THREE from 'three';
import type { InputState, MovementState } from './generated/types';
import {
  collisionDebugEnabled,
  collisionInputDebug,
  collisionNumberDebug,
  collisionVectorDebug,
  logCollisionDebug,
} from './collisionDebug';
import {
  CASTLE_CAPSULE_SKIN,
  CASTLE_GROUND_SNAP_DISTANCE,
  castleGroundSupport,
  resolveCastleCapsuleSweep,
} from './castleController';
import { castleCollisionAsset, isCastleCollisionReady } from './castleCollision';
import { isTerrainWalkableAt, terrainHeightAt } from './heightmap';
import {
  getRapierCastleGroundSupport,
  resolveRapierCastleMovement,
} from './rapierCastleBridge';
import { recordCastleCollisionQuery } from './collisionPerf';
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
const CASTLE_SUPPORT_PROBE_LIFT = CASTLE_CAPSULE_SKIN * 2;

type CastleGroundSupportDetails = {
  position: THREE.Vector3 | null;
  source: 'rapier' | 'custom' | 'none';
};

let lastCastleSupportQuery: {
  x: number;
  y: number;
  z: number;
  maxDistance: number;
  result: CastleGroundSupportDetails;
} | null = null;

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
  const currentCastleGround = activeCastleGroundSupportDetailed(
    position,
    CASTLE_GROUND_SNAP_DISTANCE,
  );
  const currentGround = currentCastleGround.position?.y ?? terrainHeightAt(position);
  const startedOnCastle = currentCastleGround.position !== null;
  const wasGrounded = position.y <= currentGround + GROUNDED_EPSILON;
  const resolved = resolvePlayerMovement(position, desired);
  if (wasGrounded) {
    const resolvedCastleGround = activeCastleGroundSupportDetailed(
      resolved,
      CASTLE_GROUND_SNAP_DISTANCE,
    );
    const resolvedGround = resolvedCastleGround.position?.y ?? terrainHeightAt(resolved);
    if (resolvedCastleGround.position) {
      resolved.y = resolvedGround;
    } else if (!startedOnCastle && currentGround - resolvedGround <= MAX_SNAP_DOWN_HEIGHT) {
      resolved.y = resolvedGround;
    }
  }
  position.copy(resolved);
}

export function resolvePlayerMovement(current: THREE.Vector3, desired: THREE.Vector3): THREE.Vector3 {
  const clampedDesired = clampToWorld(desired);
  const mayTouchCastle = castleMovementMayTouch(current, clampedDesired)
    || castleSupportProbeMayTouch(current, CASTLE_GROUND_SNAP_DISTANCE);
  if (mayTouchCastle
    && (activeCastleGroundSupport(current, CASTLE_GROUND_SNAP_DISTANCE)
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

function castleAabbMayTouch(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  if (!isCastleCollisionReady()) return false;
  const asset = castleCollisionAsset();
  return maxX >= asset.min[0] - CASTLE_CAPSULE_SKIN
    && minX <= asset.max[0] + CASTLE_CAPSULE_SKIN
    && maxY >= asset.min[1] - CASTLE_CAPSULE_SKIN
    && minY <= asset.max[1] + CASTLE_CAPSULE_SKIN
    && maxZ >= asset.min[2] - CASTLE_CAPSULE_SKIN
    && minZ <= asset.max[2] + CASTLE_CAPSULE_SKIN;
}

function castleMovementMayTouch(current: THREE.Vector3, desired: THREE.Vector3): boolean {
  const radius = PLAYER_COLLISION_RADIUS + CASTLE_CAPSULE_SKIN;
  return castleAabbMayTouch(
    Math.min(current.x, desired.x) - radius,
    Math.min(current.y, desired.y) - CASTLE_CAPSULE_SKIN,
    Math.min(current.z, desired.z) - radius,
    Math.max(current.x, desired.x) + radius,
    Math.max(current.y, desired.y) + PLAYER_CAPSULE_HEIGHT + CASTLE_CAPSULE_SKIN,
    Math.max(current.z, desired.z) + radius,
  );
}

function castleSupportProbeMayTouch(position: THREE.Vector3, maxDistance: number): boolean {
  const radius = PLAYER_COLLISION_RADIUS + CASTLE_CAPSULE_SKIN;
  return castleAabbMayTouch(
    position.x - radius,
    position.y - maxDistance - CASTLE_CAPSULE_SKIN,
    position.z - radius,
    position.x + radius,
    position.y + CASTLE_SUPPORT_PROBE_LIFT + PLAYER_CAPSULE_HEIGHT + CASTLE_CAPSULE_SKIN,
    position.z + radius,
  );
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
  const support = activeCastleGroundSupport(position, CASTLE_GROUND_SNAP_DISTANCE);
  return support ? support.y : terrain;
}

function activeCastleGroundSupport(position: THREE.Vector3, maxDistance: number): THREE.Vector3 | null {
  return activeCastleGroundSupportDetailed(position, maxDistance).position;
}

function activeCastleGroundSupportDetailed(position: THREE.Vector3, maxDistance: number): CastleGroundSupportDetails {
  const cached = readCastleSupportCache(position, maxDistance);
  if (cached) return cached;
  if (!isCastleCollisionReady()) {
    return writeCastleSupportCache(position, maxDistance, { position: null, source: 'none' });
  }
  if (!castleSupportProbeMayTouch(position, maxDistance)) {
    return writeCastleSupportCache(position, maxDistance, { position: null, source: 'none' });
  }

  const supportStartedAt = performance.now();
  const rapierSupport = getRapierCastleGroundSupport(
    position,
    maxDistance,
    PLAYER_COLLISION_RADIUS,
    PLAYER_CAPSULE_HEIGHT,
  );
  recordCastleCollisionQuery(performance.now() - supportStartedAt);
  if (rapierSupport) {
    return writeCastleSupportCache(position, maxDistance, { position: rapierSupport, source: 'rapier' });
  }

  const customStartedAt = performance.now();
  const customSupport = castleGroundSupport(
    position,
    maxDistance,
    PLAYER_COLLISION_RADIUS,
    PLAYER_CAPSULE_HEIGHT,
  );
  recordCastleCollisionQuery(performance.now() - customStartedAt);
  return writeCastleSupportCache(position, maxDistance, customSupport
    ? { position: customSupport, source: 'custom' }
    : { position: null, source: 'none' });
}

function readCastleSupportCache(position: THREE.Vector3, maxDistance: number): CastleGroundSupportDetails | null {
  if (!lastCastleSupportQuery
    || lastCastleSupportQuery.x !== position.x
    || lastCastleSupportQuery.y !== position.y
    || lastCastleSupportQuery.z !== position.z
    || lastCastleSupportQuery.maxDistance !== maxDistance) {
    return null;
  }
  return cloneCastleSupportDetails(lastCastleSupportQuery.result);
}

function writeCastleSupportCache(
  position: THREE.Vector3,
  maxDistance: number,
  result: CastleGroundSupportDetails,
): CastleGroundSupportDetails {
  lastCastleSupportQuery = {
    x: position.x,
    y: position.y,
    z: position.z,
    maxDistance,
    result: cloneCastleSupportDetails(result),
  };
  return cloneCastleSupportDetails(result);
}

function cloneCastleSupportDetails(result: CastleGroundSupportDetails): CastleGroundSupportDetails {
  return {
    position: result.position?.clone() ?? null,
    source: result.source,
  };
}

function movementDistance(from: THREE.Vector3, to: THREE.Vector3): number {
  return from.distanceTo(to);
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
  const shouldTraceCollision = collisionDebugEnabled();
  const verticalVelocityBeforeTick = verticalVelocity;
  applyMovement(
    position,
    rotationY,
    input,
    deltaSeconds,
    locomotionAfterTransition.sprintActive,
  );
  const afterHorizontalMovement = shouldTraceCollision ? position.clone() : null;
  const jumpPhysicsAfterTick = applyJumpPhysics(
    position,
    input,
    deltaSeconds,
    verticalVelocity,
    wasJumpPressed,
    movementStateBeforeTick.isGrounded,
  );
  const afterJumpPhysics = shouldTraceCollision ? position.clone() : null;
  // Locomotion above deliberately remains unchanged. This is only the final
  // full-XYZ reachability pass, so upward jumps and falls cannot bypass castle
  // ceilings, undersides, or ramps after horizontal prediction has run.
  let resolvedVerticalVelocity = jumpPhysicsAfterTick.verticalVelocity;
  if (castleMovementMayTouch(fullTickStart, position)
    || castleSupportProbeMayTouch(fullTickStart, CASTLE_GROUND_SNAP_DISTANCE)
    || castleSupportProbeMayTouch(position, CASTLE_GROUND_SNAP_DISTANCE)) {
    const wasGrounded = movementStateBeforeTick.isGrounded;
    const isStartingJump = input.jump && !wasJumpPressed && wasGrounded;
    const startingCastleSupport = activeCastleGroundSupportDetailed(
      fullTickStart,
      CASTLE_GROUND_SNAP_DISTANCE,
    );
    const sweepTarget = position.clone();
    if (wasGrounded && !isStartingJump) {
      const endingTerrainY = terrainHeightAt(sweepTarget);
      const endingCastleGround = activeCastleGroundSupportDetailed(
        sweepTarget,
        CASTLE_GROUND_SNAP_DISTANCE,
      );
      const endingGroundY = endingCastleGround.position ? endingCastleGround.position.y : endingTerrainY;
      sweepTarget.y = Math.max(fullTickStart.y, endingGroundY);
    }
    const desiredBeforeCastle = sweepTarget.clone();
    const shouldSweepCastle = castleMovementMayTouch(fullTickStart, sweepTarget);
    let rapierCollision = null;
    if (shouldSweepCastle) {
      const sweepStartedAt = performance.now();
      rapierCollision = resolveRapierCastleMovement(
        fullTickStart,
        sweepTarget,
        PLAYER_COLLISION_RADIUS,
        PLAYER_CAPSULE_HEIGHT,
      );
      recordCastleCollisionQuery(performance.now() - sweepStartedAt);
    }
    const collisionSolver = rapierCollision ? 'rapier' : (shouldSweepCastle ? 'custom' : 'none');
    let collision = rapierCollision;
    if (!collision && shouldSweepCastle) {
      const customSweepStartedAt = performance.now();
      collision = resolveCastleCapsuleSweep(
        fullTickStart,
        sweepTarget,
        PLAYER_COLLISION_RADIUS,
        PLAYER_CAPSULE_HEIGHT,
      );
      recordCastleCollisionQuery(performance.now() - customSweepStartedAt);
    }
    collision ??= { position: sweepTarget.clone(), groundNormal: null, hitCeiling: false, hitWall: false };
    const collisionResolvedPosition = shouldTraceCollision ? collision.position.clone() : null;
    position.copy(collision.position);
    if ((collision.hitCeiling && resolvedVerticalVelocity > 0)
      || (collision.groundNormal && resolvedVerticalVelocity < 0)) {
      resolvedVerticalVelocity = 0;
    }
    const terrainGroundY = terrainHeightAt(fullTickStart);
    const startedOnCastle = startingCastleSupport.position !== null;
    const terrainResolvedGroundY = terrainHeightAt(position);
    const castleResolvedGround = activeCastleGroundSupportDetailed(
      position,
      CASTLE_GROUND_SNAP_DISTANCE,
    );
    const resolvedGroundY = castleResolvedGround.position ? castleResolvedGround.position.y : terrainResolvedGroundY;
    if (wasGrounded && isStartingJump) {
      if (!startedOnCastle && terrainGroundY - terrainResolvedGroundY <= MAX_SNAP_DOWN_HEIGHT) {
        position.y = terrainResolvedGroundY + resolvedVerticalVelocity * deltaSeconds;
      }
    } else if (wasGrounded) {
      if (castleResolvedGround.position) {
        if (resolvedVerticalVelocity <= 0 && desiredBeforeCastle.y <= fullTickStart.y) {
          position.y = castleResolvedGround.position.y;
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
    if (shouldTraceCollision && collisionResolvedPosition && afterHorizontalMovement && afterJumpPhysics) {
      const finalGroundY = groundHeightAt(position);
      const desiredDistance = movementDistance(fullTickStart, desiredBeforeCastle);
      const resolvedDistance = movementDistance(fullTickStart, position);
      logCollisionDebug({
        at: performance.now(),
        phase: 'movement:castle-sweep',
        input: collisionInputDebug(input),
        current: collisionVectorDebug(fullTickStart),
        desired: collisionVectorDebug(desiredBeforeCastle),
        position: collisionVectorDebug(position),
        resolved: collisionVectorDebug(collisionResolvedPosition),
        movementDelta: collisionVectorDebug(position.clone().sub(fullTickStart)),
        groundNormal: collision.groundNormal ? collisionVectorDebug(collision.groundNormal) : null,
        movementState: movementStateBeforeTick,
        terrainY: collisionNumberDebug(terrainGroundY),
        groundY: collisionNumberDebug(finalGroundY),
        castleSupportY: collisionNumberDebug(castleResolvedGround.position?.y),
        castleSupportSource: castleResolvedGround.source,
        collisionSolver,
        collisionMoved: collisionNumberDebug(movementDistance(fullTickStart, collisionResolvedPosition)),
        desiredDistance: collisionNumberDebug(desiredDistance),
        resolvedDistance: collisionNumberDebug(resolvedDistance),
        blockedDistance: collisionNumberDebug(desiredDistance - resolvedDistance),
        verticalVelocityBefore: collisionNumberDebug(verticalVelocityBeforeTick),
        verticalVelocityAfter: collisionNumberDebug(resolvedVerticalVelocity),
        jumpWasPressedBefore: wasJumpPressed,
        jumpWasPressedAfter: jumpPhysicsAfterTick.wasJumpPressed,
        wasGrounded,
        isStartingJump,
        hitCeiling: collision.hitCeiling,
        hitWall: collision.hitWall,
        grounded: position.y <= finalGroundY + GROUNDED_EPSILON,
        note: `afterHorizontal=${JSON.stringify(collisionVectorDebug(afterHorizontalMovement))}; afterJump=${JSON.stringify(collisionVectorDebug(afterJumpPhysics))}; startCastleSupport=${startingCastleSupport.source}:${collisionNumberDebug(startingCastleSupport.position?.y)}`,
      });
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
