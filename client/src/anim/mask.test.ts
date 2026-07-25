import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MOG_BONES } from '../avatar/rig';
import {
  ALL_BANDS,
  OVERLAY_BANDS,
  UPPER_BODY_BONE_NAMES,
  bandOfBoneName,
  maskClipToBands,
  maskClipToOverlay,
} from './mask';

function vectorTrack(name: string): THREE.VectorKeyframeTrack {
  return new THREE.VectorKeyframeTrack(name, [0, 1], [0, 0, 0, 1, 0, 0]);
}

describe('animation bone bands', () => {
  it('assigns every canonical bone to exactly one band', () => {
    const seen = new Map<string, string>();
    for (const name of Object.values(MOG_BONES)) {
      const band = bandOfBoneName(name);
      expect(band, `${name} belongs to no band`).toBeDefined();
      seen.set(name, band as string);
    }
    expect(seen.get(MOG_BONES.hips)).toBe('lower');
    expect(seen.get(MOG_BONES.rightFoot)).toBe('lower');
    expect(seen.get(MOG_BONES.spine)).toBe('mid');
    expect(seen.get(MOG_BONES.spine1)).toBe('mid');
    expect(seen.get(MOG_BONES.spine2)).toBe('core');
    expect(seen.get(MOG_BONES.head)).toBe('core');
    expect(seen.get(MOG_BONES.leftHand)).toBe('armL');
    expect(seen.get(MOG_BONES.rightHand)).toBe('armR');
    expect(seen.get(MOG_BONES.leftShoulder)).toBe('armL');
    expect(seen.get(MOG_BONES.rightShoulder)).toBe('armR');
  });

  it('keeps the arms in separate bands so a pose can be composed per side', () => {
    // The whole reason the upper band splits: no clip in the library is
    // sword-and-board, so the shield arm comes from one and the sword arm from
    // another. That is only possible if masking one never touches the other.
    const source = new THREE.AnimationClip('stance', 1, [
      vectorTrack(`${MOG_BONES.leftUpperArm}.position`),
      vectorTrack(`${MOG_BONES.rightUpperArm}.position`),
      vectorTrack(`${MOG_BONES.spine2}.position`),
    ]);

    expect(maskClipToBands(source, ['armL']).tracks.map(t => t.name)).toEqual([
      `${MOG_BONES.leftUpperArm}.position`,
    ]);
    expect(maskClipToBands(source, ['armR']).tracks.map(t => t.name)).toEqual([
      `${MOG_BONES.rightUpperArm}.position`,
    ]);
    // Composing the two halves reconstructs everything but the shared axis,
    // which belongs to exactly one of them and never to both.
    expect(maskClipToBands(source, ['core', 'armL']).tracks).toHaveLength(2);
    expect(maskClipToBands(source, ['core', 'armR']).tracks).toHaveLength(2);
  });

  it('splits a clip into bands that partition its tracks', () => {
    const names = [
      `${MOG_BONES.spine}.position`,
      `${MOG_BONES.spine2}.position`,
      `.bones[${MOG_BONES.rightHand}].position`,
      `${MOG_BONES.hips}.position`,
      `${MOG_BONES.leftUpperLeg}.position`,
    ];
    const source = new THREE.AnimationClip('mixed', 1, names.map(vectorTrack));

    const perBand = ALL_BANDS.flatMap(band =>
      maskClipToBands(source, [band]).tracks.map(track => track.name),
    );
    expect([...perBand].sort()).toEqual([...names].sort());
  });

  it('leaves the lower spine to locomotion for a mobile action, and claims it for a rooted one', () => {
    const source = new THREE.AnimationClip('act', 1, [
      vectorTrack(`${MOG_BONES.spine}.position`),
      vectorTrack(`${MOG_BONES.spine2}.position`),
      vectorTrack(`${MOG_BONES.hips}.position`),
    ]);

    expect(maskClipToOverlay(source, 'arms').tracks.map(t => t.name)).toEqual([
      `${MOG_BONES.spine2}.position`,
    ]);
    expect(maskClipToOverlay(source, 'torso').tracks.map(t => t.name)).toEqual([
      `${MOG_BONES.spine}.position`,
      `${MOG_BONES.spine2}.position`,
    ]);
  });

  it('never lets two simultaneous claims overlap', () => {
    // A torso overlay suppresses mid+upper; a locomotion base keeps lower. The
    // controller relies on these sets being disjoint to blend without an
    // additive reference pose.
    const arms = new Set<string>(OVERLAY_BANDS.arms);
    const torso = new Set<string>(OVERLAY_BANDS.torso);
    expect([...arms].every(band => torso.has(band))).toBe(true);
    expect(torso.has('lower')).toBe(false);
  });

  it('parks unrecognized bones in the band that is never suppressed', () => {
    const source = new THREE.AnimationClip('mixed', 1, [
      vectorTrack(`${MOG_BONES.head}.position`),
      vectorTrack('Character.position'),
      vectorTrack('Cape_01.position'),
    ]);

    expect(maskClipToBands(source, ['lower']).tracks.map(t => t.name)).toEqual([
      'Character.position',
      'Cape_01.position',
    ]);
  });

  it('caches derived clips per band set', () => {
    const source = new THREE.AnimationClip('mixed', 1, [
      vectorTrack(`${MOG_BONES.head}.position`),
      vectorTrack(`${MOG_BONES.hips}.position`),
    ]);
    expect(maskClipToBands(source, ['lower'])).toBe(maskClipToBands(source, ['lower']));
    expect(maskClipToOverlay(source, 'arms')).toBe(maskClipToOverlay(source, 'arms'));
    // Order must not produce a second cache entry.
    expect(maskClipToBands(source, ['core', 'mid'])).toBe(maskClipToBands(source, ['mid', 'core']));
  });

  it('routes an imported rig\'s unnamed extras by shape rather than dumping them in lower', () => {
    // Mixamo ships ~65 bones; we name 20. Fingers landing in `lower` would keep
    // playing the walk cycle while the arms swing a sword.
    expect(bandOfBoneName('mixamorig:LeftHandThumb2')).toBe('armL');
    expect(bandOfBoneName('mixamorig:RightHandIndex1')).toBe('armR');
    expect(bandOfBoneName('mixamorig:LeftToeBase')).toBe('lower');
    expect(bandOfBoneName('mixamorig:HeadTop_End')).toBe('core');
    // An exact canonical name still wins over the heuristic.
    expect(bandOfBoneName(MOG_BONES.spine1)).toBe('mid');
  });

  it('reads sidedness from every spelling we import, and only for arms', () => {
    // Suffixed (UE5, Quaternius) and prefixed (Mixamo, our legacy names).
    expect(bandOfBoneName('thumb_03_l')).toBe('armL');
    expect(bandOfBoneName('index_01_r')).toBe('armR');
    expect(bandOfBoneName('LeftForeArm')).toBe('armL');
    expect(bandOfBoneName('RightHand')).toBe('armR');
    // A sided LEG name must never be mistaken for an arm: it matched `lower`
    // long before sidedness was consulted.
    expect(bandOfBoneName('calf_l')).toBe('lower');
    expect(bandOfBoneName('thigh_r')).toBe('lower');
    // An arm bone with no readable side goes to the band both arms share
    // rather than to an arbitrary one.
    expect(bandOfBoneName('wrist_twist')).toBe('core');
    // `/arm/` must not claim the object holding the skeleton.
    expect(bandOfBoneName('Armature')).toBe('lower');
  });

  it('recognizes rig aliases without embedding a second bone-name list', () => {
    const source = new THREE.AnimationClip('legacy', 1, [
      vectorTrack('mixamorigSpine.position'),
      vectorTrack('mixamorig:LeftUpperArm.position'),
      vectorTrack('mixamorigLeftUpperLeg.position'),
    ]);

    expect(maskClipToOverlay(source, 'torso').tracks.map(track => track.name)).toEqual([
      'mixamorigSpine.position',
      'mixamorig:LeftUpperArm.position',
    ]);
    expect(UPPER_BODY_BONE_NAMES.has('mixamorigSpine')).toBe(true);
  });
});
