import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import type { PlayerActionState, PlayerAnimation } from '../generated/types';
import { ATTACK_ANIMATION_TIME_SCALE } from '../combatTiming';
import { getCharacterCapabilities } from './characterConfig';
import type { MovementAnimationDirection } from './localPlayerFrame';

type AnimationNames = {
  idle: string;
  jump: string;
  slash: string;
  block: string;
  cast: string;
  drinking: string;
  death: string;
};

type OneShotAnimationState = {
  name: string;
  until: number;
};

type MovementAnimationNameOptions = {
  sprintActive: boolean;
  direction: MovementAnimationDirection;
  movementAnimationNames: {
    walk: string;
    walkBack: string;
    walkLeft: string;
    walkRight: string;
    run: string;
    runBack: string;
    runLeft: string;
    runRight: string;
  };
};

type RemoteOneShotOptions = {
  animationNames: AnimationNames;
  animations: Record<string, THREE.AnimationAction>;
  characterClass: string;
  currentAnimationRef: MutableRefObject<string>;
  isLocalPlayer: boolean;
  lastPlayedAttackSeqRef: MutableRefObject<number | null>;
  oneShotAnimationRef: MutableRefObject<OneShotAnimationState>;
  playerAnimation?: PlayerAnimation;
};

type SelectTargetAnimationOptions = {
  animationNames: AnimationNames;
  animations: Record<string, THREE.AnimationAction>;
  airborneForAnimation: boolean;
  isDead: boolean;
  isLocalPlayer: boolean;
  jumpAnimationUntil: number;
  movingForAnimation: boolean;
  movementAnimationDirection: MovementAnimationDirection;
  movementAnimationNames: MovementAnimationNameOptions['movementAnimationNames'];
  oneShotAnimationRef: MutableRefObject<OneShotAnimationState>;
  playerActionState?: PlayerActionState;
  sprintingForAnimation: boolean;
};

type ApplyTargetAnimationOptions = {
  animations: Record<string, THREE.AnimationAction>;
  animationNames: AnimationNames;
  currentAnimationRef: MutableRefObject<string>;
  forceRestartRef?: MutableRefObject<string | null>;
  targetAnimation: string;
};

export const DRINKING_ANIMATION_TIME_SCALE = 2;
const DRINKING_ANIMATION_FADE_SECONDS = 0.2;

export function triggerOneShotAnimation(
  animations: Record<string, THREE.AnimationAction>,
  currentAnimationRef: MutableRefObject<string>,
  animationName: string,
  oneShotAnimationRef: MutableRefObject<OneShotAnimationState>,
  animationNames: Pick<AnimationNames, 'slash' | 'cast' | 'drinking'>,
) {
  const action = animations[animationName];
  if (!action) return;

  const timeScale = animationTimeScale(animationName, animationNames);
  const fadeSeconds = animationName === animationNames.drinking
    ? DRINKING_ANIMATION_FADE_SECONDS
    : 0.08;

  animations[currentAnimationRef.current]?.fadeOut(fadeSeconds);
  action.reset().setEffectiveTimeScale(timeScale).fadeIn(fadeSeconds).play();
  currentAnimationRef.current = animationName;
  oneShotAnimationRef.current = {
    name: animationName,
    until: performance.now() + (action.getClip().duration * 1000) / timeScale,
  };
}

export function configureAnimationPlayback(
  animationName: string,
  action: THREE.AnimationAction,
  animationNames: AnimationNames,
) {
  if (
    animationName === animationNames.jump ||
    animationName === animationNames.slash ||
    animationName === animationNames.block ||
    animationName === animationNames.cast ||
    animationName === animationNames.drinking ||
    animationName === animationNames.death
  ) {
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    return;
  }

  action.setLoop(THREE.LoopRepeat, Infinity);
  action.clampWhenFinished = false;
}

