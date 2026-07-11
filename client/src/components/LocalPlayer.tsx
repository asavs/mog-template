import React, { memo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { BasePlayer, type LocalPlayerProps } from './BasePlayer';
import { useLocalPlayerFrameRuntime } from './localPlayerFrame';
import {
  useLocalPlayerControls,
  type LocalPlayerControlsRuntime,
} from './useLocalPlayerControls';

const toVisualYaw = (rotationY: number) => rotationY + Math.PI;
const LOCAL_CONTROL_ANIMATIONS = {
  slash: 'slash',
  block: 'block',
  cast: 'cast',
  drinking: 'drinking',
};

export const LocalPlayer: React.FC<LocalPlayerProps> = memo((props) => {
  const groupRef = useRef<THREE.Group>(null!);
  const controlsRuntimeRef = useRef<LocalPlayerControlsRuntime>({
    animations: {},
    getRuntimeData: () => ({}),
    hasEquipment: () => false,
    isEquipmentVisible: () => false,
    isOneShotAnimationActive: () => false,
    playOneShotAnimation: () => {},
    setEquipmentVisible: () => {},
    stopOneShotAnimation: () => {},
  });
  const actionRequestLockedUntilRef = useRef(0);
  const paladinBlockRequestedRef = useRef(false);
  const { camera } = useThree();
  const identityKey = props.playerData.identity.toHexString();
  const localFrameRuntime = useLocalPlayerFrameRuntime({
    camera,
    characterClass: props.characterClass,
    groupRef,
    identityKey,
    jumpAnimationName: 'jump',
    rotationYRef: props.rotationYRef,
    selectedWizardSpell: props.selectedWizardSpell,
    toVisualYaw,
  });

  useLocalPlayerControls({
    enabled: true,
    animationNames: LOCAL_CONTROL_ANIMATIONS,
    characterClass: props.characterClass,
    controlsRuntimeRef,
    localRotationYRef: localFrameRuntime.localRotationYRef,
    cameraPitchRef: localFrameRuntime.cameraPitchRef,
    cameraOrbitYawRef: localFrameRuntime.cameraOrbitYawRef,
    cameraOrbitPitchRef: localFrameRuntime.cameraOrbitPitchRef,
    cameraOrbitDraggingRef: localFrameRuntime.cameraOrbitDraggingRef,
    cameraOrbitDragDistanceRef: localFrameRuntime.cameraOrbitDragDistanceRef,
    cameraOrbitResettingRef: localFrameRuntime.cameraOrbitResettingRef,
    rotationYRef: props.rotationYRef,
    lightningTargetRef: localFrameRuntime.lightningTargetRef,
    fireballTargetRef: localFrameRuntime.fireballTargetRef,
    actionRequestLockedUntilRef,
    paladinBlockRequestedRef,
    onRotationChange: props.onRotationChange,
    onSlashAttack: props.onSlashAttack,
    onBlockStart: props.onBlockStart,
    onBlockStop: props.onBlockStop,
    onDrinkPotion: props.onDrinkPotion,
    onLightningStrike: props.onLightningStrike,
    onFireballCast: props.onFireballCast,
    cosmeticFireballCastsRef: props.cosmeticFireballCastsRef,
    fireballCasterKey: identityKey,
    selectedWizardSpell: props.selectedWizardSpell,
    setCosmeticFireballCastIds: props.setCosmeticFireballCastIds,
  });

  return (
    <BasePlayer
      {...props}
      controlsRuntimeRef={controlsRuntimeRef}
      groupRef={groupRef}
      isLocalPlayer
      localFrameRuntime={localFrameRuntime}
      actionRequestLockedUntilRef={actionRequestLockedUntilRef}
    />
  );
});
