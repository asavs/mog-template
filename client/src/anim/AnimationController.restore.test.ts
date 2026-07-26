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
import { maskClipToBands, maskClipToOverlay } from './mask';

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

    // Ask for the action the controller actually plays. It never plays the
    // unmasked clip — only the per-band clips derived from it — so querying by
    // the source clip finds nothing, and `clipAction` would quietly mint a dead
    // action to hand back.
    // `armL`, because that is the only upper band this fixture animates — the
    // clip drives LeftUpperArm and LeftUpperLeg and nothing else.
    const upperAction = controller.mixer.existingAction(
      maskClipToBands(clips.get('loco')!, ['armL']),
    );

    const state = controller.getState();
    expect(state.overlayMotion).toBeNull();
    expect(state.baseMotion).toBe('loco');

    // The overlay is done, so the base upper band must be driving again — and
    // driving audibly, not merely scheduled. Both halves matter: the bug being
    // guarded leaves the action running at zero weight forever.
    expect(upperAction?.isRunning()).toBe(true);
    expect(upperAction?.getEffectiveWeight() ?? 0).toBeGreaterThan(0.9);
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

  it('is audible again once a full-body override that interrupted it finishes', () => {
    // The other path into the same bug: the overlay is never explicitly
    // re-fired. It sits untouched behind a full-body override the whole time,
    // and only `syncBands` noticing the override is gone is what's supposed to
    // bring it back — the exact mechanism the T-pose fix depends on.
    const clips = new Map([
      ['loco', clip('loco', 2)],
      ['overlayAbility', clip('overlayAbility', 2)],
      ['fullBodyAbility', clip('fullBodyAbility', 0.3)],
    ]);
    const controller = new AnimationController(rig(), key => clips.get(key) ?? null);

    expect(controller.setLocomotion('loco')).toBe(true);
    advance(controller, 0.3);
    expect(controller.playAbility('overlayAbility', { upperBodyOnly: true })).toBe(true);
    advance(controller, 0.1);

    // Same door gameplay uses to let one ability's motion supersede another.
    controller.enterAbilityRecovery();
    expect(controller.playAbility('fullBodyAbility', { upperBodyOnly: false })).toBe(true);
    expect(controller.getState().overlayMotion).toBe('overlayAbility');
    expect(controller.getState().overrideMotion).toBe('fullBodyAbility');

    // Past the override's own duration, its exit blend, and the overlay's
    // fade back in — all without any further explicit call.
    advance(controller, 1.5);

    const state = controller.getState();
    expect(state.overrideMotion).toBeNull();
    expect(state.overlayMotion).toBe('overlayAbility');

    const overlayAction = controller.mixer.existingAction(
      maskClipToOverlay(clips.get('overlayAbility')!, 'torso'),
    );
    expect(overlayAction?.isRunning()).toBe(true);
    expect(overlayAction?.getEffectiveWeight() ?? 0).toBeGreaterThan(0.9);
  });
});
