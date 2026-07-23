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
