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
 * Mixamo's own name for each of our bones, WITHOUT the `mixamorig` prefix.
 *
 * Only the bones where Mixamo disagrees with us are listed; everything else
 * matches our canonical name exactly. The four limb segments are the entire
 * reason this table has to exist, and getting them wrong is invisible: an
 * animation track that binds to nothing is silently ignored, so a Mixamo clip
 * would play a moving torso above dead arms and legs with no error anywhere.
 */
const MIXAMO_ALIASES: Partial<Record<MogBoneId, string>> = {
  leftUpperArm: 'LeftArm',
  leftLowerArm: 'LeftForeArm',
  rightUpperArm: 'RightArm',
  rightLowerArm: 'RightForeArm',
  leftUpperLeg: 'LeftUpLeg',
  leftLowerLeg: 'LeftLeg',
  rightUpperLeg: 'RightUpLeg',
  rightLowerLeg: 'RightLeg',
};

/**
 * Ordered name candidates for scene-graph lookup.
 * Prefer canonical mog names first; Mixamo-style aliases last (legacy FBX).
 *
 * Both `mixamorig:Name` and `mixamorigName` are listed because exporters and
 * loaders disagree about whether the colon survives.
 */
export function boneNameCandidates(bone: MogBoneId): readonly string[] {
  const canonical = MOG_BONES[bone];
  const mixamoName = MIXAMO_ALIASES[bone] ?? canonical;
  return [
    canonical,
    `mixamorig:${mixamoName}`,
    `mixamorig${mixamoName}`,
    // Some rigs ship the bare Mixamo name with no prefix at all.
    ...(mixamoName === canonical ? [] : [mixamoName]),
  ];
}

/** Hand sockets used by weapons / potions. */
export const SOCKET_BONE_CANDIDATES = {
  right_hand: boneNameCandidates('rightHand'),
  left_hand: boneNameCandidates('leftHand'),
  spine_sheath: boneNameCandidates('spine2'),
} as const;
