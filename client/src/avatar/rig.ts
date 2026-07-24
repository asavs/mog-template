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
 * What other people call our bones.
 *
 * Every humanoid rig in circulation agrees about the anatomy and disagrees about
 * the spelling. Rather than adopt someone else's convention as our contract —
 * which would make us hostage to whoever we picked — `mog_humanoid` stays
 * canonical and imported skeletons are recognised through these tables.
 *
 * Getting an entry wrong is invisible, which is why they are tested against real
 * bone lists rather than eyeballed: three.js silently ignores an animation track
 * whose target does not exist, so one mis-spelled limb plays as a moving torso
 * above dead arms and legs, with nothing in the console and nothing in a test.
 */

/**
 * Unreal Engine 5 Mannequin naming — used by Unreal itself, by Godot imports of
 * it, and by the Quaternius Universal Animation Library, which is where our
 * motion comes from. This is the table that carries real weight.
 *
 * The hierarchy matches ours exactly, including three spine bones, so this is a
 * pure renaming with no structural adaptation.
 */
const UE5_ALIASES: Record<MogBoneId, string> = {
  hips: 'pelvis',
  spine: 'spine_01',
  spine1: 'spine_02',
  spine2: 'spine_03',
  neck: 'neck_01',
  head: 'Head',
  leftShoulder: 'clavicle_l',
  leftUpperArm: 'upperarm_l',
  leftLowerArm: 'lowerarm_l',
  leftHand: 'hand_l',
  rightShoulder: 'clavicle_r',
  rightUpperArm: 'upperarm_r',
  rightLowerArm: 'lowerarm_r',
  rightHand: 'hand_r',
  leftUpperLeg: 'thigh_l',
  leftLowerLeg: 'calf_l',
  leftFoot: 'foot_l',
  rightUpperLeg: 'thigh_r',
  rightLowerLeg: 'calf_r',
  rightFoot: 'foot_r',
};

/**
 * Mixamo naming, WITHOUT the `mixamorig` prefix. Only the bones where Mixamo
 * disagrees with us are listed; the rest match our canonical name exactly.
 *
 * Kept as a fallback for one-off clips. The four limb segments are the entire
 * reason this table exists — Mixamo calls an upper arm `LeftArm` and a shin
 * `LeftLeg`, so a naive `mixamorig` + our-own-name alias matches nothing at all
 * on eight of our twenty bones.
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
 * Ordered name candidates for scene-graph lookup. Our canonical name always
 * comes first, so lookup order on a mog-native rig is unchanged.
 *
 * Both `mixamorig:Name` and `mixamorigName` are listed because exporters and
 * loaders disagree about whether the colon survives.
 */
export function boneNameCandidates(bone: MogBoneId): readonly string[] {
  const canonical = MOG_BONES[bone];
  const mixamoName = MIXAMO_ALIASES[bone] ?? canonical;

  const candidates = [
    canonical,
    UE5_ALIASES[bone],
    `mixamorig:${mixamoName}`,
    `mixamorig${mixamoName}`,
    // Some rigs ship the bare Mixamo name with no prefix at all.
    ...(mixamoName === canonical ? [] : [mixamoName]),
  ];
  // UE5 spells `Head` exactly as we do; de-duplicate rather than special-case.
  return [...new Set(candidates)];
}

/** Hand sockets used by weapons / potions. */
export const SOCKET_BONE_CANDIDATES = {
  right_hand: boneNameCandidates('rightHand'),
  left_hand: boneNameCandidates('leftHand'),
  spine_sheath: boneNameCandidates('spine2'),
} as const;
