import { useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// Issue #212 / PR #203: three.js bakes NUM_POINT_LIGHTS into lit-material
// shader keys, so mounting/unmounting one player light per join can relink the
// whole scene. Players use stable SpacetimeDB identity keys while spell effects
// use ephemeral cast/projectile keys, so this stays as a separate always-mounted
// pool from the spell pools. The scene-wide point-light budget is now the
// unchanged 16 spell lights plus 8 player lights = constant 24 from app load.
// There is no shared max-player constant; raise this one-time budget if the game
// needs more concurrently lit players. The hidden warm-up mesh compiles a
// MeshStandardMaterial against the final light count before slow assets arrive.
export const PLAYER_LIGHT_POOL_SIZE = 8;
export const PLAYER_LIGHT_HEIGHT_OFFSET = 3;

export function assignPoolSlot(
  key: string,
  poolSize: number,
  slotAssignments: Map<string, number>,
): number {
  const existing = slotAssignments.get(key);
  if (existing !== undefined) return existing;

  const usedSlots = new Set(slotAssignments.values());
  for (let index = 0; index < poolSize; index += 1) {
    if (!usedSlots.has(index)) {
      slotAssignments.set(key, index);
      return index;
    }
  }

  slotAssignments.set(key, -1);
  return -1;
}

export function usePlayerLightPool(playerIdentityKeys: readonly string[]) {
  const lightRefs = useMemo(() => (
    Array.from(
      { length: PLAYER_LIGHT_POOL_SIZE },
      () => ({ current: null }) as MutableRefObject<THREE.PointLight | null>,
    )
  ), []);
  const slotAssignmentsRef = useRef<Map<string, number>>(new Map());

  const activeIdentityKeys = new Set(playerIdentityKeys);
  slotAssignmentsRef.current.forEach((_, identityKey) => {
    if (!activeIdentityKeys.has(identityKey)) {
      slotAssignmentsRef.current.delete(identityKey);
    }
  });
  playerIdentityKeys.forEach(identityKey => {
    assignPoolSlot(identityKey, PLAYER_LIGHT_POOL_SIZE, slotAssignmentsRef.current);
  });

  const getLightRefForPlayer = (identityKey: string) => {
    const slot = slotAssignmentsRef.current.get(identityKey);
    if (slot === undefined || slot < 0) return undefined;
    return lightRefs[slot];
  };

  return { lightRefs, getLightRefForPlayer };
}

export function PlayerLightPool({
  lightRefs,
}: {
  lightRefs: readonly MutableRefObject<THREE.PointLight | null>[];
}) {
  const warmupRef = useRef<THREE.Mesh>(null);
  const warmupRenderedRef = useRef(false);

  useFrame(() => {
    if (warmupRenderedRef.current) {
      if (warmupRef.current) warmupRef.current.visible = false;
    } else {
      warmupRenderedRef.current = true;
    }
  });

  return (
    <group dispose={null}>
      {lightRefs.map((lightRef, index) => (
        <pointLight
          key={index}
          ref={lightRef}
          position={[0, PLAYER_LIGHT_HEIGHT_OFFSET, 0]}
          intensity={0}
          color="white"
        />
      ))}
      <mesh ref={warmupRef} scale={0} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="white" />
      </mesh>
    </group>
  );
}
