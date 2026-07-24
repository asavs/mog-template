import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { PLAYER_CAPSULE_HEIGHT, PLAYER_COLLISION_RADIUS } from '../movement';

type PlayerDebugWindow = Window & {
  __playerDebug?: {
    simPosition?: THREE.Vector3;
    renderPosition?: THREE.Vector3;
  };
};

/** QA-only wireframe of the local player's gameplay capsule. */
export function PlayerCapsuleDebug() {
  const meshRef = useRef<THREE.Mesh>(null);
  const geometry = useMemo(
    () => new THREE.CapsuleGeometry(
      PLAYER_COLLISION_RADIUS,
      PLAYER_CAPSULE_HEIGHT - PLAYER_COLLISION_RADIUS * 2,
      8,
      16,
    ),
    [],
  );
  const material = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: 0x00ff00,
      depthTest: false,
      transparent: true,
      opacity: 0.85,
      wireframe: true,
    }),
    [],
  );

  useFrame(() => {
    const debug = (window as PlayerDebugWindow).__playerDebug;
    const position = debug?.simPosition ?? debug?.renderPosition;
    const mesh = meshRef.current;
    if (!mesh || !position) {
      if (mesh) mesh.visible = false;
      return;
    }
    mesh.visible = true;
    mesh.position.set(position.x, position.y + PLAYER_CAPSULE_HEIGHT * 0.5, position.z);
  });

  return <mesh ref={meshRef} geometry={geometry} material={material} renderOrder={1000} />;
}
