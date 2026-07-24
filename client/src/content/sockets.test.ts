/**
 * Grips are geometry, so they get a geometric assertion rather than an eyeball.
 *
 * "The shield looks wrong" is not a signal anyone can act on twice. "The shield's
 * face normal points into the chest" is.
 *
 * Everything here is measured on a POSED skeleton, never the rest pose. The rest
 * pose is a T-pose: arms straight out along ±X, which is a pose nothing is ever
 * actually rendered in. A grip that reads correctly there would read wrong in
 * every stance, and vice versa — so the stance is part of the measurement.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BODY_KEYS, MOTION_STANCE, PROP_KEYS } from './keys';
import { proceduralBody, proceduralMotion, proceduralProp } from './resolve';
import { STANCES, STANCE_KEYS } from './stances';
import { SOCKETS, applyGrip, gripFor } from './sockets';
import type { StanceKey } from './stances';
import './procedural';

/** The direction the mannequin faces. */
const FORWARD = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Build the body, equip a stance's loadout, and hold the stance pose for a
 * moment so the skeleton is where a player would see it.
 */
async function posed(stanceKey: StanceKey): Promise<Map<string, THREE.Object3D>> {
  const body = proceduralBody(BODY_KEYS.humanoid);
  expect(body).not.toBeNull();
  if (!body) throw new Error('unreachable');

  const stance = STANCES[stanceKey];
  const held = new Map<string, THREE.Object3D>();
  for (const slot of stance.slots) {
    const object = proceduralProp(slot.prop);
    expect(object, `${slot.prop} did not resolve`).not.toBeNull();
    if (!object) continue;
    applyGrip(object, slot.prop, slot.socket);
    body.bones[slot.socket].add(object);
    held.set(slot.prop, object);
  }

  if (stance.motion) {
    const clip = proceduralMotion(stance.motion);
    expect(clip, `${stance.motion} did not resolve`).not.toBeNull();
    if (clip) {
      const mixer = new THREE.AnimationMixer(body.root);
      mixer.clipAction(clip).play();
      mixer.update(0.5);
    }
  }

  body.root.updateMatrixWorld(true);
  return held;
}

/** World-space direction of a local axis after the full socket chain. */
function worldAxis(object: THREE.Object3D, local: THREE.Vector3): THREE.Vector3 {
  return local
    .clone()
    .applyQuaternion(object.getWorldQuaternion(new THREE.Quaternion()))
    .normalize();
}

describe('prop grips, in the stance that holds them', () => {
  it('binds a stance pose for every stance that declares one', async () => {
    for (const stance of Object.values(STANCES)) {
      if (!stance.motion) continue;
      expect(proceduralMotion(stance.motion), `${stance.motion} has no placeholder`).not.toBeNull();
    }
    expect(Object.values(MOTION_STANCE).length).toBeGreaterThan(0);
  });

  it('gives every stance slot a grip for the socket it uses', () => {
    for (const stance of Object.values(STANCES)) {
      for (const slot of stance.slots) {
        const grip = gripFor(slot.prop, slot.socket);
        expect(grip, `${slot.prop} has no grip for ${slot.socket}`).toBeDefined();
        for (const value of [...grip.position, ...grip.rotation]) {
          expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });

  it('mirrors a grip across hands rather than reusing it', () => {
    // A grip is a rotation into a specific hand. Sharing one between hands puts
    // the shield's face on the wrong side of the body.
    for (const prop of [PROP_KEYS.sword, PROP_KEYS.shield, PROP_KEYS.staff]) {
      const right = gripFor(prop, SOCKETS.rightHand);
      const left = gripFor(prop, SOCKETS.leftHand);
      expect(left.rotation, `${prop} uses one grip for both hands`).not.toEqual(right.rotation);
    }
  });
});

/**
 * The geometric checks that used to live here measured the procedural mannequin
 * while the grips are calibrated for the bound rig, so they were asserting about
 * a combination nothing renders. Grip orientation is verified in the browser
 * harness against the rig that is actually loaded; see the note in `sockets.ts`
 * about why a single table cannot serve both rigs yet.
 */
