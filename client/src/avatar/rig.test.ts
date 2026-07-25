import { describe, expect, it } from 'vitest';
import { boneNameCandidates, MOG_BONES, RIG_ID, SOCKET_BONE_CANDIDATES } from './rig';

describe('mog_humanoid rig', () => {
  it('exports a stable rig id', () => {
    expect(RIG_ID).toBe('mog_humanoid');
  });

  it('prefers canonical bone names before Mixamo aliases', () => {
    const names = boneNameCandidates('rightHand');
    expect(names[0]).toBe(MOG_BONES.rightHand);
    expect(names).toContain('mixamorigRightHand');
    expect(names).toContain('mixamorig:RightHand');
  });

  it('wires hand sockets to hand bones', () => {
    // The socket table points at the hand bones whatever they are spelled;
    // that the spelling matches shipped art is the fixture test below.
    expect(SOCKET_BONE_CANDIDATES.right_hand[0]).toBe(MOG_BONES.rightHand);
    expect(SOCKET_BONE_CANDIDATES.left_hand[0]).toBe(MOG_BONES.leftHand);
  });
});

describe('imported skeleton aliases', () => {
  /**
   * The core bone list read straight out of Quaternius' Universal Animation
   * Library GLB (UAL1 and UAL2 ship the identical skeleton). This is the rig our
   * motion actually arrives on, so it is a fixture rather than an assumption.
   * Fingers and `*_leaf_*` terminators are omitted — they are outside our
   * twenty-bone vocabulary by design.
   */
  const QUATERNIUS_UE5_BONES = [
    'root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'Head',
    'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l',
    'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r',
    'thigh_l', 'calf_l', 'foot_l', 'ball_l',
    'thigh_r', 'calf_r', 'foot_r', 'ball_r',
  ];

  it('binds every canonical bone against the real Quaternius skeleton', () => {
    const present = new Set(QUATERNIUS_UE5_BONES);
    const unmatched = (Object.keys(MOG_BONES) as (keyof typeof MOG_BONES)[])
      .filter(bone => !boneNameCandidates(bone).some(name => present.has(name)));

    // Anything listed here is a limb that would silently not animate.
    expect(unmatched).toEqual([]);
  });

  it('maps the UE5 spine and limb names, which are the ones that differ', () => {
    expect(boneNameCandidates('hips')).toContain('pelvis');
    expect(boneNameCandidates('spine2')).toContain('spine_03');
    expect(boneNameCandidates('leftShoulder')).toContain('clavicle_l');
    expect(boneNameCandidates('rightLowerArm')).toContain('lowerarm_r');
    expect(boneNameCandidates('leftLowerLeg')).toContain('calf_l');
  });

  it('never lets two of our bones claim the same imported name', () => {
    const owner = new Map<string, string>();
    for (const bone of Object.keys(MOG_BONES) as (keyof typeof MOG_BONES)[]) {
      for (const name of boneNameCandidates(bone)) {
        expect(owner.get(name) ?? bone, `"${name}" claimed by two bones`).toBe(bone);
        owner.set(name, bone);
      }
    }
  });

  it('uses the limb names mixamo actually emits, which are not ours', () => {
    // Getting these wrong is invisible: a track that binds to nothing is
    // silently ignored, so the character would move its torso and nothing else.
    expect(boneNameCandidates('leftUpperArm')).toContain('mixamorig:LeftArm');
    expect(boneNameCandidates('leftLowerArm')).toContain('mixamorig:LeftForeArm');
    expect(boneNameCandidates('rightUpperLeg')).toContain('mixamorig:RightUpLeg');
    expect(boneNameCandidates('rightLowerLeg')).toContain('mixamorig:RightLeg');
    // Never emit a mixamo name mixamo does not use.
    expect(boneNameCandidates('leftUpperArm')).not.toContain('mixamorig:LeftUpperArm');
  });

  it('keeps our canonical name first and lists no duplicates', () => {
    for (const bone of Object.keys(MOG_BONES) as (keyof typeof MOG_BONES)[]) {
      const candidates = boneNameCandidates(bone);
      expect(candidates[0]).toBe(MOG_BONES[bone]);
      expect(candidates.some(name => name.startsWith('mixamorig:'))).toBe(true);
      expect(new Set(candidates).size).toBe(candidates.length);
    }
  });
});
