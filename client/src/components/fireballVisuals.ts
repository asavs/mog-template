import * as THREE from 'three';

export const FIREBALL_VISUAL_SPAWN_FORWARD_OFFSET = 1.2;
export const FIREBALL_VISUAL_SPAWN_RIGHT_OFFSET = 0.42;
export const FIREBALL_VISUAL_SPAWN_HEIGHT = 1.45;
export const FIREBALL_VISUAL_SPAWN_MAX_DISTANCE_TRAVELED = 0.75;
export const FIREBALL_VISUAL_HANDOFF_MS = 110;
export const FIREBALL_VISUAL_PENDING_TTL_MS = 1200;
export const FIREBALL_VISUAL_TARGET_DISTANCE = 28;

export type PendingFireballCosmeticCast = {
  id: string;
  casterKey: string;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  spawnDirection: THREE.Vector3;
  currentPosition: THREE.Vector3;
  startedAt: number;
  claimedByProjectileId?: string;
};

let nextPendingFireballCastId = 0;

export function normalizedFireballDirection(direction: THREE.Vector3, fallbackRotationY = 0) {
  const normalized = new THREE.Vector3(direction.x, 0, direction.z);
  if (normalized.lengthSq() <= 0.0001) {
    normalized.set(
      -Math.sin(fallbackRotationY),
      0,
      -Math.cos(fallbackRotationY),
    );
  } else {
    normalized.normalize();
  }
  return normalized;
}

export function fireballVisualSpawnOriginFromCaster(
  casterPosition: THREE.Vector3,
  direction: THREE.Vector3,
) {
  const fireballDirection = normalizedFireballDirection(direction);
  const right = new THREE.Vector3(-fireballDirection.z, 0, fireballDirection.x);

  return casterPosition.clone()
    .addScaledVector(fireballDirection, FIREBALL_VISUAL_SPAWN_FORWARD_OFFSET)
    .addScaledVector(right, FIREBALL_VISUAL_SPAWN_RIGHT_OFFSET)
    .add(new THREE.Vector3(0, FIREBALL_VISUAL_SPAWN_HEIGHT, 0));
}

export function createPendingFireballCosmeticCast({
  casterKey,
  direction,
  origin,
  spawnDirection,
  startedAt = performance.now(),
}: {
  casterKey: string;
  direction: THREE.Vector3;
  origin: THREE.Vector3;
  spawnDirection?: THREE.Vector3;
  startedAt?: number;
}): PendingFireballCosmeticCast {
  nextPendingFireballCastId += 1;
  const normalizedDirection = normalizedFireballDirection(direction);
  const normalizedSpawnDirection = normalizedFireballDirection(spawnDirection ?? direction);
  return {
    id: `local-fireball-${nextPendingFireballCastId}`,
    casterKey,
    origin: origin.clone(),
    direction: normalizedDirection,
    spawnDirection: normalizedSpawnDirection,
    currentPosition: origin.clone(),
    startedAt,
  };
}

export function updatePendingFireballVisualOrigin(
  cast: PendingFireballCosmeticCast,
  casterPosition: THREE.Vector3,
) {
  cast.origin.copy(fireballVisualSpawnOriginFromCaster(casterPosition, cast.spawnDirection));
  cast.currentPosition.copy(cast.origin);
  return cast.currentPosition;
}

export function fireballVisualDirectionFromSpawn(
  casterPosition: THREE.Vector3,
  aimDirection: THREE.Vector3,
) {
  const forward = normalizedFireballDirection(aimDirection);
  const origin = fireballVisualSpawnOriginFromCaster(casterPosition, forward);
  const target = casterPosition.clone().addScaledVector(forward, FIREBALL_VISUAL_TARGET_DISTANCE);
  return normalizedFireballDirection(new THREE.Vector3(
    target.x - origin.x,
    0,
    target.z - origin.z,
  ));
}

export function fireballVisualPositionFromClaim(
  startPosition: THREE.Vector3,
  direction: THREE.Vector3,
  distanceTraveled: number,
) {
  return startPosition.clone()
    .addScaledVector(normalizedFireballDirection(direction), Math.max(0, distanceTraveled));
}

export function canProjectileClaimPendingFireball(distanceTraveled: number) {
  return distanceTraveled <= FIREBALL_VISUAL_SPAWN_MAX_DISTANCE_TRAVELED;
}
