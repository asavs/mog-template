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
import { resolveBody, resolveMotion, resolveProp } from './resolve';
import { STANCES, STANCE_KEYS } from './stances';
import { applyGrip } from './sockets';
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
  const body = await resolveBody(BODY_KEYS.humanoid);
  expect(body).not.toBeNull();
  if (!body) throw new Error('unreachable');

  const stance = STANCES[stanceKey];
  const held = new Map<string, THREE.Object3D>();
  for (const slot of stance.slots) {
    const object = await resolveProp(slot.prop);
    expect(object, `${slot.prop} did not resolve`).not.toBeNull();
    if (!object) continue;
    applyGrip(object, slot.prop, slot.socket);
    body.bones[slot.socket].add(object);
    held.set(slot.prop, object);
  }

  if (stance.motion) {
    const clip = await resolveMotion(stance.motion);
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
      expect(await resolveMotion(stance.motion), `${stance.motion} unbound`).not.toBeNull();
    }
    expect(Object.values(MOTION_STANCE).length).toBeGreaterThan(0);
  });

  it('stands the staff roughly upright, tip toward the ground', async () => {
    const held = await posed(STANCE_KEYS.staff);
    const staff = held.get(PROP_KEYS.staff);
    expect(staff).toBeDefined();
    // Authoring frame: +Y is the tip. Carried like a walking staff, it points down.
    const shaft = worldAxis(staff as THREE.Object3D, new THREE.Vector3(0, 1, 0));
    expect(shaft.dot(UP)).toBeLessThan(-0.6);
  });

  it('presents the shield face away from the body, not edge-on across it', async () => {
    const held = await posed(STANCE_KEYS.swordShield);
    const shield = held.get(PROP_KEYS.shield);
    expect(shield).toBeDefined();
    // Authoring frame: +Z is the boss / outward face. A shield that is edge-on to
    // the threat is a plank through the torso, which is how this first read.
    const face = worldAxis(shield as THREE.Object3D, new THREE.Vector3(0, 0, 1));
    expect(face.dot(FORWARD)).toBeGreaterThan(0.5);
  });

  it('keeps the sword blade up and clear of the ribs', async () => {
    const held = await posed(STANCE_KEYS.swordShield);
    const sword = held.get(PROP_KEYS.sword);
    expect(sword).toBeDefined();
    const blade = worldAxis(sword as THREE.Object3D, new THREE.Vector3(0, 1, 0));
    expect(blade.dot(UP)).toBeGreaterThan(0.3);
  });
});
