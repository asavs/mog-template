import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MOG_BONES } from '../content/rig';
import { AnimationController, type MotionResolver } from './AnimationController';
import { MOTION_RULES } from './config';
import { maskClipToBands, maskClipToOverlay } from './mask';

/**
 * One bone per band, so a test can tell "the overlay took the chest" apart from
 * "the overlay took the whole torso". See `mask.ts` for the band split.
 */
type TestRig = {
  root: THREE.Group;
  /** `upper` band. */
  chest: THREE.Bone;
  /** `mid` band. */
  spine: THREE.Bone;
  /** `lower` band. */
  leg: THREE.Bone;
};

function makeRig(): TestRig {
  const root = new THREE.Group();
  const chest = new THREE.Bone();
  chest.name = MOG_BONES.spine2;
  const spine = new THREE.Bone();
  spine.name = MOG_BONES.spine;
  const leg = new THREE.Bone();
  leg.name = MOG_BONES.leftUpperLeg;
  root.add(chest, spine, leg);
  return { root, chest, spine, leg };
}

function positionTrack(
  boneName: string,
  duration: number,
  endX: number,
): THREE.VectorKeyframeTrack {
  return new THREE.VectorKeyframeTrack(
    `${boneName}.position`,
    [0, duration],
    [0, 0, 0, endX, 0, 0],
  );
}

function clip(
  name: string,
  duration: number,
  tracks: readonly THREE.KeyframeTrack[],
): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, [...tracks]);
}

function resolverFor(clips: readonly THREE.AnimationClip[]): MotionResolver {
  const byName = new Map(clips.map((value) => [value.name, value]));
  return (key) => byName.get(key) ?? null;
}

function settle(controller: AnimationController, seconds: number): void {
  const step = 1 / 120;
  let elapsed = 0;
  while (elapsed < seconds) {
    const delta = Math.min(step, seconds - elapsed);
    controller.update(delta);
    elapsed += delta;
  }
}

