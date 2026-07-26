/**
 * Arena world root — architecture, horizon ground, static light rig, dressing.
 *
 * Architecture is built once. Lights are a fixed JSX set (never added/removed
 * at runtime — changing light count relinks every shader). Dressing resolves
 * through the content seam the same way stage Scenery does.
 */

import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { resolveProp } from '../content';
import { buildArena } from './arenaArchitecture';
import { ARENA_DRESSING, type WorldPlacement } from './dressing';

/** Warm ember colour for brazier / fire-bowl point lights. */
const EMBER_COLOR = 0xff8c3a;
/**
 * Candela-scale intensity for three r184 physically-based point lights.
 * First pass (120/28) left the court readable only in tight pools right under
 * each brazier — a duelist standing at a pillar three metres off was already
 * back in near-black. Raised intensity/reach and the ambient/hemi floor under
 * it so stone still reads as stone in shadow, not just as silhouette.
 */
const EMBER_INTENSITY = 220;
const EMBER_DECAY = 2;
const EMBER_DISTANCE = 40;

const HEMI_SKY = 0x6a7a9a;
const HEMI_GROUND = 0x1a1410;
const HEMI_INTENSITY = 0.5;
const AMBIENT_COLOR = 0x363442;
const AMBIENT_INTENSITY = 0.28;

const GROUND_SIZE = 200;
const GROUND_COLOR = 0x0c0b0e;
/** Slightly below the architecture flagstones so the apron reads on top. */
const GROUND_Y = -0.05;

export type EmberPoint = { x: number; y: number; z: number };

/** Apply a placement's transform and shadow flags to a resolved object. */
export function applyPlacement(object: THREE.Object3D, placement: WorldPlacement): void {
  object.position.set(placement.at[0], placement.at[1], placement.at[2]);
  if (placement.rotate) {
    const [x, y, z] = placement.rotate.map(THREE.MathUtils.degToRad) as [number, number, number];
    object.rotation.set(x, y, z, 'XYZ');
  } else if (placement.turn !== undefined) {
    object.rotation.y = THREE.MathUtils.degToRad(placement.turn);
  }
  if (placement.scale !== undefined) object.scale.setScalar(placement.scale);
  object.traverse(child => {
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

/** Dark horizon plane under the whole arena (including outer towers). */
export function createHorizonGround(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE);
  const material = new THREE.MeshStandardMaterial({
    color: GROUND_COLOR,
    roughness: 0.95,
    metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'arena.horizonGround';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = GROUND_Y;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Plain THREE lights matching the React rig — used by `buildArenaScene` so the
 * headless path never drifts from the component.
 */
export function createLightRig(emberPoints: readonly EmberPoint[]): THREE.Light[] {
  const lights: THREE.Light[] = [];

  const hemi = new THREE.HemisphereLight(HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY);
  hemi.name = 'arena.hemi';
  lights.push(hemi);

  const ambient = new THREE.AmbientLight(AMBIENT_COLOR, AMBIENT_INTENSITY);
  ambient.name = 'arena.ambient';
  lights.push(ambient);

  const count = Math.min(emberPoints.length, 8);
  for (let i = 0; i < count; i++) {
    const p = emberPoints[i]!;
    const point = new THREE.PointLight(EMBER_COLOR, EMBER_INTENSITY, EMBER_DISTANCE, EMBER_DECAY);
    point.name = `arena.ember.${i}`;
    point.position.set(p.x, p.y, p.z);
    point.castShadow = false;
    lights.push(point);
  }

  return lights;
}

/**
 * Headless builder: architecture + ground + lights + resolved dressing.
 * Settles after every placement attempt (nulls skipped).
 */
export async function buildArenaScene(): Promise<THREE.Scene> {
  const scene = new THREE.Scene();
  scene.name = 'arena.scene';

  const architecture = buildArena();
  scene.add(architecture);
  scene.add(createHorizonGround());

  const emberPoints = (architecture.userData.emberPoints ?? []) as EmberPoint[];
  for (const light of createLightRig(emberPoints)) {
    scene.add(light);
  }

  const resolved = await Promise.all(
    ARENA_DRESSING.map(async placement => {
      const object = await resolveProp(placement.key);
      if (!object) return null;
      applyPlacement(object, placement);
      return object;
    }),
  );

  for (const object of resolved) {
    if (object) scene.add(object);
  }

  return scene;
}

export function Arena() {
  const groupRef = useRef<THREE.Group>(null);

  const architecture = useMemo(() => buildArena(), []);
  const horizonGround = useMemo(() => createHorizonGround(), []);
  const emberPoints = (architecture.userData.emberPoints ?? []) as EmberPoint[];
  // Cap at 8; architecture always emits 6 — length is fixed for the component lifetime.
  const emberSlots = emberPoints.slice(0, 8);

  useEffect(() => {
    const parent = groupRef.current;
    if (!parent) return;

    let disposed = false;
    const placed: THREE.Object3D[] = [];

    ARENA_DRESSING.forEach(placement => {
      void (async () => {
        const object = await resolveProp(placement.key);
        if (disposed || !object) return;
        applyPlacement(object, placement);
        parent.add(object);
        placed.push(object);
      })();
    });

    return () => {
      disposed = true;
      for (const object of placed) object.removeFromParent();
    };
  }, []);

  return (
    <group>
      <primitive object={architecture} />
      <primitive object={horizonGround} />

      <hemisphereLight args={[HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY]} />
      <ambientLight args={[AMBIENT_COLOR, AMBIENT_INTENSITY]} />
      {emberSlots.map((p, i) => (
        <pointLight
          key={i}
          position={[p.x, p.y, p.z]}
          color={EMBER_COLOR}
          intensity={EMBER_INTENSITY}
          distance={EMBER_DISTANCE}
          decay={EMBER_DECAY}
        />
      ))}

      <group ref={groupRef} />
    </group>
  );
}
