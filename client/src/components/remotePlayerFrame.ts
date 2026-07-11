import { useCallback, useMemo, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import {
  type RenderTickClock,
  sampleBuffer,
  type TransformSnapshot,
} from '../netcode';
import { QA_GAME_DEBUG_ENABLED, publishQaRemotePlayerRenderPosition } from '../hooks/useQaGameDebug';

export type RemoteMovementAnimationDirection = 'forward' | 'back' | 'left' | 'right';

export type RemotePlayerFrameRuntime = {
  runFrame: (
    currentMovementAnimationDirection: RemoteMovementAnimationDirection,
  ) => RemotePlayerFrameResult<RemoteMovementAnimationDirection> | null;
};

type UseRemotePlayerFrameRuntimeOptions = {
  getMovementAnimationDirection: (
    movementDelta: THREE.Vector3,
    rotationY: number,
    fallback: RemoteMovementAnimationDirection,
  ) => RemoteMovementAnimationDirection;
  groupRef: MutableRefObject<THREE.Group>;
  identityKey: string;
  renderTickClockRef: MutableRefObject<RenderTickClock>;
  snapshotBuffersRef: MutableRefObject<Map<string, TransformSnapshot[]>>;
  toVisualYaw: (rotationY: number) => number;
};

type RemotePlayerFrameOptions<MovementAnimationDirection extends string> = {
  renderTickClockRef: MutableRefObject<RenderTickClock>;
  snapshotBuffersRef: MutableRefObject<Map<string, TransformSnapshot[]>>;
  identityKey: string;
  groupRef: MutableRefObject<THREE.Group>;
  previousSamplePositionRef: MutableRefObject<THREE.Vector3 | null>;
  movementDeltaRef: MutableRefObject<THREE.Vector3>;
  currentMovementAnimationDirection: MovementAnimationDirection;
  toVisualYaw: (rotationY: number) => number;
  getMovementAnimationDirection: (
    movementDelta: THREE.Vector3,
    rotationY: number,
    fallback: MovementAnimationDirection,
  ) => MovementAnimationDirection;
};

type RemotePlayerFrameResult<MovementAnimationDirection extends string> = {
  movingForAnimation: boolean;
  sprintingForAnimation: boolean;
  airborneForAnimation: boolean;
  movementAnimationDirection: MovementAnimationDirection;
};

function useLazyRef<T>(factory: () => T): MutableRefObject<T> {
  const ref = useRef<T | null>(null);
  if (ref.current === null) {
    ref.current = factory();
  }
  return ref as MutableRefObject<T>;
}

export function useRemotePlayerFrameRuntime({
  getMovementAnimationDirection,
  groupRef,
  identityKey,
  renderTickClockRef,
  snapshotBuffersRef,
  toVisualYaw,
}: UseRemotePlayerFrameRuntimeOptions): RemotePlayerFrameRuntime {
  const previousSamplePositionRef = useRef<THREE.Vector3 | null>(null);
  const movementDeltaRef = useLazyRef(() => new THREE.Vector3());

  const runFrame = useCallback((
    currentMovementAnimationDirection: RemoteMovementAnimationDirection,
  ) => sampleRemotePlayerFrame({
    renderTickClockRef,
    snapshotBuffersRef,
    identityKey,
    groupRef,
    previousSamplePositionRef,
    movementDeltaRef,
    currentMovementAnimationDirection,
    toVisualYaw,
    getMovementAnimationDirection,
  }), [
    getMovementAnimationDirection,
    groupRef,
    identityKey,
    movementDeltaRef,
    renderTickClockRef,
    snapshotBuffersRef,
    toVisualYaw,
  ]);

  return useMemo(() => ({
    runFrame,
  }), [runFrame]);
}

export function sampleRemotePlayerFrame<MovementAnimationDirection extends string>({
  renderTickClockRef,
  snapshotBuffersRef,
  identityKey,
  groupRef,
  previousSamplePositionRef,
  movementDeltaRef,
  currentMovementAnimationDirection,
  toVisualYaw,
  getMovementAnimationDirection,
}: RemotePlayerFrameOptions<MovementAnimationDirection>): RemotePlayerFrameResult<MovementAnimationDirection> | null {
  const sample = sampleBuffer(
    snapshotBuffersRef.current.get(identityKey),
    renderTickClockRef.current.renderTick,
  );
  if (!sample) return null;

  let movementAnimationDirection = currentMovementAnimationDirection;
  const previousSamplePosition = previousSamplePositionRef.current;
  if (previousSamplePosition) {
    movementAnimationDirection = getMovementAnimationDirection(
      movementDeltaRef.current.copy(sample.position).sub(previousSamplePosition),
      sample.rotationY,
      movementAnimationDirection,
    );
    previousSamplePosition.copy(sample.position);
  } else {
    previousSamplePositionRef.current = sample.position.clone();
  }

  groupRef.current.position.copy(sample.position);
  groupRef.current.rotation.y = toVisualYaw(sample.rotationY);

  if (QA_GAME_DEBUG_ENABLED) {
    publishQaRemotePlayerRenderPosition(identityKey, groupRef.current.position);
  }

  return {
    movingForAnimation: sample.isMoving,
    sprintingForAnimation: sample.movementState.sprintActive,
    airborneForAnimation: sample.movementState.isAirborne,
    movementAnimationDirection,
  };
}
