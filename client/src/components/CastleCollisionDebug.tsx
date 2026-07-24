import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { castleCollisionAsset } from '../castleCollision';

/** QA-only wireframe of the exact CC01 triangles; never mount this in normal play. */
export function CastleCollisionDebug() {
  const lines = useMemo(() => {
    const asset = castleCollisionAsset();
    const positions = new Float32Array((asset.indices.length / 3) * 18);
    let cursor = 0;
    for (let triangle = 0; triangle < asset.indices.length; triangle += 3) {
      const triangleVertices = [asset.indices[triangle], asset.indices[triangle + 1], asset.indices[triangle + 2]];
      for (const [from, to] of [[0, 1], [1, 2], [2, 0]]) {
        for (const index of [triangleVertices[from], triangleVertices[to]]) {
          const source = index * 3;
          positions[cursor] = asset.vertices[source];
          positions[cursor + 1] = asset.vertices[source + 1];
          positions[cursor + 2] = asset.vertices[source + 2];
          cursor += 3;
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.45, depthTest: false }),
    );
  }, []);

  useEffect(() => () => {
    lines.geometry.dispose();
    (lines.material as THREE.Material).dispose();
  }, [lines]);

  return <primitive object={lines} />;
}
