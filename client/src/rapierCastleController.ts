import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
import type { CharacterCollision, Collider, KinematicCharacterController, World } from '@dimforge/rapier3d-deterministic-compat';
import {
  CASTLE_CAPSULE_SKIN,
  CASTLE_GROUND_SNAP_DISTANCE,
  CASTLE_MIN_WALKABLE_NORMAL_Y,
  type CastleMoveResult,
} from './castleController';
import { castleCollisionAsset, isCastleCollisionReady } from './castleCollision';
import { setRapierCastleResolver } from './rapierCastleBridge';

let rapierWorld: World | null = null;
let characterCollider: Collider | null = null;
let characterController: KinematicCharacterController | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Builds the Rapier castle scene from the same canonical baked triangle asset
 * used by the existing controller. This is deliberately isolated until the
 * authoritative Rust Rapier path is proven by CI.
 */
export function initRapierCastleController(): Promise<void> {
  if (rapierWorld) return Promise.resolve();
  if (!initPromise) {
    initPromise = (async () => {
      if (!isCastleCollisionReady()) {
        throw new Error('Castle collision must be loaded before Rapier castle initialization');
      }
      await RAPIER.init();

      const asset = castleCollisionAsset();
      const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
      const triMeshFlags = RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES
        | RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES
        | RAPIER.TriMeshFlags.DELETE_DUPLICATE_TRIANGLES;
      world.createCollider(
        RAPIER.ColliderDesc.trimesh(asset.vertices.slice(), asset.indices.slice(), triMeshFlags),
      );
      characterCollider = world.createCollider(RAPIER.ColliderDesc.capsule(0.5, 0.5));
      characterController = world.createCharacterController(CASTLE_CAPSULE_SKIN);
      characterController.setUp({ x: 0, y: 1, z: 0 });
      characterController.setSlideEnabled(true);
      characterController.setMaxSlopeClimbAngle(Math.acos(CASTLE_MIN_WALKABLE_NORMAL_Y));
      characterController.setMinSlopeSlideAngle(Math.acos(CASTLE_MIN_WALKABLE_NORMAL_Y));
      characterController.enableSnapToGround(CASTLE_GROUND_SNAP_DISTANCE);
      characterController.setNormalNudgeFactor(CASTLE_CAPSULE_SKIN);
      rapierWorld = world;
      setRapierCastleResolver(resolveRapierCastleCapsuleMovement, rapierCastleGroundSupport);
    })().catch(error => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

export function isRapierCastleReady(): boolean {
  return rapierWorld !== null && characterCollider !== null && characterController !== null;
}

export function resolveRapierCastleCapsuleMovement(
  current: THREE.Vector3,
  desired: THREE.Vector3,
  radius: number,
  height: number,
): CastleMoveResult {
  if (!isRapierCastleReady() || !characterCollider || !characterController) {
    return { position: desired.clone(), groundNormal: null, hitCeiling: false, hitWall: false };
  }

  const halfHeight = capsuleSegmentHalfHeight(radius, height);
  characterCollider.setShape(new RAPIER.Capsule(halfHeight, radius));
  characterCollider.setTranslation({ x: current.x, y: current.y + height * 0.5, z: current.z });

  const desiredDelta = {
    x: desired.x - current.x,
    y: desired.y - current.y,
    z: desired.z - current.z,
  };
  characterController.computeColliderMovement(
    characterCollider,
    desiredDelta,
    undefined,
    undefined,
    collider => collider.handle !== characterCollider?.handle,
  );

  const movement = characterController.computedMovement();
  const position = new THREE.Vector3(
    current.x + movement.x,
    current.y + movement.y,
    current.z + movement.z,
  );
  let groundNormal: THREE.Vector3 | null = characterController.computedGrounded()
    ? new THREE.Vector3(0, 1, 0)
    : null;
  let hitCeiling = false;
  let hitWall = false;

  for (let index = 0; index < characterController.numComputedCollisions(); index += 1) {
    const collision = characterController.computedCollision(index);
    if (!collision) continue;
    const normal = collisionNormal(collision);
    if (!normal) continue;
    if (normal.y >= CASTLE_MIN_WALKABLE_NORMAL_Y && desiredDelta.y <= 0) groundNormal = normal;
    if (normal.y < -CASTLE_CAPSULE_SKIN && desiredDelta.y > 0) hitCeiling = true;
    if (Math.abs(normal.y) < CASTLE_MIN_WALKABLE_NORMAL_Y) hitWall = true;
  }

  return { position, groundNormal, hitCeiling, hitWall };
}

export function rapierCastleGroundSupport(
  position: THREE.Vector3,
  maxDistance: number,
  radius: number,
  height: number,
): THREE.Vector3 | null {
  const probeLift = CASTLE_CAPSULE_SKIN * 2;
  const probeStart = new THREE.Vector3(position.x, position.y + probeLift, position.z);
  const result = resolveRapierCastleCapsuleMovement(
    probeStart,
    new THREE.Vector3(position.x, position.y - maxDistance, position.z),
    radius,
    height,
  );
  const movedSideways = Math.hypot(result.position.x - position.x, result.position.z - position.z) > CASTLE_CAPSULE_SKIN;
  const movedAboveProbe = result.position.y - position.y > probeLift + CASTLE_CAPSULE_SKIN;
  const movedBelowSnap = position.y - result.position.y > maxDistance + CASTLE_CAPSULE_SKIN;
  return !movedSideways && result.groundNormal && result.groundNormal.y >= CASTLE_MIN_WALKABLE_NORMAL_Y
    && !movedAboveProbe
    && !movedBelowSnap
    ? result.position
    : null;
}

function capsuleSegmentHalfHeight(radius: number, height: number): number {
  return Math.max(0, (height - radius * 2) * 0.5);
}

function collisionNormal(collision: CharacterCollision): THREE.Vector3 | null {
  const normal = new THREE.Vector3(collision.normal1.x, collision.normal1.y, collision.normal1.z);
  return Number.isFinite(normal.x) && Number.isFinite(normal.y) && Number.isFinite(normal.z)
    ? normal.normalize()
    : null;
}