describe('AnimationController', () => {
  it('runs locomotion legs and an upper-body ability on the same mixer', () => {
    const rig = makeRig();
    const walk = clip('walk_forward', 1, [
      positionTrack(MOG_BONES.spine2, 1, 2),
      positionTrack(MOG_BONES.leftUpperLeg, 1, 4),
    ]);
    const cast = clip('cast', 1, [
      positionTrack(MOG_BONES.spine2, 1, 10),
      positionTrack(MOG_BONES.leftUpperLeg, 1, 100),
    ]);
    const controller = new AnimationController(rig.root, resolverFor([walk, cast]));

    expect(controller.setLocomotion('walk_forward')).toBe(true);
    settle(controller, MOTION_RULES.locomotion.enterBlendSeconds);
    expect(controller.playAbility('cast')).toBe(true);
    settle(controller, MOTION_RULES.ability.enterBlendSeconds + 0.2);

    expect(controller.getState()).toMatchObject({
      baseMotion: 'walk_forward',
      overlayMotion: 'cast',
    });
    expect(rig.leg.position.x).toBeGreaterThan(0.5);
    expect(rig.leg.position.x).toBeLessThan(10);
    expect(rig.chest.position.x).toBeGreaterThan(1);
    expect(controller.mixer.existingAction(maskClipToBands(walk, ['lower']))?.isScheduled()).toBe(true);
    expect(controller.mixer.existingAction(maskClipToOverlay(cast, 'torso'))?.isScheduled()).toBe(true);
  });

  it('keeps a cast active when hit-react plays and retriggers hit instead of queuing', () => {
    const rig = makeRig();
    const cast = clip('cast', 2, [positionTrack(MOG_BONES.spine2, 2, 8)]);
    const hit = clip('react_hit', 0.4, [positionTrack(MOG_BONES.spine2, 0.4, -2)]);
    const controller = new AnimationController(rig.root, resolverFor([cast, hit]));

    expect(controller.playAbility('cast')).toBe(true);
    settle(controller, 0.1);
    const castAction = controller.mixer.existingAction(maskClipToOverlay(cast, 'torso'));
    expect(controller.playHitReaction()).toBe(true);
    settle(controller, 0.1);
    const firstHitTime = controller.mixer.existingAction(maskClipToOverlay(hit, 'torso'))?.time ?? 0;
    expect(controller.playHitReaction()).toBe(true);

    expect(controller.getState()).toMatchObject({
      overlayMotion: 'cast',
      hitMotion: 'react_hit',
    });
    expect(castAction?.isRunning()).toBe(true);
    expect(controller.mixer.existingAction(maskClipToOverlay(hit, 'torso'))?.time).toBeLessThan(firstHitTime);
  });

  it('only lets a new ability interrupt during the gameplay-declared recovery window', () => {
    const rig = makeRig();
    const cast = clip('cast', 1, [positionTrack(MOG_BONES.spine2, 1, 4)]);
    const melee = clip('melee', 1, [positionTrack(MOG_BONES.spine2, 1, -4)]);
    const controller = new AnimationController(rig.root, resolverFor([cast, melee]));

    expect(controller.playAbility('cast')).toBe(true);
    expect(controller.playAbility('melee')).toBe(false);
    expect(controller.getState().overlayMotion).toBe('cast');

    controller.enterAbilityRecovery();

    expect(controller.playAbility('melee')).toBe(true);
    expect(controller.getState()).toMatchObject({
      overlayMotion: 'melee',
      abilityInRecovery: false,
    });
  });

  it('transitions guard enter, held loop, and exit without changing clip speed', () => {
    const rig = makeRig();
    const guardEnter = clip('guard_enter', 0.2, [positionTrack(MOG_BONES.spine2, 0.2, 1)]);
    const guardHeld = clip('guard_held', 0.3, [positionTrack(MOG_BONES.spine2, 0.3, 2)]);
    const guardExit = clip('guard_exit', 0.25, [positionTrack(MOG_BONES.spine2, 0.25, 0)]);
    const controller = new AnimationController(
      rig.root,
      resolverFor([guardEnter, guardHeld, guardExit]),
    );

    expect(controller.setGuard(true)).toBe(true);
    settle(controller, 0.21);
    expect(controller.getState().overlayMotion).toBe('guard_held');
    const heldAction = controller.mixer.existingAction(maskClipToOverlay(guardHeld, 'arms'));
    expect(heldAction?.loop).toBe(THREE.LoopRepeat);
    expect(heldAction?.timeScale).toBe(1);

    expect(controller.setGuard(false)).toBe(true);
    expect(controller.getState().overlayMotion).toBe('guard_exit');
    settle(controller, 0.26);
    expect(controller.getState().overlayMotion).toBeNull();
  });

  it('uses a full-body ability when upperBodyOnly is false', () => {
    const rig = makeRig();
    const drink = clip('drink', 0.5, [
      positionTrack(MOG_BONES.spine2, 0.5, 3),
      positionTrack(MOG_BONES.leftUpperLeg, 0.5, 3),
    ]);
    const controller = new AnimationController(rig.root, resolverFor([drink]));

    expect(controller.playAbility('drink', { upperBodyOnly: false })).toBe(true);
    expect(controller.getState()).toMatchObject({
      overlayMotion: null,
      overrideMotion: 'drink',
    });
  });

  it('makes missing motions safe no-ops that do not disturb running layers', () => {
    const rig = makeRig();
    const idle = clip('idle', 1, [positionTrack(MOG_BONES.leftUpperLeg, 1, 1)]);
    const controller = new AnimationController(rig.root, resolverFor([idle]));

    expect(controller.setLocomotion('idle')).toBe(true);
    expect(controller.playAbility('missing')).toBe(false);
    expect(controller.playHitReaction('missing')).toBe(false);
    expect(controller.playDeath('missing')).toBe(false);
    expect(controller.playJump('missing')).toBe(false);
    expect(() => controller.update(0.1)).not.toThrow();
    expect(controller.getState()).toMatchObject({
      baseMotion: 'idle',
      overlayMotion: null,
      overrideMotion: null,
      dead: false,
    });
  });

  it('death suppresses all layers, rejects interruption, and clamps on its final frame', () => {
    const rig = makeRig();
    const walk = clip('walk_forward', 1, [
      positionTrack(MOG_BONES.spine2, 1, 2),
      positionTrack(MOG_BONES.leftUpperLeg, 1, 2),
    ]);
    const cast = clip('cast', 2, [positionTrack(MOG_BONES.spine2, 2, 10)]);
    const death = clip('react_death', 0.5, [
      positionTrack(MOG_BONES.spine2, 0.5, -5),
      positionTrack(MOG_BONES.leftUpperLeg, 0.5, -5),
    ]);
    const controller = new AnimationController(rig.root, resolverFor([walk, cast, death]));

    controller.setLocomotion('walk_forward');
    controller.playAbility('cast');
    expect(controller.playDeath()).toBe(true);
    settle(controller, 0.6);

    const deathAction = controller.mixer.existingAction(death);
    expect(controller.getState()).toEqual({
      baseMotion: null,
      stanceMotions: [],
      overlayMotion: null,
      hitMotion: null,
      overrideMotion: 'react_death',
      abilityInRecovery: false,
      dead: true,
    });
    expect(deathAction?.clampWhenFinished).toBe(true);
    expect(deathAction?.paused).toBe(true);
    expect(deathAction?.time).toBeCloseTo(death.duration);
    expect(rig.chest.position.x).toBeCloseTo(-5);
    expect(rig.leg.position.x).toBeCloseTo(-5);
    expect(controller.playAbility('cast')).toBe(false);
    expect(controller.playHitReaction()).toBe(false);
    expect(controller.playJump()).toBe(false);
    expect(controller.setLocomotion('walk_forward')).toBe(false);
    expect(controller.playDeath()).toBe(false);
  });

  it('honors the configured locomotion crossfade duration', () => {
    const rig = makeRig();
    const idle = clip('idle', 1, [positionTrack(MOG_BONES.leftUpperLeg, 1, 1)]);
    const walk = clip('walk_forward', 1, [positionTrack(MOG_BONES.leftUpperLeg, 1, 3)]);
    const controller = new AnimationController(rig.root, resolverFor([idle, walk]));

    controller.setLocomotion('idle');
    settle(controller, MOTION_RULES.locomotion.enterBlendSeconds);
    controller.setLocomotion('walk_forward');
    controller.update(MOTION_RULES.locomotion.enterBlendSeconds / 2);

    const idleAction = controller.mixer.existingAction(maskClipToBands(idle, ['lower']));
    const walkAction = controller.mixer.existingAction(maskClipToBands(walk, ['lower']));
    expect(idleAction?.getEffectiveWeight()).toBeCloseTo(0.5, 1);
    expect(walkAction?.getEffectiveWeight()).toBeCloseTo(0.5, 1);
    expect(MOTION_RULES.locomotion.enterBlendSeconds).toBeGreaterThanOrEqual(0.15);
    expect(MOTION_RULES.locomotion.enterBlendSeconds).toBeLessThanOrEqual(0.2);
  });
});
