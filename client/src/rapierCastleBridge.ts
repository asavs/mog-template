import type * as THREE from 'three';
import type { CastleMoveResult } from './castleController';

type ResolveRapierCastleCapsuleMovement = (
  current: THREE.Vector3,
  desired: THREE.Vector3,
  radius: number,
  height: number,
) => CastleMoveResult;

type RapierCastleGroundSupport = (
  position: THREE.Vector3,
  maxDistance: number,
  radius: number,
  height: number,
) => THREE.Vector3 | null;

let resolveRapierCastleCapsuleMovement: ResolveRapierCastleCapsuleMovement | null = null;
let rapierCastleGroundSupport: RapierCastleGroundSupport | null = null;

export function setRapierCastleResolver(
  resolver: ResolveRapierCastleCapsuleMovement,
  groundSupport: RapierCastleGroundSupport,
): void {
  resolveRapierCastleCapsuleMovement = resolver;
  rapierCastleGroundSupport = groundSupport;
}

export function isRapierCastleResolverReady(): boolean {
  return resolveRapierCastleCapsuleMovement !== null && rapierCastleGroundSupport !== null;
}

export function resolveRapierCastleMovement(
  current: THREE.Vector3,
  desired: THREE.Vector3,
  radius: number,
  height: number,
): CastleMoveResult | null {
  return resolveRapierCastleCapsuleMovement?.(current, desired, radius, height) ?? null;
}

export function getRapierCastleGroundSupport(
  position: THREE.Vector3,
  maxDistance: number,
  radius: number,
  height: number,
): THREE.Vector3 | null {
  return rapierCastleGroundSupport?.(position, maxDistance, radius, height) ?? null;
}
