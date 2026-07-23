/**
 * Canonical humanoid rig for Mog player avatars.
 *
 * This is **our** bone contract (`mog_humanoid`), not a Mixamo requirement.
 * Art may be authored in Blender, Cascadeur, Mixamo, AccuRIG, etc. as long as
 * exports are retargeted (or named) to these bones before runtime.
 *
 * Transitional assets still use Mixamo names — `boneNameCandidates` lists
 * aliases so the assembler finds either convention.
 */

export const RIG_ID = 'mog_humanoid' as const;

/** Canonical bone ids (stable API for sockets, VFX, anim events). */
export const MOG_BONES = {
  hips: 'Hips',
  spine: 'Spine',
  spine1: 'Spine1',
  spine2: 'Spine2',
  neck: 'Neck',
  head: 'Head',
  leftShoulder: 'LeftShoulder',
  leftUpperArm: 'LeftUpperArm',
  leftLowerArm: 'LeftLowerArm',
  leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder',
  rightUpperArm: 'RightUpperArm',
  rightLowerArm: 'RightLowerArm',
  rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpperLeg',
  leftLowerLeg: 'LeftLowerLeg',
  leftFoot: 'LeftFoot',
  rightUpperLeg: 'RightUpperLeg',
  rightLowerLeg: 'RightLowerLeg',
  rightFoot: 'RightFoot',
} as const;

export type MogBoneId = keyof typeof MOG_BONES;

/**
 * Ordered name candidates for scene-graph lookup.
 * Prefer canonical mog names first; Mixamo-style aliases last (legacy FBX).
 */
export function boneNameCandidates(bone: MogBoneId): readonly string[] {
  const canonical = MOG_BONES[bone];
  // Mixamo exports often prefix with mixamorig / mixamorig:
  const mixamo = [
    `mixamorig${canonical}`,
    `mixamorig:${canonical}`,
  ];
  return [canonical, ...mixamo];
}

/** Hand sockets used by weapons / potions. */
export const SOCKET_BONE_CANDIDATES = {
  right_hand: boneNameCandidates('rightHand'),
  left_hand: boneNameCandidates('leftHand'),
  spine_sheath: boneNameCandidates('spine2'),
} as const;
