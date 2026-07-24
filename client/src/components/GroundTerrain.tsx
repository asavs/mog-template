import { useLayoutEffect } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { publicAssetPath } from '../publicAssets';
import {
  TERRAIN_GLB_RELATIVE_PATH,
  TERRAIN_TARGET_SIZE,
  TERRAIN_Y_OFFSET,
} from '../terrainConfig';

const TERRAIN_PATH = publicAssetPath(TERRAIN_GLB_RELATIVE_PATH);
const CASTLE_COLLISION_MESH_NAME = 'Castle Collision.002';

export function GroundTerrain() {
  const { scene } = useGLTF(TERRAIN_PATH);

  useLayoutEffect(() => {
    scene.position.set(0, 0, 0);
    scene.rotation.set(0, 0, 0);
    scene.scale.setScalar(1);
    scene.updateMatrixWorld(true);

    const bounds = new THREE.Box3().setFromObject(scene);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const scale = TERRAIN_TARGET_SIZE / Math.max(size.x, size.z);

    scene.position.set(
      -center.x * scale,
      TERRAIN_Y_OFFSET - bounds.min.y * scale,
      -center.z * scale,
    );
    scene.scale.setScalar(scale);

    scene.traverse(child => {
      if (child instanceof THREE.Mesh) {
        if (child.name === CASTLE_COLLISION_MESH_NAME) {
          child.visible = false;
        }
        child.receiveShadow = true;
      }
    });
  }, [scene]);

  return <primitive object={scene} />;
}

useGLTF.preload(TERRAIN_PATH);
