import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MOG_BONES } from '../avatar/rig';
import { AnimationController } from './AnimationController';
import { MOTION_RULES } from './config';
import { ALL_BANDS, maskClipToBands } from './mask';

/** One track per vertical band — see `mask.ts`. The arms stay empty. */
function testClip(name: string, duration = 1): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, [
    new THREE.VectorKeyframeTrack(
      `${MOG_BONES.spine2}.position`,
      [0, duration],
      [0, 0, 0, 1, 0, 0],
    ),
    new THREE.VectorKeyframeTrack(
      `${MOG_BONES.spine}.position`,
      [0, duration],
      [0, 0, 0, 1, 0, 0],
    ),
    new THREE.VectorKeyframeTrack(
      `${MOG_BONES.leftUpperLeg}.position`,
      [0, duration],
      [0, 0, 0, 1, 0, 0],
    ),
  ]);
}

function root(): THREE.Group {
  const value = new THREE.Group();
  const chest = new THREE.Bone();
  chest.name = MOG_BONES.spine2;
  const spine = new THREE.Bone();
  spine.name = MOG_BONES.spine;
  const leg = new THREE.Bone();
  leg.name = MOG_BONES.leftUpperLeg;
  value.add(chest, spine, leg);
  return value;
}

describe('AnimationController lifecycle', () => {
  it('lets gameplay open recovery interruption for full-body abilities', () => {
    const first = testClip('drink');
    const second = testClip('drink_again');
    const controller = new AnimationController(
      root(),
      (key) => [first, second].find((value) => value.name === key) ?? null,
    );

    expect(controller.playAbility('drink', { upperBodyOnly: false })).toBe(true);
    expect(controller.playAbility('drink_again', { upperBodyOnly: false })).toBe(false);

    controller.enterAbilityRecovery();

    expect(controller.playAbility('drink_again', { upperBodyOnly: false })).toBe(true);
    expect(controller.getState()).toMatchObject({
      overrideMotion: 'drink_again',
      abilityInRecovery: false,
    });
  });

  it('applies the recovery gate when the next ability changes layers', () => {
    const cast = testClip('cast');
    const drink = testClip('drink');
    const controller = new AnimationController(
      root(),
      (key) => [cast, drink].find((value) => value.name === key) ?? null,
    );

    controller.playAbility('cast');
    expect(controller.playAbility('drink', { upperBodyOnly: false })).toBe(false);
    controller.enterAbilityRecovery();
    expect(controller.playAbility('drink', { upperBodyOnly: false })).toBe(true);

    controller.enterAbilityRecovery();
    expect(controller.playAbility('cast')).toBe(true);
    expect(controller.getState()).toMatchObject({
      overlayMotion: 'cast',
      overrideMotion: null,
    });
  });

  it('advances a changed base motion silently while a full-body override owns the pose', () => {
    const idle = testClip('idle', 2);
    const walk = testClip('walk_forward', 2);
    const jump = testClip('jump', 1);
    const clips = [idle, walk, jump];
    const controller = new AnimationController(
      root(),
      (key) => clips.find((value) => value.name === key) ?? null,
    );

    controller.setLocomotion('idle');
    controller.playJump();
    controller.update(MOTION_RULES.jump.enterBlendSeconds);
    expect(controller.setLocomotion('walk_forward')).toBe(true);
    controller.update(0.25);

    // Every band the gait drives must advance together, or the layers desync
    // while the override hides them and snap apart when it lets go.
    const banded = ALL_BANDS
      .map(band => controller.mixer.existingAction(maskClipToBands(walk, [band])))
      .filter((action): action is THREE.AnimationAction => action !== undefined && action !== null);

    expect(banded.length).toBeGreaterThan(1);
    for (const action of banded) {
      expect(action.time).toBeCloseTo(banded[0].time);
      expect(action.getEffectiveWeight()).toBe(0);
    }
  });
});
