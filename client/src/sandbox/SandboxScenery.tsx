/**
 * Puts a scene's props in the world.
 *
 * Everything here comes through the same `resolveProp` the hands use, so a
 * barrel and a sword are the same kind of thing to this component and neither
 * knows where its mesh came from. Scenery just never gets a grip applied — the
 * kit authors these origin-at-base, which is exactly right for something
 * standing on a floor.
 *
 * A prop that fails to resolve is skipped without comment, because that is what
 * `resolveProp` does: warns and returns null so a missing mesh cannot take the
 * scene down with it.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { resolveProp } from '../content';
import { WALL_Z, type Scene } from './scenes';

type SandboxSceneryProps = {
  scene: Scene;
};

/** Something for the wall fittings to hang on, and a back to the room. */
function buildWall(): THREE.Object3D {
  const group = new THREE.Group();
  group.name = 'sandbox.wall';

  // Light enough to bounce. A dark backdrop behind dark props means the
  // silhouette you are trying to judge disappears into it.
  const stone = new THREE.MeshStandardMaterial({ color: 0x6b6a74, roughness: 0.9 });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(11, 3.2, 0.24), stone);
  wall.position.set(0, 1.6, WALL_Z);
  wall.receiveShadow = true;
  group.add(wall);

  // A lip along the top so it reads as built rather than as a backdrop plane.
  const ledge = new THREE.Mesh(
    new THREE.BoxGeometry(11.3, 0.16, 0.42),
    new THREE.MeshStandardMaterial({ color: 0x807e8a, roughness: 0.85 }),
  );
  ledge.position.set(0, 3.24, WALL_Z);
  ledge.receiveShadow = true;
  group.add(ledge);

  return group;
}

export function SandboxScenery({ scene }: SandboxSceneryProps) {
  const groupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    const parent = groupRef.current;
    if (!parent) return;

    let disposed = false;
    const placed: THREE.Object3D[] = [];

    if (scene.wall) {
      const wall = buildWall();
      parent.add(wall);
      placed.push(wall);
    }

    for (const placement of scene.place) {
      void (async () => {
        const object = await resolveProp(placement.key);
        if (disposed || !object) return;
        object.position.set(...placement.at);
        if (placement.rotate) {
          const [x, y, z] = placement.rotate.map(THREE.MathUtils.degToRad);
          object.rotation.set(x, y, z, 'XYZ');
        } else if (placement.turn) {
          object.rotation.y = THREE.MathUtils.degToRad(placement.turn);
        }
        if (placement.scale) object.scale.setScalar(placement.scale);
        object.traverse(child => {
          if ((child as THREE.Mesh).isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
        parent.add(object);
        placed.push(object);
      })();
    }

    return () => {
      disposed = true;
      for (const object of placed) object.removeFromParent();
    };
  }, [scene]);

  return <group ref={groupRef} />;
}
