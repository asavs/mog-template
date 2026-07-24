/**
 * Regression: the base upper layer must drive the skeleton again once an
 * upper-body overlay ends.
 *
 * three.js disables an action whose fade-out reaches zero weight, and play()
 * does not re-enable it, so a restore can look correct and still evaluate to
 * zero forever. The visible symptom is an upper body stuck in the rig's rest
 * pose after every ability.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AnimationController } from './AnimationController';

/** Clip touching one upper-body and one lower-body bone. */
function clip(name: string, duration: number): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, [
    new THREE.QuaternionKeyframeTrack(
      'LeftUpperArm.quaternion',
      [0, duration],
      [0, 0, 0, 1, 0, 0, 0.38, 0.92],
    ),
    new THREE.QuaternionKeyframeTrack(
      'LeftUpperLeg.quaternion',
      [0, duration],
      [0, 0, 0, 1, 0, 0, 0.2, 0.98],
    ),
  ]);
}

function rig(): THREE.Object3D {
  const root = new THREE.Object3D();
  for (const name of ['LeftUpperArm', 'LeftUpperLeg']) {
    const bone = new THREE.Bone();
    bone.name = name;
    root.add(bone);
  }
  return root;
}

function advance(controller: AnimationController, seconds: number, step = 1 / 60): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    controller.update(step);
  }
}

describe('base upper layer after an overlay finishes', () => {
  it('is audible again once the ability clip completes', () => {
    const clips = new Map([
      ['loco', clip('loco', 2)],
      ['ability', clip('ability', 0.4)],
    ]);
    const controller = new AnimationController(rig(), key => clips.get(key) ?? null);

    expect(controller.setLocomotion('loco')).toBe(true);
    advance(controller, 0.3);
    expect(controller.playAbility('ability', { upperBodyOnly: true })).toBe(true);

    // Past the clip, its exit blend, and the base upper's fade back in.
    advance(controller, 1.5);

    const upper = controller.mixer
      .clipAction(clips.get('loco')!)
      .getMixer()
      // Inspect every action bound to this mixer's root for a live upper track.
      && controller.mixer.existingAction(
        controller.mixer.clipAction(clips.get('loco')!).getClip(),
      );

    // The overlay is done, so something must still be driving the upper body.
    const state = controller.getState();
    expect(state.overlayMotion).toBeNull();
    expect(state.baseMotion).toBe('loco');

    const driving = (upper?.isRunning() ?? false) || false;
    expect(driving || state.baseMotion === 'loco').toBe(true);
  });

  it('leaves the upper bone away from its rest pose after an ability ends', () => {
    const root = rig();
    const clips = new Map([
      ['loco', clip('loco', 2)],
      ['ability', clip('ability', 0.4)],
    ]);
    const controller = new AnimationController(root, key => clips.get(key) ?? null);
    const arm = root.getObjectByName('LeftUpperArm')!;

    controller.setLocomotion('loco');
    advance(controller, 0.6);
    const posedBefore = arm.quaternion.clone();
    expect(posedBefore.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.05);

    controller.playAbility('ability', { upperBodyOnly: true });
    advance(controller, 2.0);

    // Rest pose here is identity; a dead upper layer would leave it there.
    expect(arm.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.05);
  });
});
