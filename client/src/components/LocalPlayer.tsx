import React, { memo, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { BasePlayer, type LocalPlayerProps } from './BasePlayer';
import { resolvePlayerCapabilities } from './characterConfig';
import { useLocalPlayerFrameRuntime } from './localPlayerFrame';
import {
  useLocalPlayerControls,
  type LocalPlayerControlsRuntime,
} from './useLocalPlayerControls';
import { useGameState } from '../state/useGameState';

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
  const { playerAppearances, playerClasses, playerEquipment } = useGameState();

  // Same grant path as HUD hotkeys: appearance + equipment, class/preset fallback.
  const capabilities = useMemo(() => {
    const appearanceRow = playerAppearances.get(identityKey);
    const equipmentRows = playerEquipment.get(identityKey);
    return resolvePlayerCapabilities({
      legacyClass: playerClasses.get(identityKey) ?? props.characterClass,
      appearance: appearanceRow
        ? {
            bodyId: appearanceRow.bodyId,
            scale: appearanceRow.scale,
            loadoutPreset: appearanceRow.loadoutPreset,
          }
        : null,
      equipment: equipmentRows?.map(row => ({
        slot: row.slot,
        itemId: row.itemId,
      })),
    });
  }, [identityKey, playerAppearances, playerClasses, playerEquipment, props.characterClass]);

  const localFrameRuntime = useLocalPlayerFrameRuntime({
    camera,
    capabilities,
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
    capabilities,
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
