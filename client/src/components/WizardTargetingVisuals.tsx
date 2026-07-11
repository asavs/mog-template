import React, { memo } from 'react';
import * as THREE from 'three';
import type { LocalPlayerFrameRuntime } from './localPlayerFrame';

const LIGHTNING_TARGET_RADIUS = 2.5;

type WizardTargetingVisualsProps = {
  runtime: LocalPlayerFrameRuntime;
};

export const WizardTargetingVisuals: React.FC<WizardTargetingVisualsProps> = memo(({ runtime }) => (
  <>
    <primitive object={runtime.fireballLineObject} ref={runtime.fireballLineRef} visible={false} renderOrder={17}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[new Float32Array(6), 3]}
        />
      </bufferGeometry>
      <lineBasicMaterial
        color="#79dcff"
        transparent
        opacity={0.95}
        depthWrite={false}
        depthTest={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </primitive>
    <group ref={runtime.lightningReticleRef} visible={false}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={16}>
        <ringGeometry args={[LIGHTNING_TARGET_RADIUS * 0.92, LIGHTNING_TARGET_RADIUS, 96]} />
        <meshBasicMaterial
          color="#bff6ff"
          transparent
          opacity={0.85}
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={15}>
        <circleGeometry args={[LIGHTNING_TARGET_RADIUS, 96]} />
        <meshBasicMaterial
          color="#79dcff"
          transparent
          opacity={0.14}
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
    </group>
  </>
));
