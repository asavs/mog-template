/**
 * Stance and movement-width behaviour.
 *
 * These assert on BONE OUTPUT rather than controller state wherever the two
 * could disagree. A controller can believe it restored a layer and still be
 * rendering a T-pose — that is a bug this suite has already caught once, and
 * state-based assertions passed straight through it.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MOG_BONES } from '../avatar/rig';
import { AnimationController } from './AnimationController';
import { MOTION_RULES } from './config';

type TestRig = {
  root: THREE.Group;
  /** `upper` band — what a stance and an arms-width action drive. */
  chest: THREE.Bone;
  /** `mid` band — locomotion's, unless a rooted action claims it. */
  spine: THREE.Bone;
  /** `lower` band — always locomotion's. */
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

function track(boneName: string, duration: number, endX: number): THREE.VectorKeyframeTrack {
  return new THREE.VectorKeyframeTrack(
    `${boneName}.position`,
    [0, duration],
    [0, 0, 0, endX, 0, 0],
  );
}

/** Every band moves the same direction, so a sign flip means ownership changed. */
function fullBodyClip(name: string, duration: number, endX: number): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, [
    track(MOG_BONES.spine2, duration, endX),
    track(MOG_BONES.spine, duration, endX),
    track(MOG_BONES.leftUpperLeg, duration, endX),
  ]);
}

function resolverFor(clips: readonly THREE.AnimationClip[]) {
  const byName = new Map(clips.map(value => [value.name, value]));
  return (key: string) => byName.get(key) ?? null;
}

function settle(controller: AnimationController, seconds: number): void {
  const step = 1 / 120;
  let elapsed = 0;
  while (elapsed < seconds) {
    controller.update(Math.min(step, seconds - elapsed));
    elapsed += step;
  }
}

describe('movement width', () => {
  const walk = fullBodyClip('walk_forward', 1, 6);
  const action = fullBodyClip('act', 1, -60);

  it('gives a rooted action the lower spine, and leaves the legs alone', () => {
    const rig = makeRig();
    const controller = new AnimationController(rig.root, resolverFor([walk, action]));

    controller.setLocomotion('walk_forward');
    settle(controller, MOTION_RULES.locomotion.enterBlendSeconds);
    expect(controller.playAbility('act', { movement: 0 })).toBe(true);
    settle(controller, 0.4);

    expect(rig.chest.position.x).toBeLessThan(0);
    expect(rig.spine.position.x).toBeLessThan(0);
    // The legs keep walking even while rooted — being unable to move is a
    // gameplay fact, not a reason to freeze the pose.
    expect(rig.leg.position.x).toBeGreaterThan(0);
  });

  it('leaves the lower spine to the gait when the action permits movement', () => {
    const rig = makeRig();
    const controller = new AnimationController(rig.root, resolverFor([walk, action]));

    controller.setLocomotion('walk_forward');
    settle(controller, MOTION_RULES.locomotion.enterBlendSeconds);
    expect(controller.playAbility('act', { movement: 0.5 })).toBe(true);
    settle(controller, 0.4);

    expect(rig.chest.position.x).toBeLessThan(0);
    // This is the whole point: the walk's counter-rotation survives the action.
    expect(rig.spine.position.x).toBeGreaterThan(0);
    expect(rig.leg.position.x).toBeGreaterThan(0);
  });

  it('widens rather than vanishing when a narrow mask would empty the clip', () => {
    const rig = makeRig();
    // Authored only on the lower spine: nothing at all survives an arms mask.
    const spineOnly = new THREE.AnimationClip('act', 1, [track(MOG_BONES.spine, 1, -60)]);
    const controller = new AnimationController(rig.root, resolverFor([walk, spineOnly]));

    controller.setLocomotion('walk_forward');
    settle(controller, MOTION_RULES.locomotion.enterBlendSeconds);
    expect(controller.playAbility('act', { movement: 0.5 })).toBe(true);
    settle(controller, 0.4);

    expect(rig.spine.position.x).toBeLessThan(0);
  });
});

describe('stances', () => {
  const walk = fullBodyClip('walk_forward', 1, 6);
  // A held pose, constant across its loop, so assertions do not depend on which
  // phase of the stance's breathing cycle we happen to sample.
  const stance = new THREE.AnimationClip('stance_staff', 1, [
    new THREE.VectorKeyframeTrack(
      `${MOG_BONES.spine2}.position`,
      [0, 1],
      [-40, 0, 0, -40, 0, 0],
    ),
  ]);
  const action = fullBodyClip('act', 0.4, -60);

  it('replaces locomotion\'s upper body without touching the gait', () => {
    const rig = makeRig();
    const controller = new AnimationController(rig.root, resolverFor([walk, stance]));

    controller.setLocomotion('walk_forward');
    expect(controller.setStance('stance_staff')).toBe(true);
    settle(controller, 0.5);

    expect(controller.getState().stanceMotion).toBe('stance_staff');
    expect(rig.chest.position.x).toBeLessThan(0);
    expect(rig.spine.position.x).toBeGreaterThan(0);
    expect(rig.leg.position.x).toBeGreaterThan(0);
  });

  it('survives a gait change, because a stance is not a gait', () => {
    const rig = makeRig();
    const run = fullBodyClip('run_forward', 1, 12);
    const controller = new AnimationController(rig.root, resolverFor([walk, run, stance]));

    controller.setLocomotion('walk_forward');
    controller.setStance('stance_staff');
    settle(controller, 0.5);
    controller.setLocomotion('run_forward');
    settle(controller, 0.5);

    expect(controller.getState().stanceMotion).toBe('stance_staff');
    expect(rig.chest.position.x).toBeLessThan(0);
  });

  it('yields to an action and comes back afterwards', () => {
    const rig = makeRig();
    const controller = new AnimationController(rig.root, resolverFor([walk, stance, action]));

    controller.setLocomotion('walk_forward');
    controller.setStance('stance_staff');
    settle(controller, 0.5);
    const posed = rig.chest.position.x;

    expect(posed).toBeCloseTo(-40, 1);

    expect(controller.playAbility('act', { movement: 0 })).toBe(true);
    settle(controller, 0.3);
    // Mid-action the chest is driven past where the stance holds it.
    expect(rig.chest.position.x).toBeLessThan(posed);

    settle(controller, 1);
    expect(controller.getState().overlayMotion).toBeNull();
    expect(rig.chest.position.x).toBeCloseTo(posed, 1);
  });

  it('drops back to the plain upper body when cleared', () => {
    const rig = makeRig();
    const controller = new AnimationController(rig.root, resolverFor([walk, stance]));

    controller.setLocomotion('walk_forward');
    controller.setStance('stance_staff');
    settle(controller, 0.5);
    expect(controller.setStance(null)).toBe(true);
    settle(controller, 0.5);

    expect(controller.getState().stanceMotion).toBeNull();
    expect(rig.chest.position.x).toBeGreaterThan(0);
  });

  it('degrades to no stance when the pose has no clip, and never blocks the loadout', () => {
    const rig = makeRig();
    const controller = new AnimationController(rig.root, resolverFor([walk, stance]));

    controller.setLocomotion('walk_forward');
    controller.setStance('stance_staff');
    settle(controller, 0.5);

    expect(controller.setStance('stance.not_authored_yet')).toBe(true);
    settle(controller, 0.5);
    expect(controller.getState().stanceMotion).toBeNull();
    // Falling back must be visible motion, not the rest pose.
    expect(rig.chest.position.x).toBeGreaterThan(0);
  });
});
