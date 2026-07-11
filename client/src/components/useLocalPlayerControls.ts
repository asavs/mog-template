import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import * as THREE from 'three';
import type { PlayerActionState, PlayerHealth, Vector3 as GameVector3 } from '../generated/types';
import { canRequestAction } from '../playerActions';
import { playLocalSound } from '../audio/AudioManager';
import { logFireballDebug, vectorDebug as fireballVectorDebug } from '../fireballDebug';
import { getCharacterCapabilities, type WizardSpell } from './characterConfig';
import {
  createPendingFireballCosmeticCast,
  fireballVisualDirectionFromSpawn,
  fireballVisualSpawnOriginFromCaster,
  normalizedFireballDirection,
  type PendingFireballCosmeticCast,
} from './fireballVisuals';
import { DRINKING_ANIMATION_TIME_SCALE } from './playerAnimation';

type RuntimeData = {
  actionState?: PlayerActionState;
  health?: PlayerHealth;
};

export type LocalPlayerControlsRuntime = {
  animations: Record<string, THREE.AnimationAction>;
  getRuntimeData: () => RuntimeData;
  hasEquipment: (equipmentId: string) => boolean;
  isEquipmentVisible: (equipmentId: string) => boolean;
  isOneShotAnimationActive: (animationName: string) => boolean;
  playOneShotAnimation: (animationName: string) => void;
  setEquipmentVisible: (equipmentId: string, visible: boolean) => void;
  stopOneShotAnimation: (animationName: string) => void;
};

type LocalPlayerControlsOptions = {
  enabled: boolean;
  animationNames: {
    slash: string;
    block: string;
    cast: string;
    drinking: string;
  };
  characterClass: string;
  controlsRuntimeRef: MutableRefObject<LocalPlayerControlsRuntime>;
  localRotationYRef?: MutableRefObject<number>;
  cameraPitchRef?: MutableRefObject<number>;
  cameraOrbitYawRef?: MutableRefObject<number>;
  cameraOrbitPitchRef?: MutableRefObject<number>;
  cameraOrbitDraggingRef?: MutableRefObject<boolean>;
  cameraOrbitDragDistanceRef?: MutableRefObject<number>;
  cameraOrbitResettingRef?: MutableRefObject<boolean>;
  cosmeticFireballCastsRef?: MutableRefObject<Map<string, PendingFireballCosmeticCast>>;
  fireballCasterKey?: string;
  rotationYRef?: MutableRefObject<number>;
  lightningTargetRef?: MutableRefObject<THREE.Vector3>;
  fireballTargetRef?: MutableRefObject<THREE.Vector3>;
  actionRequestLockedUntilRef: MutableRefObject<number>;
  paladinBlockRequestedRef: MutableRefObject<boolean>;
  onRotationChange?: (rotationY: number) => void;
  onSlashAttack?: () => void;
  onBlockStart?: () => void;
  onBlockStop?: () => void;
  onDrinkPotion?: () => void;
  onLightningStrike?: (targetPosition: GameVector3) => void;
  onFireballCast?: (targetPosition: GameVector3) => void;
  setCosmeticFireballCastIds?: Dispatch<SetStateAction<string[]>>;
  selectedWizardSpell: WizardSpell;
};

const CAMERA_YAW_SENSITIVITY = 0.005;
const CAMERA_PITCH_SENSITIVITY = 0.004;
const CAMERA_MIN_PITCH = THREE.MathUtils.degToRad(-80);
const CAMERA_MAX_PITCH = THREE.MathUtils.degToRad(80);
const CAMERA_ORBIT_DRAG_THRESHOLD_PX = 4;
const ACTION_REQUEST_LOCK_MS = 1200;

export function clampLookPitchWithOrbitOffset(nextPitch: number, orbitPitch: number): number {
  const minPitch = Math.max(CAMERA_MIN_PITCH, CAMERA_MIN_PITCH - orbitPitch);
  const maxPitch = Math.min(CAMERA_MAX_PITCH, CAMERA_MAX_PITCH - orbitPitch);

  return THREE.MathUtils.clamp(nextPitch, minPitch, maxPitch);
}