export function playRemoteOneShotAnimation({
  animationNames,
  animations,
  characterClass,
  currentAnimationRef,
  isLocalPlayer,
  lastPlayedAttackSeqRef,
  oneShotAnimationRef,
  playerAnimation,
}: RemoteOneShotOptions) {
  if (isLocalPlayer || !playerAnimation) return;

  if (
    lastPlayedAttackSeqRef.current === null ||
    playerAnimation.attackSeq < lastPlayedAttackSeqRef.current
  ) {
    lastPlayedAttackSeqRef.current = playerAnimation.attackSeq;
    return;
  }

  const capabilities = getCharacterCapabilities(characterClass);
  const activeAnimation = playerAnimation.activeAnimation;
  const canPlayOneShot =
    (activeAnimation === animationNames.slash && capabilities.melee) ||
    (activeAnimation === animationNames.cast && capabilities.spells.length > 0) ||
    (activeAnimation === animationNames.drinking && capabilities.drinkPotion);

  if (canPlayOneShot && playerAnimation.attackSeq > lastPlayedAttackSeqRef.current) {
    lastPlayedAttackSeqRef.current = playerAnimation.attackSeq;
    triggerOneShotAnimation(
      animations,
      currentAnimationRef,
      activeAnimation,
      oneShotAnimationRef,
      animationNames,
    );
  }
}

export function selectTargetAnimation({
  animationNames,
  animations,
  airborneForAnimation,
  isDead,
  isLocalPlayer,
  jumpAnimationUntil,
  movingForAnimation,
  movementAnimationDirection,
  movementAnimationNames,
  oneShotAnimationRef,
  playerActionState,
  sprintingForAnimation,
}: SelectTargetAnimationOptions): string {
  if (isDead && animations[animationNames.death]) {
    return animationNames.death;
  }

  if (
    performance.now() < oneShotAnimationRef.current.until &&
    animations[oneShotAnimationRef.current.name]
  ) {
    return oneShotAnimationRef.current.name;
  }

  if (playerActionState?.currentAction === 'attacking' && animations[animationNames.slash]) {
    return animationNames.slash;
  }

  if (playerActionState?.currentAction === 'blocking' && animations[animationNames.block]) {
    return animationNames.block;
  }

  if (
    (airborneForAnimation || (isLocalPlayer && performance.now() < jumpAnimationUntil)) &&
    animations[animationNames.jump]
  ) {
    return animationNames.jump;
  }

  if (movingForAnimation) {
    return getMovementAnimationName({
      sprintActive: sprintingForAnimation,
      direction: movementAnimationDirection,
      movementAnimationNames,
    });
  }

  return animationNames.idle;
}

export function applyTargetAnimation({
  animations,
  animationNames,
  currentAnimationRef,
  forceRestartRef,
  targetAnimation,
}: ApplyTargetAnimationOptions) {
  const forceRestart = forceRestartRef?.current === targetAnimation;
  if ((targetAnimation !== currentAnimationRef.current || forceRestart) && animations[targetAnimation]) {
    const action = animations[targetAnimation];
    configureAnimationPlayback(targetAnimation, action, animationNames);
    if (targetAnimation !== currentAnimationRef.current) {
      animations[currentAnimationRef.current]?.fadeOut(0.2);
      action
        .reset()
        .setEffectiveTimeScale(animationTimeScale(targetAnimation, animationNames))
        .fadeIn(0.2)
        .play();
    } else {
      action
        .reset()
        .setEffectiveTimeScale(animationTimeScale(targetAnimation, animationNames))
        .play();
    }
    currentAnimationRef.current = targetAnimation;
    if (forceRestart && forceRestartRef) {
      forceRestartRef.current = null;
    }
  }
}

function animationTimeScale(
  animationName: string,
  animationNames: Pick<AnimationNames, 'slash' | 'cast'> & Partial<Pick<AnimationNames, 'drinking'>>,
) {
  if (animationNames.drinking && animationName === animationNames.drinking) {
    return DRINKING_ANIMATION_TIME_SCALE;
  }
  return animationName === animationNames.slash || animationName === animationNames.cast
    ? ATTACK_ANIMATION_TIME_SCALE
    : 1;
}

function getMovementAnimationName({
  sprintActive,
  direction,
  movementAnimationNames,
}: MovementAnimationNameOptions): string {
  if (sprintActive) {
    if (direction === 'back') return movementAnimationNames.runBack;
    if (direction === 'left') return movementAnimationNames.runLeft;
    if (direction === 'right') return movementAnimationNames.runRight;
    return movementAnimationNames.run;
  }

  if (direction === 'back') return movementAnimationNames.walkBack;
  if (direction === 'left') return movementAnimationNames.walkLeft;
  if (direction === 'right') return movementAnimationNames.walkRight;
  return movementAnimationNames.walk;
}
