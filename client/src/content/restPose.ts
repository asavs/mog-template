/**
 * Canonical rest pose for the `mog_humanoid` rig.
 *
 * `avatar/rig.ts` names the bones; this gives them proportions. Procedural
 * bodies are built from it, procedural motion is authored against it, and
 * imported art is retargeted onto it — so placeholder and real assets share one
 * skeleton and one scale.
 *
 * Units are world units (1 = 1 metre). Facing is +Z, character-left is +X.
 * The pose is a T-pose: arms extended along X, legs straight down.
 */

import type { RestPose } from './types';

/**
 * Matches `BODY_PRESENTATION.referenceHeight` in the avatar catalog, so
 * procedural and imported bodies normalize to the same size and every socket
 * offset, camera framing, and capsule stays valid across a content swap.
 */
const REFERENCE_HEIGHT = 2.0;

/** Mirror a left-side offset to the right side. */
function mirrored(offset: readonly [number, number, number]): readonly [number, number, number] {
  return [-offset[0], offset[1], offset[2]];
}

const LEFT_SHOULDER = [0.06, 0.13, 0] as const;
const LEFT_UPPER_ARM = [0.14, 0, 0] as const;
const LEFT_LOWER_ARM = [0.3, 0, 0] as const;
const LEFT_HAND = [0.27, 0, 0] as const;
const LEFT_UPPER_LEG = [0.1, -0.07, 0] as const;
const LEFT_LOWER_LEG = [0, -0.47, 0] as const;
const LEFT_FOOT = [0, -0.44, 0] as const;

export const MOG_REST_POSE: RestPose = {
  referenceHeight: REFERENCE_HEIGHT,
  parents: {
    hips: null,
    spine: 'hips',
    spine1: 'spine',
    spine2: 'spine1',
    neck: 'spine2',
    head: 'neck',
    leftShoulder: 'spine2',
    leftUpperArm: 'leftShoulder',
    leftLowerArm: 'leftUpperArm',
    leftHand: 'leftLowerArm',
    rightShoulder: 'spine2',
    rightUpperArm: 'rightShoulder',
    rightLowerArm: 'rightUpperArm',
    rightHand: 'rightLowerArm',
    leftUpperLeg: 'hips',
    leftLowerLeg: 'leftUpperLeg',
    leftFoot: 'leftLowerLeg',
    rightUpperLeg: 'hips',
    rightLowerLeg: 'rightUpperLeg',
    rightFoot: 'rightLowerLeg',
  },
  offsets: {
    // Root sits at hip height so the feet land on y=0.
    hips: [0, 1.09, 0],
    spine: [0, 0.11, 0],
    spine1: [0, 0.13, 0],
    spine2: [0, 0.13, 0],
    neck: [0, 0.18, 0],
    head: [0, 0.11, 0],
    leftShoulder: LEFT_SHOULDER,
    leftUpperArm: LEFT_UPPER_ARM,
    leftLowerArm: LEFT_LOWER_ARM,
    leftHand: LEFT_HAND,
    rightShoulder: mirrored(LEFT_SHOULDER),
    rightUpperArm: mirrored(LEFT_UPPER_ARM),
    rightLowerArm: mirrored(LEFT_LOWER_ARM),
    rightHand: mirrored(LEFT_HAND),
    leftUpperLeg: LEFT_UPPER_LEG,
    leftLowerLeg: LEFT_LOWER_LEG,
    leftFoot: LEFT_FOOT,
    rightUpperLeg: mirrored(LEFT_UPPER_LEG),
    rightLowerLeg: mirrored(LEFT_LOWER_LEG),
    rightFoot: mirrored(LEFT_FOOT),
  },
};

/** Bone ids in parent-before-child order, safe for skeleton construction. */
export const MOG_BONE_ORDER: readonly string[] = [
  'hips',
  'spine',
  'spine1',
  'spine2',
  'neck',
  'head',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
];
