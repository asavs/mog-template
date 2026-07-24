/**
 * Guard is the only held input that owns a layer, so it is the only one that can
 * receive a new press while it is still letting go of the last one. Every case
 * here is "the player changed their mind mid-transition", which is a thing
 * players do constantly and a thing state machines forget to allow.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MOG_BONES } from '../avatar/rig';
import { AnimationController } from './AnimationController';

function clip(name: string, duration: number): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, [
    new THREE.VectorKeyframeTrack(
      `${MOG_BONES.spine2}.position`,
      [0, duration],
      [0, 0, 0, 1, 0, 0],
    ),
  ]);
}

function rig(): THREE.Object3D {
  const root = new THREE.Group();
  for (const name of [MOG_BONES.spine2, MOG_BONES.spine, MOG_BONES.leftUpperLeg]) {
    const bone = new THREE.Bone();
    bone.name = name;
    root.add(bone);
  }
  return root;
}

const CLIPS = [
  clip('loco', 1),
  clip('guard_enter', 0.2),
  clip('guard_held', 0.3),
  clip('guard_exit', 0.25),
  clip('jump', 0.1),
];

function controllerWithGuard(): AnimationController {
  const byName = new Map(CLIPS.map(value => [value.name, value]));
  return new AnimationController(rig(), key => byName.get(key) ?? null);
}

function settle(controller: AnimationController, seconds: number): void {
  const step = 1 / 120;
  for (let elapsed = 0; elapsed < seconds; elapsed += step) controller.update(step);
}

/** Drive up to a steady guard hold. */
function holdGuard(controller: AnimationController): void {
  controller.setLocomotion('loco');
  controller.setGuard(true);
  settle(controller, 0.5);
  expect(controller.getState().overlayMotion).toBe('guard_held');
}

describe('guard, when the player changes their mind mid-transition', () => {
  it('re-enters guard when pressed again during the exit blend', () => {
    const controller = controllerWithGuard();
    holdGuard(controller);

    controller.setGuard(false);
    expect(controller.getState().overlayMotion).toBe('guard_exit');

    // Released and immediately pressed again, well before the exit finishes.
    settle(controller, 0.05);
    controller.setGuard(true);
    settle(controller, 0.6);

    expect(controller.getState().overlayMotion).toBe('guard_held');
  });

  it('does not restart the exit when release is reported twice', () => {
    const controller = controllerWithGuard();
    holdGuard(controller);

    expect(controller.setGuard(false)).toBe(true);
    settle(controller, 0.1);
    const partway = controller.mixer.time;

    // A second release changes nothing, so the exit must keep its progress.
    expect(controller.setGuard(false)).toBe(false);
    settle(controller, 0.05);
    expect(controller.mixer.time).toBeGreaterThan(partway);
    expect(controller.getState().overlayMotion).toBe('guard_exit');
  });

  it('restores guard after a full-body override if it was re-pressed mid-exit', () => {
    const controller = controllerWithGuard();
    holdGuard(controller);

    controller.setGuard(false);
    settle(controller, 0.05);
    controller.playJump('jump');
    // Pressed again while airborne, with the exit still the live overlay.
    controller.setGuard(true);
    settle(controller, 1.2);

    expect(controller.getState().overrideMotion).toBeNull();
    expect(controller.getState().overlayMotion).toBe('guard_held');
  });

  it('still ends in no guard when the player really did let go', () => {
    const controller = controllerWithGuard();
    holdGuard(controller);

    controller.setGuard(false);
    settle(controller, 0.6);

    expect(controller.getState().overlayMotion).toBeNull();
  });
});
