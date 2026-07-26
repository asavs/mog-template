import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MOG_BONES } from './rig';
import { inspectClipBinding, inspectRigBinding } from './inspect';

function skeletonNamed(names: readonly string[]): THREE.Object3D {
  const root = new THREE.Group();
  for (const name of names) {
    const bone = new THREE.Bone();
    bone.name = name;
    root.add(bone);
  }
  return root;
}

const MIXAMO_CORE = [
  'mixamorig:Hips',
  'mixamorig:Spine',
  'mixamorig:Spine1',
  'mixamorig:Spine2',
  'mixamorig:Neck',
  'mixamorig:Head',
  'mixamorig:LeftShoulder',
  'mixamorig:LeftArm',
  'mixamorig:LeftForeArm',
  'mixamorig:LeftHand',
  'mixamorig:RightShoulder',
  'mixamorig:RightArm',
  'mixamorig:RightForeArm',
  'mixamorig:RightHand',
  'mixamorig:LeftUpLeg',
  'mixamorig:LeftLeg',
  'mixamorig:LeftFoot',
  'mixamorig:RightUpLeg',
  'mixamorig:RightLeg',
  'mixamorig:RightFoot',
];

describe('rig binding inspection', () => {
  it('fully binds a Mixamo skeleton', () => {
    const report = inspectRigBinding(skeletonNamed([...MIXAMO_CORE, 'mixamorig:LeftToeBase']));
    expect(report.missing).toEqual([]);
    expect(report.coverage).toBe(1);
    expect(report.matchedAs.leftUpperArm).toBe('mixamorig:LeftArm');
    expect(report.extra).toContain('mixamorig:LeftToeBase');
  });

  it('names exactly which limbs are dead on a foreign skeleton', () => {
    // A pack that agrees about the torso and disagrees about the limbs is the
    // dangerous case: it looks like it works until you watch the arms.
    const report = inspectRigBinding(skeletonNamed([
      'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
      'LeftShoulder', 'LeftHand', 'RightShoulder', 'RightHand',
      'upper_arm_L', 'forearm_L', 'thigh_L', 'shin_L',
    ]));
    expect(report.missing).toContain('leftUpperArm');
    expect(report.missing).toContain('rightLowerLeg');
    expect(report.coverage).toBeLessThan(1);
    expect(report.extra).toContain('upper_arm_L');
  });

  it('counts a clip\'s live and dead tracks, and where they land', () => {
    const body = skeletonNamed([MOG_BONES.spine2, MOG_BONES.hips, MOG_BONES.leftUpperArm]);
    const clip = new THREE.AnimationClip('walk', 1, [
      new THREE.VectorKeyframeTrack(`${MOG_BONES.hips}.position`, [0, 1], [0, 0, 0, 1, 0, 0]),
      new THREE.VectorKeyframeTrack(`${MOG_BONES.spine2}.position`, [0, 1], [0, 0, 0, 1, 0, 0]),
      new THREE.VectorKeyframeTrack('SomeOtherRigBone.position', [0, 1], [0, 0, 0, 1, 0, 0]),
    ]);

    const report = inspectClipBinding(clip, body);
    expect(report.bound).toHaveLength(2);
    expect(report.unbound).toEqual(['SomeOtherRigBone.position']);
    expect(report.byBand.lower).toBe(1);
    expect(report.byBand.core).toBe(1);
    expect(report.coverage).toBeCloseTo(2 / 3);
  });
});
