import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { CombatEvent } from '../generated/types';

export const COMBAT_FEEDBACK_MS = 700;
const COMBAT_FEEDBACK_Y_OFFSET = 2.2;

export type ActiveCombatFeedback = {
  key: string;
  event: CombatEvent;
  position: THREE.Vector3;
  startedAt: number;
};

function combatFeedbackLabel(event: CombatEvent) {
  if (event.eventType === 'slash_blocked') return `Blocked ${event.amount}`;
  if (event.eventType === 'slash_miss') return 'Miss';
  return `Hit ${event.amount}`;
}

function combatFeedbackColor(event: CombatEvent) {
  if (event.eventType === 'slash_blocked') return '#7dd3fc';
  if (event.eventType === 'slash_miss') return '#cbd5e1';
  return '#f87171';
}

export function CombatFeedbackEffect({ effect }: { effect: ActiveCombatFeedback }) {
  const groupRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const flashRef = useRef<THREE.PointLight>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const color = combatFeedbackColor(effect.event);

  useFrame(() => {
    const progress = Math.min(1, (performance.now() - effect.startedAt) / COMBAT_FEEDBACK_MS);
    const lift = progress * 0.55;
    const pulse = Math.sin(progress * Math.PI);
    const opacity = Math.max(0, 1 - progress);

    if (groupRef.current) {
      groupRef.current.position.set(
        effect.position.x,
        effect.position.y + COMBAT_FEEDBACK_Y_OFFSET + lift,
        effect.position.z,
      );
    }
    if (ringRef.current) {
      ringRef.current.scale.setScalar(0.35 + progress * 1.1);
      ringRef.current.rotation.z += 0.05;
      const material = ringRef.current.material;
      if (material instanceof THREE.MeshBasicMaterial) {
        material.opacity = 0.55 * opacity;
      }
    }
    if (flashRef.current) {
      flashRef.current.intensity = 8 * pulse * opacity;
    }
    if (labelRef.current) {
      labelRef.current.style.opacity = opacity.toFixed(3);
      labelRef.current.style.transform = `translate(-50%, -50%) scale(${(1 + pulse * 0.12).toFixed(3)})`;
    }
  });

  return (
    <group
      ref={groupRef}
      position={[
        effect.position.x,
        effect.position.y + COMBAT_FEEDBACK_Y_OFFSET,
        effect.position.z,
      ]}
    >
      <pointLight ref={flashRef} color={color} intensity={0} distance={4} decay={2} />
      <mesh ref={ringRef} rotation={[0, 0, 0]} renderOrder={22}>
        <ringGeometry args={[0.22, 0.3, 32]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.55}
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      <Html center position={[0, 0.35, 0]}>
        <div
          ref={labelRef}
          style={{
            color,
            fontSize: '14px',
            fontWeight: 700,
            lineHeight: 1,
            padding: '3px 6px',
            background: 'rgba(10, 12, 16, 0.72)',
            border: `1px solid ${color}`,
            borderRadius: 4,
            boxShadow: `0 0 10px ${color}`,
            pointerEvents: 'none',
            position: 'absolute',
            textShadow: '0 1px 2px #000',
            whiteSpace: 'nowrap',
          }}
        >
          {combatFeedbackLabel(effect.event)}
        </div>
      </Html>
    </group>
  );
}
