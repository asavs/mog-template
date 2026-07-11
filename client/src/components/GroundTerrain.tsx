import { useLayoutEffect } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { publicAssetPath } from '../publicAssets';

const TERRAIN_PATH = publicAssetPath('models/terrain/dark-fantasy-map-2.glb');
const TERRAIN_Y_OFFSET = 0;
const TERRAIN_TARGET_SIZE = 3148.07;

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
        child.receiveShadow = true;
      }
    });
  }, [scene]);

  return <primitive object={scene} />;
}

useGLTF.preload(TERRAIN_PATH);
