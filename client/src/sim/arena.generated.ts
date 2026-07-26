// GENERATED FILE — edit shared/arena.json and run npm run gen:arena
// Source: shared/arena.json

export const GROUND_Y: number = 0;

export interface ArenaBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const ARENA_BOUNDS: ArenaBounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };

export interface ArenaSpawn {
  position: readonly [number, number, number];
  yaw: number;
}

export const ARENA_SPAWNS: readonly ArenaSpawn[] = [
  { position: [0, 0, -14], yaw: 0 },
  { position: [0, 0, 14], yaw: 3.14159 },
  { position: [-14, 0, 0], yaw: 1.5708 },
  { position: [14, 0, 0], yaw: -1.5708 },
];

export type ColliderShape =
  | { kind: 'box'; halfExtents: readonly [number, number, number]; yaw: number }
  | { kind: 'cylinder'; radius: number; height: number };

export interface ArenaCollider {
  id: string;
  center: readonly [number, number, number];
  shape: ColliderShape;
}

export const ARENA_COLLIDERS: readonly ArenaCollider[] = [
  { id: 'wall_n', center: [0, 0, -20.5], shape: { kind: 'box', halfExtents: [21, 2, 0.5], yaw: 0 } },
  { id: 'wall_s', center: [0, 0, 20.5], shape: { kind: 'box', halfExtents: [21, 2, 0.5], yaw: 0 } },
  { id: 'wall_w', center: [-20.5, 0, 0], shape: { kind: 'box', halfExtents: [0.5, 2, 21], yaw: 0 } },
  { id: 'wall_e', center: [20.5, 0, 0], shape: { kind: 'box', halfExtents: [0.5, 2, 21], yaw: 0 } },
  { id: 'pillar_nw', center: [-10, 0, -10], shape: { kind: 'cylinder', radius: 0.9, height: 6 } },
  { id: 'pillar_ne', center: [10, 0, -10], shape: { kind: 'cylinder', radius: 0.9, height: 6 } },
  { id: 'pillar_sw', center: [-10, 0, 10], shape: { kind: 'cylinder', radius: 0.9, height: 6 } },
  { id: 'pillar_se', center: [10, 0, 10], shape: { kind: 'cylinder', radius: 0.9, height: 6 } },
];

