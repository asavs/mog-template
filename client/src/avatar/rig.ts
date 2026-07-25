/**
 * Canonical humanoid rig for Mog player avatars.
 *
 * The bone IDS below are our contract (`mog_humanoid`) and are what code refers
 * to. The NAMES they map to are UE5 Mannequin spelling, because that is what
 * every asset we own actually ships: the Quaternius animation libraries, base
 * characters, hairstyles, modular outfits and props are UE5-named to the bone.
 *
 * That was not always so, and the change is worth recording. We used to spell
 * these `Hips`, `LeftUpperLeg`, and so on — a neutral convention chosen so we
 * would not be hostage to one vendor. The cost showed up the moment a real body
 * landed: procedural placeholders authored `LeftUpperLeg.quaternion`, the
 * imported body called that bone `thigh_l`, and three.js silently discarded
 * every track. Nineteen of twenty bones dead, no error, no failing test —
 * exactly one track survived, because UE5 spells `Head` the way we did, so the
 * head animated on top of a corpse.
 *
 * Aliasing at lookup time did not fix it and could not: an alias table tells you
 * where a bone IS, while a track name says what it DRIVES, and nothing was
 * rewriting track names. The neutral spelling was buying portability we were not
 * using and paying for it in silent breakage. So the spelling follows the art,
 * and the ids stay abstract — which is where the portability actually lives.
 *
 * The procedural mannequin and the procedural motion generators both build their
 * names from this one table, so they continue to agree with each other for free.
 *
 * Older Mog-spelled and Mixamo-spelled assets are still FOUND, via
 * `boneNameCandidates` below.
 */

export const RIG_ID = 'mog_humanoid' as const;

/** Canonical bone ids (stable API for sockets, VFX, anim events). */
export const MOG_BONES = {
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
 * What we used to call these bones, before the spelling followed the art.
 *
 * Still recognised so legacy packs keep binding, and still the base the Mixamo
 * spellings are derived from — Mixamo agrees with this convention on twelve of
 * the twenty and disagrees only about limb segments.
 */
const MOG_LEGACY_ALIASES: Record<MogBoneId, string> = {
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
};

/**
 * Mixamo naming, WITHOUT the `mixamorig` prefix. Only the bones where Mixamo
 * disagrees with our legacy spelling are listed; the rest match it exactly.
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
 * Ordered name candidates for scene-graph lookup. The canonical (UE5) name
 * comes first, so lookup on the rigs we actually ship costs one comparison.
 *
 * Both `mixamorig:Name` and `mixamorigName` are listed because exporters and
 * loaders disagree about whether the colon survives.
 *
 * This finds a bone. It does not rewrite animation track names, and nothing
 * else does either — which is precisely why the canonical spelling has to be
 * the one the art uses. See the note at the top of this file.
 */
export function boneNameCandidates(bone: MogBoneId): readonly string[] {
  const canonical = MOG_BONES[bone];
  const legacy = MOG_LEGACY_ALIASES[bone];
  const mixamoName = MIXAMO_ALIASES[bone] ?? legacy;

  const candidates = [
    canonical,
    legacy,
    `mixamorig:${mixamoName}`,
    `mixamorig${mixamoName}`,
    // Some rigs ship the bare Mixamo name with no prefix at all.
    ...(mixamoName === legacy ? [] : [mixamoName]),
  ];
  // UE5 and our legacy spelling agree on `Head`; de-duplicate, don't special-case.
  return [...new Set(candidates)];
}

/** Hand sockets used by weapons / potions. */
export const SOCKET_BONE_CANDIDATES = {
  right_hand: boneNameCandidates('rightHand'),
  left_hand: boneNameCandidates('leftHand'),
  spine_sheath: boneNameCandidates('spine2'),
} as const;
