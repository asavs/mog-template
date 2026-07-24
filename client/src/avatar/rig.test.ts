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
    expect(SOCKET_BONE_CANDIDATES.right_hand[0]).toBe('RightHand');
    expect(SOCKET_BONE_CANDIDATES.left_hand[0]).toBe('LeftHand');
  });
});

describe('mixamo aliases', () => {
  it('uses mixamo\'s own limb names, which are not ours', () => {
    // Getting these wrong is invisible: a track that binds to nothing is
    // silently ignored, so the character would move its torso and nothing else.
    expect(boneNameCandidates('leftUpperArm')).toContain('mixamorig:LeftArm');
    expect(boneNameCandidates('leftLowerArm')).toContain('mixamorig:LeftForeArm');
    expect(boneNameCandidates('rightUpperLeg')).toContain('mixamorig:RightUpLeg');
    expect(boneNameCandidates('rightLowerLeg')).toContain('mixamorig:RightLeg');
    // Never emit a mixamo name mixamo does not use.
    expect(boneNameCandidates('leftUpperArm')).not.toContain('mixamorig:LeftUpperArm');
  });

  it('keeps our canonical name first and covers every bone', () => {
    for (const bone of Object.keys(MOG_BONES) as (keyof typeof MOG_BONES)[]) {
      const candidates = boneNameCandidates(bone);
      expect(candidates[0]).toBe(MOG_BONES[bone]);
      expect(candidates.some(name => name.startsWith('mixamorig:'))).toBe(true);
    }
  });
});
