import {
  ARENA_BOUNDS,
  ARENA_COLLIDERS,
  GROUND_Y,
  type ArenaCollider,
} from './arena.generated';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type PenetrationPushOut = readonly [pushX: number, pushZ: number];

export const PLAYER_COLLISION_RADIUS = Math.fround(0.45);

export interface Ground {
  groundY: number;
  resolveMovement(current: Vec3, desired: Vec3): Vec3;
}

export function createArenaGround(): Ground {
  return {
    groundY: GROUND_Y,
    resolveMovement: resolvePlayerMovement,
  };
}

export function resolvePlayerMovement(current: Vec3, desired: Vec3): Vec3 {
  void current;
  const clamped = clampToArenaBounds(desired);
  const resolved = resolveAgainstColliders(clamped, ARENA_COLLIDERS);
  return clampToArenaBounds(resolved);
}

export function clampToArenaBounds(position: Vec3): Vec3 {
  const minX = Math.fround(ARENA_BOUNDS.minX + PLAYER_COLLISION_RADIUS);
  const maxX = Math.fround(ARENA_BOUNDS.maxX - PLAYER_COLLISION_RADIUS);
  const minZ = Math.fround(ARENA_BOUNDS.minZ + PLAYER_COLLISION_RADIUS);
  const maxZ = Math.fround(ARENA_BOUNDS.maxZ - PLAYER_COLLISION_RADIUS);

  return {
    x: Math.fround(Math.min(maxX, Math.max(minX, position.x))),
    y: position.y,
    z: Math.fround(Math.min(maxZ, Math.max(minZ, position.z))),
  };
}

export function resolveAgainstColliders(
  position: Vec3,
  colliders: readonly ArenaCollider[],
): Vec3 {
  const resolved: Vec3 = { ...position };

  for (let pass = 0; pass < 2; pass += 1) {
    let moved = false;
    for (const collider of colliders) {
      const push = penetrationPushOut(resolved, collider);
      if (push !== null) {
        resolved.x = Math.fround(resolved.x + push[0]);
        resolved.z = Math.fround(resolved.z + push[1]);
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }

  return resolved;
}

export function penetrationPushOut(
  position: Vec3,
  collider: ArenaCollider,
): PenetrationPushOut | null {
  const dx = Math.fround(position.x - collider.center[0]);
  const dz = Math.fround(position.z - collider.center[2]);

  if (collider.shape.kind === 'cylinder') {
    const combinedRadius = Math.fround(collider.shape.radius + PLAYER_COLLISION_RADIUS);
    const dxSquared = Math.fround(dx * dx);
    const dzSquared = Math.fround(dz * dz);
    const distanceSquared = Math.fround(dxSquared + dzSquared);
    const distance = Math.fround(Math.sqrt(distanceSquared));
    if (distance >= combinedRadius) {
      return null;
    }
    if (distance <= Number.EPSILON) {
      return [combinedRadius, 0];
    }

    const penetration = Math.fround(combinedRadius - distance);
    const pushX = Math.fround(Math.fround(dx / distance) * penetration);
    const pushZ = Math.fround(Math.fround(dz / distance) * penetration);
    return [pushX, pushZ];
  }

  const inverseYaw = Math.fround(-collider.shape.yaw);
  const inverseCos = Math.fround(Math.cos(inverseYaw));
  const inverseSin = Math.fround(Math.sin(inverseYaw));
  const localX = Math.fround(
    Math.fround(dx * inverseCos) - Math.fround(dz * inverseSin),
  );
  const localZ = Math.fround(
    Math.fround(dx * inverseSin) + Math.fround(dz * inverseCos),
  );
  const overlapX = Math.fround(
    Math.fround(collider.shape.halfExtents[0] + PLAYER_COLLISION_RADIUS)
      - Math.fround(Math.abs(localX)),
  );
  const overlapZ = Math.fround(
    Math.fround(collider.shape.halfExtents[2] + PLAYER_COLLISION_RADIUS)
      - Math.fround(Math.abs(localZ)),
  );
  if (overlapX <= 0 || overlapZ <= 0) {
    return null;
  }

  let localPushX: number;
  let localPushZ: number;
  if (overlapX <= overlapZ) {
    localPushX = Math.fround(awayFromCenterSign(localX) * overlapX);
    localPushZ = 0;
  } else {
    localPushX = 0;
    localPushZ = Math.fround(awayFromCenterSign(localZ) * overlapZ);
  }

  const yaw = Math.fround(collider.shape.yaw);
  const cosYaw = Math.fround(Math.cos(yaw));
  const sinYaw = Math.fround(Math.sin(yaw));
  const worldPushX = Math.fround(
    Math.fround(localPushX * cosYaw) - Math.fround(localPushZ * sinYaw),
  );
  const worldPushZ = Math.fround(
    Math.fround(localPushX * sinYaw) + Math.fround(localPushZ * cosYaw),
  );
  return [worldPushX, worldPushZ];
}

function awayFromCenterSign(value: number): number {
  return value < 0 ? -1 : 1;
}
