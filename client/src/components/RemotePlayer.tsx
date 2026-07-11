import React, { memo, useRef } from 'react';
import * as THREE from 'three';
import { BasePlayer, type RemotePlayerProps } from './BasePlayer';
import {
  type RemoteMovementAnimationDirection,
  useRemotePlayerFrameRuntime,
} from './remotePlayerFrame';

const VISUAL_MODEL_YAW_OFFSET = Math.PI;
const REMOTE_DIRECTION_EPSILON_SQ = 0.0001;

function toVisualYaw(rotationY: number): number {
  return rotationY + VISUAL_MODEL_YAW_OFFSET;
}

function getRemoteMovementAnimationDirection(
  movementDelta: THREE.Vector3,
  rotationY: number,
  fallback: RemoteMovementAnimationDirection,
): RemoteMovementAnimationDirection {
  const horizontalDistanceSq = movementDelta.x * movementDelta.x + movementDelta.z * movementDelta.z;
  if (horizontalDistanceSq <= REMOTE_DIRECTION_EPSILON_SQ) return fallback;

  const forwardX = -Math.sin(rotationY);
  const forwardZ = -Math.cos(rotationY);
  const rightX = Math.cos(rotationY);
  const rightZ = -Math.sin(rotationY);
  const forwardDot = movementDelta.x * forwardX + movementDelta.z * forwardZ;
  const rightDot = movementDelta.x * rightX + movementDelta.z * rightZ;

  if (Math.abs(rightDot) >= Math.abs(forwardDot)) {
    return rightDot > 0 ? 'right' : 'left';
  }
  return forwardDot >= 0 ? 'forward' : 'back';
}

export const RemotePlayer: React.FC<RemotePlayerProps> = memo((props) => {
  const groupRef = useRef<THREE.Group>(null!);
  const identityKey = props.playerData.identity.toHexString();
  const remoteFrameRuntime = useRemotePlayerFrameRuntime({
    getMovementAnimationDirection: getRemoteMovementAnimationDirection,
    groupRef,
    identityKey,
    renderTickClockRef: props.renderTickClockRef,
    snapshotBuffersRef: props.snapshotBuffersRef,
    toVisualYaw,
  });

  return (
    <BasePlayer
      {...props}
      groupRef={groupRef}
      isLocalPlayer={false}
      remoteFrameRuntime={remoteFrameRuntime}
    />
  );
});
