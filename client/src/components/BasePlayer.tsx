import React, { useCallback, useEffect, useMemo, useRef, useState, memo, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { InputState, PlayerData, PlayerInputAck, PlayerTransform, Vector3 as GameVector3 } from '../generated/types';
import {
  type NetMetrics,
  type RenderTickClock,
  type TransformSnapshot,
} from '../netcode';
import type { PlayerRuntimeState } from '../playerRuntime';
import type { LocalPlayerControlsRuntime } from './useLocalPlayerControls';
import { useEquipmentCalibration } from './useEquipmentCalibration';
import {
  type MovementAnimationDirection,
  type LocalPlayerFrameRuntime,
} from './localPlayerFrame';
import type { RemotePlayerFrameRuntime } from './remotePlayerFrame';
import {
  applyTargetAnimation,
  DRINKING_ANIMATION_TIME_SCALE,
  playRemoteOneShotAnimation,
  selectTargetAnimation,
  triggerOneShotAnimation,
} from './playerAnimation';
import { ANIMATIONS, getCharacterPresentationFromServer, type WizardSpell } from './characterConfig';
import { loadPlayerModelAssets } from './playerModelLoader';
import { presentationAssemblyKey } from '../avatar/catalog';
import { useGameState } from '../state/useGameState';
import {
  createLoopingLocalSound,
  createLoopingWorldSound,
  playWorldSound,
  stopManagedAudio,
} from '../audio/AudioManager';
import { WizardTargetingVisuals } from './WizardTargetingVisuals';
import { PlayerNameplate, type PlayerNameplateHandle } from './PlayerNameplate';
import { PLAYER_LIGHT_HEIGHT_OFFSET } from './PlayerLightPool';
import type { SpellCasterVisualOrigin } from './spellVisualOrigins';
import type { PendingFireballCosmeticCast } from './fireballVisuals';

interface SharedPlayerProps {
  playerData: PlayerData;
  characterClass: string;
  playerRuntimeRef: MutableRefObject<PlayerRuntimeState>;
  lightRef?: MutableRefObject<THREE.PointLight | null>;
  spellCasterVisualOriginsRef: MutableRefObject<Map<string, SpellCasterVisualOrigin>>;
}

export interface LocalPlayerProps extends SharedPlayerProps {
  onRotationChange?: (rotationY: number) => void;
  onSlashAttack?: () => void;
  onBlockStart?: () => void;
  onBlockStop?: () => void;
  onLightningStrike?: (targetPosition: GameVector3) => void;
  onFireballCast?: (targetPosition: GameVector3) => void;
  onDrinkPotion?: () => void;
  selectedWizardSpell: WizardSpell;
  cosmeticFireballCastsRef?: MutableRefObject<Map<string, PendingFireballCosmeticCast>>;
  setCosmeticFireballCastIds?: React.Dispatch<React.SetStateAction<string[]>>;
  currentInputRef: MutableRefObject<InputState>;
  rotationYRef: MutableRefObject<number>;
  latestTransformsRef: MutableRefObject<Map<string, PlayerTransform>>;
  latestInputAcksRef: MutableRefObject<Map<string, PlayerInputAck>>;
  metricsRef: MutableRefObject<NetMetrics>;
}

export interface RemotePlayerProps extends SharedPlayerProps {
  renderTickClockRef: MutableRefObject<RenderTickClock>;
  snapshotBuffersRef: MutableRefObject<Map<string, TransformSnapshot[]>>;
}

export type BasePlayerProps = SharedPlayerProps & {
  currentInputRef?: MutableRefObject<InputState>;
  groupRef: MutableRefObject<THREE.Group>;
  latestTransformsRef?: MutableRefObject<Map<string, PlayerTransform>>;
  latestInputAcksRef?: MutableRefObject<Map<string, PlayerInputAck>>;
  metricsRef?: MutableRefObject<NetMetrics>;
  controlsRuntimeRef?: MutableRefObject<LocalPlayerControlsRuntime>;
  isLocalPlayer: boolean;
  localFrameRuntime?: LocalPlayerFrameRuntime;
  actionRequestLockedUntilRef?: MutableRefObject<number>;
  remoteFrameRuntime?: RemotePlayerFrameRuntime;
};

export type { WizardSpell };

const ACTION_ANIMATION_NAMES = {
  idle: ANIMATIONS.IDLE,
  jump: ANIMATIONS.JUMP,
  slash: ANIMATIONS.SLASH,
  block: ANIMATIONS.BLOCK,
  cast: ANIMATIONS.CAST,
  drinking: ANIMATIONS.DRINKING,
  death: ANIMATIONS.DEATH,
};

const MOVEMENT_ANIMATION_NAMES = {
  walk: ANIMATIONS.WALK,
  walkBack: ANIMATIONS.WALK_BACK,
  walkLeft: ANIMATIONS.WALK_LEFT,
  walkRight: ANIMATIONS.WALK_RIGHT,
  run: ANIMATIONS.RUN,
  runBack: ANIMATIONS.RUN_BACK,
  runLeft: ANIMATIONS.RUN_LEFT,
  runRight: ANIMATIONS.RUN_RIGHT,
};

const FOOTSTEP_WALK_ANIMATIONS: ReadonlySet<string> = new Set([
  ANIMATIONS.WALK,
  ANIMATIONS.WALK_BACK,
  ANIMATIONS.WALK_LEFT,
  ANIMATIONS.WALK_RIGHT,
]);
const FOOTSTEP_RUN_ANIMATIONS: ReadonlySet<string> = new Set([
  ANIMATIONS.RUN,
  ANIMATIONS.RUN_BACK,
  ANIMATIONS.RUN_LEFT,
  ANIMATIONS.RUN_RIGHT,
]);
const FOOTSTEPS_START_DELAY_MS = 80;
const PLAYER_LIGHT_INTENSITY = 5;

export const BasePlayer: React.FC<BasePlayerProps> = memo(({
  playerData,
  characterClass,
  playerRuntimeRef,
  isLocalPlayer,
  controlsRuntimeRef,
  groupRef,
  currentInputRef,
  localFrameRuntime,
  latestTransformsRef,
  latestInputAcksRef,
  lightRef,
  metricsRef,
  actionRequestLockedUntilRef,
  remoteFrameRuntime,
  spellCasterVisualOriginsRef,
}) => {
  const identityKey = playerData.identity.toHexString();
  const { playerAppearances, playerEquipment } = useGameState();
  const appearanceRow = playerAppearances.get(identityKey);
  const equipmentRows = playerEquipment.get(identityKey);
  const characterConfig = useMemo(
    () => getCharacterPresentationFromServer({
      legacyClass: characterClass,
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
    }),
    [appearanceRow, characterClass, equipmentRows],
  );

  const [modelLoaded, setModelLoaded] = useState(false);
  const [mixer, setMixer] = useState<THREE.AnimationMixer | null>(null);
  const [animations, setAnimations] = useState<Record<string, THREE.AnimationAction>>({});

  const currentAnimationRef = useRef<string>(ANIMATIONS.IDLE);
  const visualModelRef = useRef<THREE.Group | null>(null);
  const oneShotAnimationRef = useRef({ name: '', until: 0 });
  const lastPlayedAttackSeqRef = useRef<number | null>(null);
  const lastHandledDrinkingSeqRef = useRef<number | null>(null);
  const potionHideTimeoutRef = useRef<number | null>(null);
  const drinkingSoundPositionRef = useRef(new THREE.Vector3());
  const equipmentItemsRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const desiredEquipmentVisibilityRef = useRef<Map<string, boolean>>(new Map());
  const nameplateRef = useRef<PlayerNameplateHandle>(null);
  const movementAnimationDirectionRef = useRef<MovementAnimationDirection>('forward');
  const walkFootstepsRef = useRef<THREE.Audio | THREE.PositionalAudio | null>(null);
  const walkFootstepsPlayingRef = useRef(false);
  const walkFootstepsStartTimeoutRef = useRef<number | null>(null);
  const runFootstepsRef = useRef<THREE.Audio | THREE.PositionalAudio | null>(null);
  const runFootstepsPlayingRef = useRef(false);
  const runFootstepsStartTimeoutRef = useRef<number | null>(null);
  // Player lights borrow from a scene-wide fixed pool (issue #212) so joins do
  // not mount runtime point lights and force scene-wide shader relinks.
  const fallbackLightRef = useRef<THREE.PointLight>(null);
  const activeLightRef = lightRef ?? fallbackLightRef;
  const playerLightWorldPositionRef = useRef(new THREE.Vector3());
  const visualOriginPositionRef = useRef(new THREE.Vector3());

  const getRuntimeData = useCallback(() => ({
    actionState: playerRuntimeRef.current.actionStates.get(identityKey),
    animation: playerRuntimeRef.current.animations.get(identityKey),
    health: playerRuntimeRef.current.health.get(identityKey),
  }), [identityKey, playerRuntimeRef]);

  const playOneShotAnimation = useCallback((animationName: string) => {
    triggerOneShotAnimation(
      animations,
      currentAnimationRef,
      animationName,
      oneShotAnimationRef,
      ACTION_ANIMATION_NAMES,
    );
  }, [animations]);

  const hasEquipment = useCallback((equipmentId: string) => (
    equipmentItemsRef.current.has(equipmentId) ||
    characterConfig.equipmentIds.includes(equipmentId)
  ), [characterConfig]);

  const isEquipmentVisible = useCallback((equipmentId: string) => (
    equipmentItemsRef.current.get(equipmentId)?.visible ??
    desiredEquipmentVisibilityRef.current.get(equipmentId) ??
    false
  ), []);

  const setEquipmentVisible = useCallback((equipmentId: string, visible: boolean) => {
    desiredEquipmentVisibilityRef.current.set(equipmentId, visible);
    const equipment = equipmentItemsRef.current.get(equipmentId);
    if (equipment) equipment.visible = visible;
  }, []);

  const isOneShotAnimationActive = useCallback((animationName: string) => (
    oneShotAnimationRef.current.name === animationName &&
    performance.now() < oneShotAnimationRef.current.until
  ), []);

  const stopOneShotAnimation = useCallback((animationName: string) => {
    animations[animationName]?.stop();
    if (oneShotAnimationRef.current.name === animationName) {
      oneShotAnimationRef.current = { name: '', until: 0 };
    }
  }, [animations]);

  const showPotionDuringDrinking = useCallback((durationMs: number) => {
    setEquipmentVisible('potion', true);
    if (potionHideTimeoutRef.current !== null) {
      window.clearTimeout(potionHideTimeoutRef.current);
    }
    potionHideTimeoutRef.current = window.setTimeout(() => {
      potionHideTimeoutRef.current = null;
      setEquipmentVisible('potion', false);
    }, durationMs);
  }, [setEquipmentVisible]);

  useEffect(() => {
    if (!controlsRuntimeRef) return;
    controlsRuntimeRef.current = {
      animations,
      getRuntimeData,
      hasEquipment,
      isEquipmentVisible,
      isOneShotAnimationActive,
      playOneShotAnimation,
      setEquipmentVisible,
      stopOneShotAnimation,
    };
  }, [
    animations,
    controlsRuntimeRef,
    getRuntimeData,
    hasEquipment,
    isEquipmentVisible,
    isOneShotAnimationActive,
    playOneShotAnimation,
    setEquipmentVisible,
    stopOneShotAnimation,
  ]);

  useEffect(() => {
    return () => {
      if (potionHideTimeoutRef.current !== null) {
        window.clearTimeout(potionHideTimeoutRef.current);
      }
      spellCasterVisualOriginsRef.current.delete(identityKey);
    };
  }, [identityKey, spellCasterVisualOriginsRef]);

  useEffect(() => {
    if (!lightRef) return undefined;
    const light = lightRef.current;
    if (light) light.intensity = PLAYER_LIGHT_INTENSITY;
    return () => {
      if (light) light.intensity = 0;
    };
  }, [lightRef]);

  useEquipmentCalibration({
    enabled: isLocalPlayer,
    equipmentItemsRef,
  });

  useEffect(() => {
    const footstepSounds = characterConfig.footstepSounds;
    if (!footstepSounds) {
      stopLoopingAudio(
        walkFootstepsRef.current,
        walkFootstepsPlayingRef,
        walkFootstepsStartTimeoutRef,
      );
      stopLoopingAudio(
        runFootstepsRef.current,
        runFootstepsPlayingRef,
        runFootstepsStartTimeoutRef,
      );
      stopManagedAudio(walkFootstepsRef.current);
      stopManagedAudio(runFootstepsRef.current);
      walkFootstepsRef.current = null;
      runFootstepsRef.current = null;
      return;
    }

    let disposed = false;
    const createAudio = isLocalPlayer ? createLoopingLocalSound : createLoopingWorldSound;

    createAudio(footstepSounds.walk).then(audio => {
      if (disposed) {
        stopManagedAudio(audio);
        return;
      }
      if (!isLocalPlayer) groupRef.current?.add(audio);
      walkFootstepsRef.current = audio;
    }).catch(() => {});

    createAudio(footstepSounds.run).then(audio => {
      if (disposed) {
        stopManagedAudio(audio);
        return;
      }
      if (!isLocalPlayer) groupRef.current?.add(audio);
      runFootstepsRef.current = audio;
    }).catch(() => {});

    return () => {
      disposed = true;
      stopLoopingAudio(
        walkFootstepsRef.current,
        walkFootstepsPlayingRef,
        walkFootstepsStartTimeoutRef,
      );
      stopLoopingAudio(
        runFootstepsRef.current,
        runFootstepsPlayingRef,
        runFootstepsStartTimeoutRef,
      );
      stopManagedAudio(walkFootstepsRef.current);
      stopManagedAudio(runFootstepsRef.current);
      walkFootstepsRef.current = null;
      runFootstepsRef.current = null;
    };
  }, [characterConfig, groupRef, isLocalPlayer]);

  // Content key — not object identity. Join often resolves preset first, then
  // identical seeded server rows; skip dispose/rebuild when the loadout is unchanged.
  const assemblyKey = presentationAssemblyKey(characterConfig.resolved);

  useEffect(() => {
    lastHandledDrinkingSeqRef.current = null;
    return loadPlayerModelAssets({
      actionAnimationNames: ACTION_ANIMATION_NAMES,
      resolved: characterConfig.resolved,
      presetId: characterConfig.presetId,
      currentAnimationRef,
      desiredEquipmentVisibilityRef,
      equipmentItemsRef,
      groupRef,
      lastPlayedAttackSeqRef,
      onAnimationsLoaded: setAnimations,
      onMixerLoaded: setMixer,
      onModelLoaded: setModelLoaded,
      visualModelRef,
    });
    // assemblyKey is the content gate; characterConfig is from the render that changed the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: avoid re-assemble on new object identity
  }, [assemblyKey, groupRef]);

  useFrame((_, delta) => {
    if (lightRef) {
      const light = activeLightRef.current;
      if (light) {
        groupRef.current.getWorldPosition(playerLightWorldPositionRef.current);
        light.position.set(
          playerLightWorldPositionRef.current.x,
          playerLightWorldPositionRef.current.y + PLAYER_LIGHT_HEIGHT_OFFSET,
          playerLightWorldPositionRef.current.z,
        );
      }
    }

    const { actionState: playerActionState, animation: playerAnimation, health: playerHealth } = getRuntimeData();
    const isDead = playerHealth?.isDead ?? false;
    const dt = Math.min(delta, 0.1);
    mixer?.update(dt);
    visualModelRef.current?.position.set(0, characterConfig.yOffset, 0);

    playRemoteOneShotAnimation({
      animationNames: ACTION_ANIMATION_NAMES,
      animations,
      capabilities: characterConfig.capabilities,
      currentAnimationRef,
      isLocalPlayer,
      lastPlayedAttackSeqRef,
      oneShotAnimationRef,
      playerAnimation,
    });

    let shouldHandleRemoteDrinking = true;
    if (
      !isLocalPlayer &&
      playerAnimation &&
      (
        lastHandledDrinkingSeqRef.current === null ||
        playerAnimation.attackSeq < lastHandledDrinkingSeqRef.current
      )
    ) {
      lastHandledDrinkingSeqRef.current = playerAnimation.attackSeq;
      shouldHandleRemoteDrinking = false;
    }

    if (
      shouldHandleRemoteDrinking &&
      !isLocalPlayer &&
      playerAnimation?.activeAnimation === ANIMATIONS.DRINKING &&
      lastHandledDrinkingSeqRef.current !== null &&
      playerAnimation.attackSeq > lastHandledDrinkingSeqRef.current
    ) {
      lastHandledDrinkingSeqRef.current = playerAnimation.attackSeq;
      const drinkingDurationMs = (
        (animations[ANIMATIONS.DRINKING]?.getClip()?.duration ?? 1.4) * 1000
      ) / DRINKING_ANIMATION_TIME_SCALE;
      showPotionDuringDrinking(drinkingDurationMs);
      groupRef.current.getWorldPosition(drinkingSoundPositionRef.current);
      playWorldSound('potion_drinking', drinkingSoundPositionRef.current).catch(() => {});
    }

    if (
      playerActionState?.currentAction === 'idle' &&
      playerActionState?.canAttack &&
      playerActionState?.canBlock
    ) {
      if (actionRequestLockedUntilRef) {
        actionRequestLockedUntilRef.current = 0;
      }
    }

    nameplateRef.current?.updateHealth(playerHealth);

    let movingForAnimation = false;
    let sprintingForAnimation = false;
    let airborneForAnimation = false;
    let movementAnimationDirection = movementAnimationDirectionRef.current;

    if (isLocalPlayer) {
      if (!currentInputRef || !latestTransformsRef || !latestInputAcksRef || !metricsRef) return;
      const localFrame = localFrameRuntime?.runFrame({
        currentInput: currentInputRef.current,
        deltaSeconds: dt,
        isDead,
        jumpAnimationDurationMs: (animations[ANIMATIONS.JUMP]?.getClip()?.duration ?? 0.8) * 1000,
        latestTransform: latestTransformsRef.current.get(identityKey),
        latestInputAck: latestInputAcksRef.current.get(identityKey),
        metrics: metricsRef.current,
      });
      if (!localFrame) return;

      movingForAnimation = localFrame.movingForAnimation;
      sprintingForAnimation = localFrame.sprintingForAnimation;
      airborneForAnimation = localFrame.airborneForAnimation;
      movementAnimationDirection = localFrame.movementAnimationDirection;
      movementAnimationDirectionRef.current = movementAnimationDirection;
    } else {
      const remoteFrame = remoteFrameRuntime?.runFrame(movementAnimationDirection);

      if (remoteFrame) {
        movingForAnimation = remoteFrame.movingForAnimation;
        sprintingForAnimation = remoteFrame.sprintingForAnimation;
        airborneForAnimation = remoteFrame.airborneForAnimation;
        movementAnimationDirection = remoteFrame.movementAnimationDirection;
        movementAnimationDirectionRef.current = movementAnimationDirection;
      }
    }

    const visualOrigin = spellCasterVisualOriginsRef.current.get(identityKey);
    const rotationY = isLocalPlayer
      ? (localFrameRuntime?.localRotationYRef.current ?? groupRef.current.rotation.y)
      : groupRef.current.rotation.y - Math.PI;
    if (visualOrigin) {
      visualOrigin.position.copy(groupRef.current.position);
      visualOrigin.rotationY = rotationY;
    } else {
      spellCasterVisualOriginsRef.current.set(identityKey, {
        position: visualOriginPositionRef.current.copy(groupRef.current.position).clone(),
        rotationY,
      });
    }

    const targetAnim = selectTargetAnimation({
      animationNames: ACTION_ANIMATION_NAMES,
      animations,
      airborneForAnimation,
      isDead,
      isLocalPlayer,
      jumpAnimationUntil: localFrameRuntime?.jumpAnimationUntilRef.current ?? 0,
      movingForAnimation,
      movementAnimationDirection,
      movementAnimationNames: MOVEMENT_ANIMATION_NAMES,
      oneShotAnimationRef,
      playerActionState,
      sprintingForAnimation,
    });

    const footstepsEnabled = characterConfig.footstepSounds != null;
    updateLoopingAudio(
      walkFootstepsRef.current,
      !isDead && footstepsEnabled && FOOTSTEP_WALK_ANIMATIONS.has(targetAnim),
      walkFootstepsPlayingRef,
      walkFootstepsStartTimeoutRef,
      FOOTSTEPS_START_DELAY_MS,
    );
    updateLoopingAudio(
      runFootstepsRef.current,
      !isDead && footstepsEnabled && FOOTSTEP_RUN_ANIMATIONS.has(targetAnim),
      runFootstepsPlayingRef,
      runFootstepsStartTimeoutRef,
      FOOTSTEPS_START_DELAY_MS,
    );

    applyTargetAnimation({
      animations,
      animationNames: ACTION_ANIMATION_NAMES,
      currentAnimationRef,
      forceRestartRef: localFrameRuntime?.forceAnimationRestartRef,
      targetAnimation: targetAnim,
    });
  });

  return (
    <>
      <group ref={groupRef}>
        {!modelLoaded && (
          <mesh position={[0, 1, 0]} castShadow>
            <boxGeometry args={[0.8, 2, 0.8]} />
            <meshStandardMaterial color={isLocalPlayer ? 'cyan' : 'orange'} />
          </mesh>
        )}

        {!lightRef && (
          <pointLight
            ref={fallbackLightRef}
            position={[0, PLAYER_LIGHT_HEIGHT_OFFSET, 0]}
            intensity={PLAYER_LIGHT_INTENSITY}
            color="white"
          />
        )}
        <PlayerNameplate
          ref={nameplateRef}
          initialHealth={getRuntimeData().health}
          username={playerData.username}
          isLocalPlayer={isLocalPlayer}
        />
      </group>

      {isLocalPlayer && characterConfig.capabilities.spells.length > 0 && localFrameRuntime && (
        <WizardTargetingVisuals runtime={localFrameRuntime} />
      )}
    </>
  );
});

function stopLoopingAudio(
  audio: THREE.Audio | THREE.PositionalAudio | null,
  wasPlayingRef: MutableRefObject<boolean>,
  startTimeoutRef: MutableRefObject<number | null>,
) {
  if (startTimeoutRef.current !== null) {
    window.clearTimeout(startTimeoutRef.current);
    startTimeoutRef.current = null;
  }
  if (audio?.isPlaying) audio.stop();
  wasPlayingRef.current = false;
}

function updateLoopingAudio(
  audio: THREE.Audio | THREE.PositionalAudio | null,
  shouldPlay: boolean,
  wasPlayingRef: MutableRefObject<boolean>,
  startTimeoutRef: MutableRefObject<number | null>,
  startDelayMs = 0,
) {
  if (!audio) return;

  if (shouldPlay) {
    if (!wasPlayingRef.current && startTimeoutRef.current === null) {
      startTimeoutRef.current = window.setTimeout(() => {
        startTimeoutRef.current = null;
        if (audio.isPlaying) audio.stop();
        audio.play();
        wasPlayingRef.current = true;
      }, startDelayMs);
    }
    return;
  }

  if (wasPlayingRef.current || startTimeoutRef.current !== null) {
    stopLoopingAudio(audio, wasPlayingRef, startTimeoutRef);
  }
}
