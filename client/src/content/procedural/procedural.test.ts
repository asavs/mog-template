/**
 * Structural checks for procedural placeholders.
 *
 * The bone-name vs track-name assertion is the important one: PropertyBinding
 * matches by object name, so a mismatch silently produces frozen mannequins.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MOG_BONES } from '../../avatar/rig';
import { ALL_MOTION_KEYS, BODY_KEYS, MOTION_KEYS } from '../keys';
import { getBodyGenerator, getMotionGenerator } from '../registry';
import { MOG_REST_POSE } from '../restPose';
import type { MotionGeneratorContext } from '../types';

// Side-effect registration.
import './index';

function motionCtx(key: string): MotionGeneratorContext {
  return {
    key,
    boneName: boneId => MOG_BONES[boneId as keyof typeof MOG_BONES] ?? boneId,
    restPose: MOG_REST_POSE,
  };
}

/** Object names present under the body root (bones + meshes). */
function collectNames(root: THREE.Object3D): Set<string> {
  const names = new Set<string>();
  root.traverse(obj => {
    if (obj.name) names.add(obj.name);
  });
  return names;
}

/** Bone / node name targeted by a track path like `RightHand.quaternion`. */
function trackTargetName(trackName: string): string {
  const dot = trackName.indexOf('.');
  return dot >= 0 ? trackName.slice(0, dot) : trackName;
}

describe('procedural body', () => {
  it('registers body.humanoid with canonical bone names', () => {
    const gen = getBodyGenerator(BODY_KEYS.humanoid);
    expect(gen).toBeTypeOf('function');

    const body = gen!();
    expect(body.bones.hips?.name).toBe('Hips');
    expect(body.bones.rightHand?.name).toBe('RightHand');
    expect(body.root.getObjectByName('Hips')).toBeTruthy();
    expect(body.root.getObjectByName('RightHand')).toBeTruthy();
    expect(body.skeleton.bones.length).toBeGreaterThan(0);
    expect(body.referenceHeight).toBe(MOG_REST_POSE.referenceHeight);
  });
});

describe('procedural motions', () => {
  it('defines every MOTION_KEYS entry', () => {
    for (const key of ALL_MOTION_KEYS) {
      expect(getMotionGenerator(key), `missing generator for ${key}`).toBeTypeOf('function');
    }
    // Sanity: MOTION_KEYS and ALL_MOTION_KEYS stay in sync.
    expect(ALL_MOTION_KEYS.length).toBe(Object.keys(MOTION_KEYS).length);
  });

  it('produces non-empty clips for every motion key', () => {
    for (const key of ALL_MOTION_KEYS) {
      const gen = getMotionGenerator(key)!;
      const clip = gen(motionCtx(key));
      expect(clip, key).toBeInstanceOf(THREE.AnimationClip);
      expect(clip.duration, key).toBeGreaterThan(0);
      expect(clip.tracks.length, key).toBeGreaterThan(0);
    }
  });

  it('every track targets a bone that exists on the procedural body', () => {
    const body = getBodyGenerator(BODY_KEYS.humanoid)!();
    const names = collectNames(body.root);

    // Canonical bone names must all be present.
    for (const boneName of Object.values(MOG_BONES)) {
      expect(names.has(boneName), `body missing bone "${boneName}"`).toBe(true);
    }

    const missing: string[] = [];
    for (const key of ALL_MOTION_KEYS) {
      const clip = getMotionGenerator(key)!(motionCtx(key));
      for (const track of clip.tracks) {
        const target = trackTargetName(track.name);
        if (!names.has(target)) {
          missing.push(`${key}: track "${track.name}" → missing "${target}"`);
        }
      }
    }
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('loco_idle first keyframe hangs both upper arms (anti-T-pose)', () => {
    // Rest is a T-pose. If upper-arm tracks are identity (or near it), arms stick
    // out horizontally and the placeholder reads as "animation failed to load".
    const key = MOTION_KEYS.idle;
    const clip = getMotionGenerator(key)!(motionCtx(key));
    const identity = new THREE.Quaternion();
    // ~1 rad ≈ 57°. Hang is authored around 80° down, so angle ≫ this floor.
    const minAngleFromRest = 1.0;

    for (const bone of ['LeftUpperArm', 'RightUpperArm'] as const) {
      const track = clip.tracks.find(t => t.name === `${bone}.quaternion`);
      expect(track, `${bone} quaternion track`).toBeTruthy();
      expect(track!.times[0], `${bone} first key time`).toBe(0);

      const q = new THREE.Quaternion(
        track!.values[0],
        track!.values[1],
        track!.values[2],
        track!.values[3],
      );
      const angle = q.angleTo(identity);
      expect(angle, `${bone} angle from identity ${angle}`).toBeGreaterThan(minAngleFromRest);
    }
  });
});
