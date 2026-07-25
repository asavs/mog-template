/**
 * Does this imported asset actually bind to our rig?
 *
 * An animation track that names a bone we do not have is not an error in
 * three.js — it is silently ignored. So a pack authored on a foreign skeleton
 * plays as a partial character (a moving torso above dead limbs, classically)
 * with nothing in the console and nothing in a test. That failure mode has
 * already cost this project once, on the Mixamo limb names.
 *
 * These functions turn "does this pack work" into a number, so adopting a new
 * asset source is a measurement instead of an afternoon of squinting.
 */

import * as THREE from 'three';
import { ALL_BANDS, bandOfBoneName } from '../anim/mask';
import { MOG_BONES, boneNameCandidates, type MogBoneId } from '../avatar/rig';

const ALL_BONE_IDS = Object.keys(MOG_BONES) as MogBoneId[];

export type RigBindingReport = {
  /** Canonical bones this asset provides. */
  found: MogBoneId[];
  /** Canonical bones it does not — every one of these is a dead limb. */
  missing: MogBoneId[];
  /** Bones present on the asset that our vocabulary does not name. */
  extra: string[];
  /** Which alias matched, per bone. Tells you what convention the pack uses. */
  matchedAs: Record<string, string>;
  coverage: number;
};

export type ClipBindingReport = {
  clipName: string;
  /** Tracks whose target exists on the body — these will animate. */
  bound: string[];
  /** Tracks that will be silently ignored. */
  unbound: string[];
  /** How the clip's tracks distribute across the animation bands. */
  byBand: Record<string, number>;
  coverage: number;
};

function boneNamesIn(root: THREE.Object3D): Set<string> {
  const names = new Set<string>();
  root.traverse(child => {
    if ((child as THREE.Bone).isBone || child.type === 'Bone') names.add(child.name);
  });
  // Skinned meshes can carry bones that are not in the traversed graph.
  root.traverse(child => {
    const skeleton = (child as THREE.SkinnedMesh).skeleton;
    if (skeleton) for (const bone of skeleton.bones) names.add(bone.name);
  });
  return names;
}

/** What our canonical rig finds when it looks at an imported skeleton. */
export function inspectRigBinding(root: THREE.Object3D): RigBindingReport {
  const present = boneNamesIn(root);
  const found: MogBoneId[] = [];
  const missing: MogBoneId[] = [];
  const matchedAs: Record<string, string> = {};
  const claimed = new Set<string>();

  for (const id of ALL_BONE_IDS) {
    const match = boneNameCandidates(id).find(name => present.has(name));
    if (match) {
      found.push(id);
      matchedAs[id] = match;
      claimed.add(match);
    } else {
      missing.push(id);
    }
  }

  return {
    found,
    missing,
    extra: [...present].filter(name => !claimed.has(name)).sort(),
    matchedAs,
    coverage: found.length / ALL_BONE_IDS.length,
  };
}

/** Strip a track name down to the node it targets. */
function trackTarget(trackName: string): string | undefined {
  try {
    const parsed = THREE.PropertyBinding.parseTrackName(trackName);
    if (parsed.objectName === 'bones' && typeof parsed.objectIndex === 'string') {
      return parsed.objectIndex;
    }
    return parsed.nodeName ?? undefined;
  } catch {
    return undefined;
  }
}

/** Which of a clip's tracks will actually drive this body, and which are dead. */
export function inspectClipBinding(
  clip: THREE.AnimationClip,
  root: THREE.Object3D,
): ClipBindingReport {
  const present = boneNamesIn(root);
  const bound: string[] = [];
  const unbound: string[] = [];
  // Derived from the band list rather than spelled out, so splitting a band
  // cannot leave this quietly reporting zero for one that now exists.
  const byBand: Record<string, number> = {
    ...Object.fromEntries(ALL_BANDS.map(band => [band, 0])),
    unclassified: 0,
  };

  for (const track of clip.tracks) {
    const target = trackTarget(track.name);
    if (target !== undefined && present.has(target)) {
      bound.push(track.name);
      byBand[bandOfBoneName(target) ?? 'unclassified'] += 1;
    } else {
      unbound.push(track.name);
    }
  }

  return {
    clipName: clip.name,
    bound,
    unbound,
    byBand,
    coverage: clip.tracks.length === 0 ? 0 : bound.length / clip.tracks.length,
  };
}

/** One-line summaries, for a console or a panel. */
export function describeRigBinding(report: RigBindingReport): string {
  const pct = Math.round(report.coverage * 100);
  const missing = report.missing.length ? ` missing: ${report.missing.join(', ')}` : '';
  return `${report.found.length}/${ALL_BONE_IDS.length} bones (${pct}%).${missing}`;
}

export function describeClipBinding(report: ClipBindingReport): string {
  const pct = Math.round(report.coverage * 100);
  const bands = Object.entries(report.byBand)
    .filter(([, count]) => count > 0)
    .map(([band, count]) => `${band} ${count}`)
    .join(', ');
  return `${report.clipName}: ${report.bound.length}/${report.bound.length + report.unbound.length} tracks (${pct}%) — ${bands}`;
}