export function useLocalPlayerControls({
  enabled,
  animationNames,
  characterClass,
  controlsRuntimeRef,
  localRotationYRef,
  cameraPitchRef,
  cameraOrbitYawRef,
  cameraOrbitPitchRef,
  cameraOrbitDraggingRef,
  cameraOrbitDragDistanceRef,
  cameraOrbitResettingRef,
  cosmeticFireballCastsRef,
  fireballCasterKey,
  rotationYRef,
  lightningTargetRef,
  fireballTargetRef,
  actionRequestLockedUntilRef,
  paladinBlockRequestedRef,
  onRotationChange,
  onSlashAttack,
  onBlockStart,
  onBlockStop,
  onDrinkPotion,
  onLightningStrike,
  onFireballCast,
  setCosmeticFireballCastIds,
  selectedWizardSpell,
}: LocalPlayerControlsOptions) {
  const potionHideTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (potionHideTimeoutRef.current !== null) {
        window.clearTimeout(potionHideTimeoutRef.current);
        potionHideTimeoutRef.current = null;
      }
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (
      !localRotationYRef ||
      !cameraPitchRef ||
      !cameraOrbitYawRef ||
      !cameraOrbitPitchRef ||
      !cameraOrbitDraggingRef ||
      !cameraOrbitDragDistanceRef ||
      !cameraOrbitResettingRef ||
      !rotationYRef ||
      !lightningTargetRef ||
      !fireballTargetRef
    ) {
      throw new Error('Local player controls require local runtime refs when enabled');
    }

    const capabilities = getCharacterCapabilities(characterClass);

    const clearPotionHideTimeout = () => {
      if (potionHideTimeoutRef.current === null) return;
      window.clearTimeout(potionHideTimeoutRef.current);
      potionHideTimeoutRef.current = null;
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== document.body) return;

      if (cameraOrbitDraggingRef.current) {
        cameraOrbitDragDistanceRef.current += Math.hypot(event.movementX, event.movementY);
        cameraOrbitYawRef.current = THREE.MathUtils.euclideanModulo(
          cameraOrbitYawRef.current - event.movementX * CAMERA_YAW_SENSITIVITY + Math.PI,
          Math.PI * 2,
        ) - Math.PI;
        cameraOrbitPitchRef.current = THREE.MathUtils.clamp(
          cameraOrbitPitchRef.current - event.movementY * CAMERA_PITCH_SENSITIVITY,
          CAMERA_MIN_PITCH - cameraPitchRef.current,
          CAMERA_MAX_PITCH - cameraPitchRef.current,
        );
        cameraOrbitResettingRef.current = false;
        return;
      }

      localRotationYRef.current -= event.movementX * CAMERA_YAW_SENSITIVITY;
      cameraPitchRef.current = clampLookPitchWithOrbitOffset(
        cameraPitchRef.current - event.movementY * CAMERA_PITCH_SENSITIVITY,
        cameraOrbitPitchRef.current,
      );
      rotationYRef.current = localRotationYRef.current;
      onRotationChange?.(localRotationYRef.current);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || window.__equipmentCalibrationDebug?.enabled) return;

      const {
        getRuntimeData,
        hasEquipment,
        setEquipmentVisible,
        stopOneShotAnimation,
      } = controlsRuntimeRef.current;
      if (!hasEquipment('potion')) return;

      const { health: playerHealth } = getRuntimeData();
      const isDead = playerHealth?.isDead ?? false;

      if (event.code === 'Digit4') {
        if (isDead || !capabilities.drinkPotion) return;
        clearPotionHideTimeout();
        setEquipmentVisible('potion', true);
        event.preventDefault();
        return;
      }

      if (event.code === 'Digit1' || event.code === 'Digit2') {
        clearPotionHideTimeout();
        setEquipmentVisible('potion', false);
        stopOneShotAnimation(animationNames.drinking);
      }
    };

    const handleCanvasClick = (event: MouseEvent) => {
      const {
        animations,
        getRuntimeData,
        isEquipmentVisible,
        isOneShotAnimationActive,
        playOneShotAnimation,
        setEquipmentVisible,
      } = controlsRuntimeRef.current;
      const { actionState: playerActionState, health: playerHealth } = getRuntimeData();
      const isDead = playerHealth?.isDead ?? false;
      if (document.pointerLockElement !== document.body) {
        document.body.requestPointerLock();
      }

      if (
        event.button === 0 &&
        !isDead &&
        isEquipmentVisible('potion') &&
        animations[animationNames.drinking]
      ) {
        if (isOneShotAnimationActive(animationNames.drinking)) return;
        playOneShotAnimation(animationNames.drinking);
        playLocalSound('potion_drinking').catch(() => {});
        onDrinkPotion?.();
        const drinkingDurationMs = (
          (animations[animationNames.drinking]?.getClip()?.duration ?? 1.4) * 1000
        ) / DRINKING_ANIMATION_TIME_SCALE;
        clearPotionHideTimeout();
        potionHideTimeoutRef.current = window.setTimeout(() => {
          potionHideTimeoutRef.current = null;
          setEquipmentVisible('potion', false);
        }, drinkingDurationMs);
        return;
      }

      if (event.button === 0 && !isDead && capabilities.melee && animations[animationNames.slash]) {
        const now = performance.now();
        if (!canRequestAction(
          playerActionState,
          'attack',
          now,
          actionRequestLockedUntilRef.current,
        )) {
          return;
        }

        actionRequestLockedUntilRef.current = now + ACTION_REQUEST_LOCK_MS;
        onSlashAttack?.();
      } else if (event.button === 0 && !isDead && capabilities.spells.length > 0 && animations[animationNames.cast]) {
        if (selectedWizardSpell === 'fireball') {
          const targetPosition = {
            x: fireballTargetRef.current.x,
            y: fireballTargetRef.current.y,
            z: fireballTargetRef.current.z,
          };
          const aimDebug = window.__fireballAimDebug;
          let cosmeticCastId: string | null = null;
          let cosmeticOrigin: ReturnType<typeof fireballVectorDebug> | null = null;
          if (
            aimDebug &&
            cosmeticFireballCastsRef &&
            fireballCasterKey &&
            setCosmeticFireballCastIds
          ) {
            const direction = normalizedFireballDirection(new THREE.Vector3(
              aimDebug.aimDirection.x,
              aimDebug.aimDirection.y,
              aimDebug.aimDirection.z,
            ));
            const casterPosition = new THREE.Vector3(
              aimDebug.renderPosition.x,
              aimDebug.renderPosition.y,
              aimDebug.renderPosition.z,
            );
            const origin = fireballVisualSpawnOriginFromCaster(
              casterPosition,
              direction,
            );
            const projectileDirection = fireballVisualDirectionFromSpawn(casterPosition, direction);
            const cosmeticCast = createPendingFireballCosmeticCast({
              casterKey: fireballCasterKey,
              direction: projectileDirection,
              origin,
              spawnDirection: direction,
            });
            cosmeticFireballCastsRef.current.set(cosmeticCast.id, cosmeticCast);
            setCosmeticFireballCastIds(prev => (
              prev.includes(cosmeticCast.id) ? prev : [...prev, cosmeticCast.id]
            ));
            cosmeticCastId = cosmeticCast.id;
            cosmeticOrigin = fireballVectorDebug(cosmeticCast.origin);
          }
          logFireballDebug('cast-request', {
            aimDirection: aimDebug?.aimDirection,
            cameraPosition: aimDebug?.cameraPosition,
            cosmeticCastId,
            cosmeticOrigin,
            localRotationY: aimDebug?.localRotationY,
            renderPosition: aimDebug?.renderPosition,
            targetPosition: fireballVectorDebug(targetPosition),
          });
          onFireballCast?.(targetPosition);
        } else {
          onLightningStrike?.({
            x: lightningTargetRef.current.x,
            y: lightningTargetRef.current.y,
            z: lightningTargetRef.current.z,
          });
        }
        playOneShotAnimation(animationNames.cast);
      }
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button === 1) {
        event.preventDefault();
        cameraOrbitDraggingRef.current = true;
        cameraOrbitDragDistanceRef.current = 0;
        cameraOrbitResettingRef.current = false;

        if (document.pointerLockElement !== document.body) {
          document.body.requestPointerLock();
        }
        return;
      }

      const { animations, getRuntimeData } = controlsRuntimeRef.current;
      const { actionState: playerActionState, health: playerHealth } = getRuntimeData();
      const isDead = playerHealth?.isDead ?? false;
      if (event.button !== 2) return;
      event.preventDefault();

      if (document.pointerLockElement !== document.body) {
        document.body.requestPointerLock();
      }

      if (!isDead && capabilities.block && animations[animationNames.block]) {
        if (paladinBlockRequestedRef.current) return;

        const now = performance.now();
        if (!canRequestAction(
          playerActionState,
          'block',
          now,
          actionRequestLockedUntilRef.current,
        )) {
          return;
        }

        actionRequestLockedUntilRef.current = now + ACTION_REQUEST_LOCK_MS;
        paladinBlockRequestedRef.current = true;
        onBlockStart?.();
      }
    };

    const stopHeldBlock = () => {
      const { getRuntimeData } = controlsRuntimeRef.current;
      const { actionState: playerActionState } = getRuntimeData();
      if (!paladinBlockRequestedRef.current && playerActionState?.currentAction !== 'blocking') return;
      paladinBlockRequestedRef.current = false;
      onBlockStop?.();
    };

    const handleMouseUp = (event: MouseEvent) => {
      if (event.button === 1) {
        event.preventDefault();
        cameraOrbitDraggingRef.current = false;
        if (cameraOrbitDragDistanceRef.current < CAMERA_ORBIT_DRAG_THRESHOLD_PX) {
          cameraOrbitResettingRef.current = true;
        }
        return;
      }

      if (event.button !== 2) return;
      event.preventDefault();
      stopHeldBlock();
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (capabilities.block) {
        event.preventDefault();
      }
    };

    const handleAuxClick = (event: MouseEvent) => {
      if (event.button === 1) {
        event.preventDefault();
      }
    };

    const stopCameraOrbitDrag = () => {
      cameraOrbitDraggingRef.current = false;
    };

    const handlePointerLockChange = () => {
      if (document.pointerLockElement !== document.body) {
        cameraOrbitDraggingRef.current = false;
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('click', handleCanvasClick);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('auxclick', handleAuxClick);
    document.addEventListener('contextmenu', handleContextMenu);
    document.addEventListener('pointerlockchange', handlePointerLockChange);
    window.addEventListener('blur', stopHeldBlock);
    window.addEventListener('blur', stopCameraOrbitDrag);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('click', handleCanvasClick);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('auxclick', handleAuxClick);
      document.removeEventListener('contextmenu', handleContextMenu);
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      window.removeEventListener('blur', stopHeldBlock);
      window.removeEventListener('blur', stopCameraOrbitDrag);
    };
  }, [
    enabled,
    animationNames,
    characterClass,
    controlsRuntimeRef,
    localRotationYRef,
    cameraPitchRef,
    cameraOrbitYawRef,
    cameraOrbitPitchRef,
    cameraOrbitDraggingRef,
    cameraOrbitDragDistanceRef,
    cameraOrbitResettingRef,
    rotationYRef,
    lightningTargetRef,
    fireballTargetRef,
    actionRequestLockedUntilRef,
    paladinBlockRequestedRef,
    onRotationChange,
    onSlashAttack,
    onBlockStart,
    onBlockStop,
    onDrinkPotion,
    onLightningStrike,
    onFireballCast,
    selectedWizardSpell,
  ]);
}
