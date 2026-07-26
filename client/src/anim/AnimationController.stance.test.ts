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
import { MOG_BONES } from '../content/rig';
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

    expect(controller.getState().stanceMotions).toEqual(['stance_staff']);
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

    expect(controller.getState().stanceMotions).toEqual(['stance_staff']);
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

    expect(controller.getState().stanceMotions).toEqual([]);
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
    expect(controller.getState().stanceMotions).toEqual([]);
    // Falling back must be visible motion, not the rest pose.
    expect(rig.chest.position.x).toBeGreaterThan(0);
  });
});

/**
 * Composed stances: one held pose built from more than one clip.
 *
 * This exists because no clip in the library is sword-and-board. `Idle_Shield_Loop`
 * raises the left arm and leaves the right within thirteen degrees of plain idle,
 * so a sword in that untouched hand intersects the shield. The fix is to take
 * each arm from the clip that actually poses it.
 */
describe('composed stances', () => {
  type ArmRig = {
    root: THREE.Group;
    chest: THREE.Bone;
    leftArm: THREE.Bone;
    rightArm: THREE.Bone;
    leg: THREE.Bone;
  };

  function armRig(): ArmRig {
    const root = new THREE.Group();
    const bones = [
      MOG_BONES.spine2,
      MOG_BONES.leftUpperArm,
      MOG_BONES.rightUpperArm,
      MOG_BONES.leftUpperLeg,
    ].map(name => {
      const bone = new THREE.Bone();
      bone.name = name;
      return bone;
    });
    root.add(...bones);
    return { root, chest: bones[0], leftArm: bones[1], rightArm: bones[2], leg: bones[3] };
  }

  /** Poses BOTH arms and the shared axis, so which one wins is the assertion. */
  function heldPose(name: string, x: number): THREE.AnimationClip {
    const hold = (bone: string) =>
      new THREE.VectorKeyframeTrack(`${bone}.position`, [0, 1], [x, 0, 0, x, 0, 0]);
    return new THREE.AnimationClip(name, 1, [
      hold(MOG_BONES.spine2),
      hold(MOG_BONES.leftUpperArm),
      hold(MOG_BONES.rightUpperArm),
    ]);
  }

  const gait = new THREE.AnimationClip('walk_forward', 1, [
    track(MOG_BONES.spine2, 1, 6),
    track(MOG_BONES.leftUpperArm, 1, 6),
    track(MOG_BONES.rightUpperArm, 1, 6),
    track(MOG_BONES.leftUpperLeg, 1, 6),
  ]);
  const shield = heldPose('stance_shield', -40);
  const sword = heldPose('stance_sword', 90);

  const swordAndBoard = [
    { motion: 'stance_shield', bands: ['core', 'armL'] },
    { motion: 'stance_sword', bands: ['armR'] },
  ] as const;

  it('takes each arm from the clip that poses it', () => {
    const rig = armRig();
    const controller = new AnimationController(rig.root, resolverFor([gait, shield, sword]));

    controller.setLocomotion('walk_forward');
    expect(controller.setStance(swordAndBoard)).toBe(true);
    settle(controller, 0.5);

    expect(controller.getState().stanceMotions).toEqual(['stance_shield', 'stance_sword']);
    // Both source clips drive both arms; only the masking decides which lands
    // where. Opposite signs prove the arms are separately owned.
    expect(rig.leftArm.position.x).toBeCloseTo(-40, 1);
    expect(rig.rightArm.position.x).toBeCloseTo(90, 1);
    // The shared axis went with the shield, and the legs are still walking.
    expect(rig.chest.position.x).toBeCloseTo(-40, 1);
    expect(rig.leg.position.x).toBeGreaterThan(0);
  });

  it('leaves an unposed arm to the gait rather than to the rest pose', () => {
    const rig = armRig();
    // The sword pose has no clip: half the stance is missing art.
    const controller = new AnimationController(rig.root, resolverFor([gait, shield]));

    controller.setLocomotion('walk_forward');
    expect(controller.setStance(swordAndBoard)).toBe(true);
    settle(controller, 0.5);

    expect(controller.getState().stanceMotions).toEqual(['stance_shield']);
    expect(rig.leftArm.position.x).toBeCloseTo(-40, 1);
    // The right arm keeps swinging with the walk. Falling to zero here would be
    // the arm snapping to its bind pose, which is the failure worth catching.
    expect(rig.rightArm.position.x).toBeGreaterThan(0);
  });

  it('treats the same clips on opposite arms as a different stance', () => {
    const rig = armRig();
    const controller = new AnimationController(rig.root, resolverFor([gait, shield, sword]));

    controller.setLocomotion('walk_forward');
    controller.setStance(swordAndBoard);
    settle(controller, 0.5);

    // Same two motions, mirrored. Identity has to cover the bands, or this is a
    // no-op and the character keeps holding the shield in the wrong hand.
    expect(controller.setStance([
      { motion: 'stance_shield', bands: ['core', 'armR'] },
      { motion: 'stance_sword', bands: ['armL'] },
    ])).toBe(true);
    settle(controller, 0.5);

    expect(rig.leftArm.position.x).toBeCloseTo(90, 1);
    expect(rig.rightArm.position.x).toBeCloseTo(-40, 1);
  });

  it('holds a stance at one frame when the pose is a moment rather than a loop', () => {
    // Unarmed has no guard clip, so its stance is a punch recovery held at its
    // last frame. Threading `hold` from the stance data down to the clip is the
    // step that can silently not happen: the pose still resolves, it just plays
    // through and the hands come back down.
    const rig = armRig();
    // Ramps 0 -> 80, so playing it and holding its end are far apart.
    const arm = (bone: string) =>
      new THREE.VectorKeyframeTrack(`${bone}.position`, [0, 2], [0, 0, 0, 80, 0, 0]);
    const recovery = new THREE.AnimationClip('punch_rec', 2, [
      arm(MOG_BONES.leftUpperArm),
      arm(MOG_BONES.rightUpperArm),
    ]);
    const controller = new AnimationController(rig.root, resolverFor([gait, recovery]));

    controller.setLocomotion('walk_forward');
    expect(controller.setStance([
      { motion: 'punch_rec', bands: ['armL', 'armR'], hold: 'end' },
    ])).toBe(true);
    settle(controller, 0.6);
    expect(rig.leftArm.position.x).toBeCloseTo(80, 1);

    // And it stays. A stance playing through would be back near the foot of the
    // ramp by now, which is the guard dropping on its own.
    settle(controller, 2.5);
    expect(rig.leftArm.position.x).toBeCloseTo(80, 1);
    expect(rig.rightArm.position.x).toBeCloseTo(80, 1);
  });
});
