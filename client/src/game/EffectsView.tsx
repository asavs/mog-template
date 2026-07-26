/**
 * The R3F half of `presentation/effects.ts`'s pools — see that module's own
 * `// integration: wave2-shell` doc. One fixed `<pointLight>`/`<mesh>` per
 * pool slot, mounted exactly once for the scene's lifetime and never
 * mounted/unmounted again: a point-light COUNT change relinks the whole
 * scene's shaders, so an idle slot goes to zero intensity/opacity instead of
 * disappearing, exactly like the pool's own free-slot convention.
 *
 * Reads `EffectPool.entries` (fixed-length, stable order) by index each
 * frame and copies its plain data (`position`/`color`/`intensity`/`radius`)
 * onto the real three.js object at that same index.
 */

import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import type { Effects } from '../presentation/effects';
import type { GameStore } from './sync';

export type EffectsViewProps = {
  effects: Effects;
  store: GameStore;
};

function fadeFraction(remainingSeconds: number, totalSeconds: number): number {
  if (!(totalSeconds > 0) || !Number.isFinite(totalSeconds)) return 1;
  return Math.max(0, Math.min(1, remainingSeconds / totalSeconds));
}

export function EffectsView({ effects, store }: EffectsViewProps) {
  const lightRefs = useRef<(THREE.PointLight | null)[]>([]);
  const flashRefs = useRef<(THREE.Mesh | null)[]>([]);
  const ringRefs = useRef<(THREE.Mesh | null)[]>([]);
  const projectileRefs = useRef<(THREE.Mesh | null)[]>([]);

  useFrame((_state, delta) => {
    effects.syncProjectiles(
      [...store.projectile.values()].map(row => ({
        id: String(row.id),
        actionId: row.actionId,
        position: row.position,
        direction: row.direction,
      })),
    );
    effects.update(delta);

    effects.lights.entries.forEach((entry, index) => {
      const light = lightRefs.current[index];
      if (!light) return;
      light.position.copy(entry.resource.position);
      light.color.copy(entry.resource.color);
      light.intensity = entry.key === null ? 0 : entry.resource.intensity * fadeFraction(entry.remainingSeconds, entry.totalSeconds);
    });

    effects.meleeFlashes.entries.forEach((entry, index) => {
      const mesh = flashRefs.current[index];
      if (!mesh) return;
      mesh.visible = entry.key !== null;
      mesh.position.copy(entry.resource.position);
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.opacity = fadeFraction(entry.remainingSeconds, entry.totalSeconds);
    });

    effects.aoeRings.entries.forEach((entry, index) => {
      const mesh = ringRefs.current[index];
      if (!mesh) return;
      mesh.visible = entry.key !== null;
      mesh.position.copy(entry.resource.position);
      mesh.scale.setScalar(Math.max(0.001, entry.resource.radius));
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.opacity = fadeFraction(entry.remainingSeconds, entry.totalSeconds) * 0.6;
    });

    effects.projectiles.entries.forEach((entry, index) => {
      const mesh = projectileRefs.current[index];
      if (!mesh) return;
      mesh.visible = entry.key !== null;
      mesh.position.copy(entry.resource.position);
      if (entry.key !== null) {
        mesh.lookAt(entry.resource.position.clone().add(entry.resource.direction));
      }
    });
  });

  return (
    <>
      {effects.lights.entries.map((_, index) => (
        <pointLight
          key={index}
          ref={element => {
            lightRefs.current[index] = element;
          }}
          intensity={0}
          distance={10}
          decay={2}
        />
      ))}
      {effects.meleeFlashes.entries.map((_, index) => (
        <mesh
          key={index}
          visible={false}
          ref={element => {
            flashRefs.current[index] = element;
          }}
        >
          <sphereGeometry args={[0.35, 8, 8]} />
          <meshBasicMaterial color="#fff2c0" transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
      {effects.aoeRings.entries.map((_, index) => (
        <mesh
          key={index}
          visible={false}
          rotation={[-Math.PI / 2, 0, 0]}
          ref={element => {
            ringRefs.current[index] = element;
          }}
        >
          <ringGeometry args={[0.85, 1, 32]} />
          <meshBasicMaterial color="#ff9f4a" transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {effects.projectiles.entries.map((_, index) => (
        <mesh
          key={index}
          visible={false}
          ref={element => {
            projectileRefs.current[index] = element;
          }}
        >
          <sphereGeometry args={[0.18, 8, 8]} />
          <meshBasicMaterial color="#9fd7ff" />
        </mesh>
      ))}
    </>
  );
}
