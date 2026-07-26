/**
 * The uniform loader.
 *
 * Every resolver returns the same runtime shape regardless of whether the key
 * was bound to procedural code or an asset file. Nothing above this layer may
 * branch on where content came from — that is what makes placeholders and real
 * art interchangeable.
 *
 * Resolvers never throw and never reject on missing or broken content: they
 * warn and return `null`. Presentation degrades; gameplay is unaffected. A
 * granted ability must never be gated on its animation having loaded.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MOG_BONES, boneNameCandidates, type MogBoneId } from './rig';
import { motionIdFromKey } from './keys';
import { bindingFor } from './manifest';
import { getBodyGenerator, getMotionGenerator, getPropGenerator } from './registry';
import { MOG_REST_POSE } from './restPose';
import type { ContentKey, ResolvedBody } from './types';

type LoadedAsset = {
  scene: THREE.Object3D;
  animations: readonly THREE.AnimationClip[];
};

const assetCache = new Map<string, Promise<LoadedAsset>>();
const motionCache = new Map<ContentKey, Promise<THREE.AnimationClip | null>>();

function loadAsset(url: string): Promise<LoadedAsset> {
  const cached = assetCache.get(url);
  if (cached) return cached;

  const isFbx = /\.fbx($|\?)/i.test(url);
  const pending = isFbx
    ? new FBXLoader().loadAsync(url).then(group => ({
        scene: group as THREE.Object3D,
        animations: group.animations ?? [],
      }))
    : new GLTFLoader().loadAsync(url).then(gltf => ({
        scene: gltf.scene as THREE.Object3D,
        animations: gltf.animations ?? [],
      }));

  assetCache.set(url, pending);
  return pending;
}

function trimClip(
  clip: THREE.AnimationClip,
  trimStartSeconds = 0,
  trimEndSeconds = 0,
): THREE.AnimationClip {
  if (!trimStartSeconds && !trimEndSeconds) return clip;

  const start = THREE.MathUtils.clamp(trimStartSeconds, 0, clip.duration);
  const end = THREE.MathUtils.clamp(clip.duration - trimEndSeconds, start, clip.duration);
  if (end <= start) return clip;

  const tracks = clip.tracks
    .map(track => {
      const trimmed = track.clone();
      trimmed.trim(start, end);
      trimmed.shift(-start);
      return trimmed;
    })
    .filter(track => track.times.length > 0);

  return tracks.length > 0
    ? new THREE.AnimationClip(clip.name, end - start, tracks, clip.blendMode)
    : clip;
}

/**
 * Select a clip BY NAME, never by index.
 *
 * Shared libraries hold many named clips, so an index is meaningless there and
 * silently plays the wrong motion. Order of preference: an explicitly pinned
 * clip name, then the motion id itself (a motion id is its clip name). A
 * single-clip file is accepted as unambiguous, since single-take exports often
 * carry a tool-generated name like `mixamo.com`. A multi-clip file with no name
 * match is refused rather than guessed.
 */
function pickClip(
  animations: readonly THREE.AnimationClip[],
  key: ContentKey,
  pinnedName: string | undefined,
  url: string,
): THREE.AnimationClip | null {
  if (pinnedName) {
    const pinned = animations.find(candidate => candidate.name === pinnedName);
    if (!pinned) {
      console.warn(`[content] clip "${pinnedName}" not found in ${url}`);
    }
    return pinned ?? null;
  }

  const motionId = motionIdFromKey(key);
  const byName = animations.find(candidate => candidate.name === motionId);
  if (byName) return byName;

  if (animations.length === 1) return animations[0];

  if (animations.length > 1) {
    console.warn(
      `[content] ${url} has ${animations.length} clips and none named "${motionId}" — ` +
        'name the clip after the motion id, or pin clipName in the manifest',
    );
  }
  return null;
}

/**
 * Resolve a motion key to a clip.
 *
 * Clips are cached and shared: an `AnimationClip` is immutable data, and each
 * consumer binds its own `AnimationAction` via its own mixer.
 */
export function resolveMotion(key: ContentKey): Promise<THREE.AnimationClip | null> {
  const cached = motionCache.get(key);
  if (cached) return cached;

  const pending = (async (): Promise<THREE.AnimationClip | null> => {
    const { source, origin } = bindingFor(key);
    if (!source) {
      console.warn(`[content] motion "${key}" is unbound — no clip will play`);
      return null;
    }

    try {
      if (source.kind === 'procedural') {
        const generator = getMotionGenerator(source.generator);
        if (!generator) {
          console.warn(`[content] no motion generator "${source.generator}" for "${key}"`);
          return null;
        }
        return generator({
          key,
          boneName: (boneId: string) => MOG_BONES[boneId as MogBoneId] ?? boneId,
          restPose: MOG_REST_POSE,
        });
      }

      const asset = await loadAsset(source.url);
      const clip = pickClip(asset.animations, key, source.clipName, source.url);
      if (!clip) {
        console.warn(`[content] no clip in ${source.url} for "${key}" (origin: ${origin})`);
        return null;
      }
      return trimClip(clip.clone(), source.trimStartSeconds, source.trimEndSeconds);
    } catch (error) {
      console.warn(`[content] failed to resolve motion "${key}"`, error);
      return null;
    }
  })();

  motionCache.set(key, pending);
  return pending;
}

/** Collect canonical bones from a loaded skeleton, tolerating Mixamo naming. */
function mapCanonicalBones(root: THREE.Object3D): Record<string, THREE.Bone> {
  const bones: Record<string, THREE.Bone> = {};
  for (const boneId of Object.keys(MOG_BONES) as MogBoneId[]) {
    for (const candidate of boneNameCandidates(boneId)) {
      const found = root.getObjectByName(candidate);
      if (found && (found as THREE.Bone).isBone) {
        bones[boneId] = found as THREE.Bone;
        break;
      }
    }
  }
  return bones;
}

/**
 * Scale a loaded body so it stands `target` units tall.
 *
 * Exporters disagree about units by orders of magnitude — Mixamo FBX is
 * centimetres, so a character arrives ~100 units tall against our 2.0. Rather
 * than make every prop, socket offset and camera distance ask how big this
 * particular asset happens to be, the loader guarantees the answer. "Calibrated"
 * becomes a property of the pipeline instead of something each asset has to
 * arrive with.
 *
 * A body with no measurable height is left alone rather than scaled by infinity.
 */
function normalizeHeight(root: THREE.Object3D, target: number): void {
  root.updateMatrixWorld(true);

  // Measure the CHARACTER, not the file. `setFromObject(root)` would fold in a
  // camera, a light, or a helper an artist left in the export, and one stray
  // object away from the origin shrinks the body to a speck. Skinned meshes are
  // the character by definition, so prefer them.
  const box = new THREE.Box3();
  const measure = (predicate: (child: THREE.Object3D) => boolean): boolean => {
    box.makeEmpty();
    root.traverse(child => {
      if (predicate(child)) box.expandByObject(child);
    });
    return !box.isEmpty();
  };

  const measured =
    measure(child => (child as THREE.SkinnedMesh).isSkinnedMesh === true)
    || measure(child => (child as THREE.Mesh).isMesh === true);
  if (!measured) return;

  const height = box.getSize(new THREE.Vector3()).y;
  if (!Number.isFinite(height) || height <= 1e-4) return;

  const factor = target / height;
  // Leave near-correct assets untouched; a 1.02x scale is noise, not units.
  if (Math.abs(factor - 1) < 0.02) return;
  // Unit mismatches span millimetres to kilometres, so about 1000x either way.
  // Past that the measurement is wrong rather than the units, and guessing is
  // worse than leaving the asset visibly the wrong size.
  if (factor < 1e-3 || factor > 1e3) {
    console.warn(`[content] implausible body scale ${factor.toFixed(4)}; leaving unscaled`);
    return;
  }

  root.scale.multiplyScalar(factor);
  root.updateMatrixWorld(true);
}

/**
 * Resolve a body key. Always returns a FRESH instance — scene-graph objects
 * cannot be shared between players.
 */
export async function resolveBody(key: ContentKey): Promise<ResolvedBody | null> {
  const { source } = bindingFor(key);
  if (!source) {
    console.warn(`[content] body "${key}" is unbound`);
    return null;
  }

  try {
    if (source.kind === 'procedural') {
      const generator = getBodyGenerator(source.generator);
      if (!generator) {
        console.warn(`[content] no body generator "${source.generator}" for "${key}"`);
        return null;
      }
      return generator();
    }

    const asset = await loadAsset(source.url);
    const root = cloneSkeleton(asset.scene) as THREE.Object3D;
    const bones = mapCanonicalBones(root);

    let skeleton: THREE.Skeleton | null = null;
    root.traverse(child => {
      if (!skeleton && (child as THREE.SkinnedMesh).isSkinnedMesh) {
        skeleton = (child as THREE.SkinnedMesh).skeleton;
      }
    });
    if (!skeleton) {
      console.warn(`[content] no skinned mesh in ${source.url} for "${key}"`);
      return null;
    }

    normalizeHeight(root, MOG_REST_POSE.referenceHeight);

    return {
      root,
      skeleton,
      bones,
      referenceHeight: MOG_REST_POSE.referenceHeight,
    };
  } catch (error) {
    console.warn(`[content] failed to resolve body "${key}"`, error);
    return null;
  }
}

/** Resolve a prop key. Always returns a FRESH instance. */
export async function resolveProp(key: ContentKey): Promise<THREE.Object3D | null> {
  const { source } = bindingFor(key);
  if (!source) {
    console.warn(`[content] prop "${key}" is unbound`);
    return null;
  }

  try {
    if (source.kind === 'procedural') {
      const generator = getPropGenerator(source.generator);
      if (!generator) {
        console.warn(`[content] no prop generator "${source.generator}" for "${key}"`);
        return null;
      }
      return generator();
    }

    const asset = await loadAsset(source.url);
    const picked = source.objectName
      ? asset.scene.getObjectByName(source.objectName)
      : asset.scene;
    if (!picked) {
      console.warn(`[content] no object "${source.objectName}" in ${source.url}`);
      return null;
    }
    return picked.clone(true);
  } catch (error) {
    console.warn(`[content] failed to resolve prop "${key}"`, error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Procedural-only resolution
// ---------------------------------------------------------------------------

/**
 * Resolve strictly from the procedural registry, ignoring every binding.
 *
 * Two callers want this and both want it for the same reason: they are asking
 * about the PLACEHOLDER, not about whatever is currently bound. Grip geometry
 * tests measure the mannequin's own proportions, and they run in Node, where a
 * `.glb` behind a URL cannot be fetched at all — so once a real asset lands in
 * `dropin/`, going through the seam would hand them null and the assertions
 * would quietly stop asserting.
 *
 * Real assets are checked in the browser, where they can actually load. These
 * exist so that check and this one do not have to be the same check.
 */
export function proceduralMotion(key: ContentKey): THREE.AnimationClip | null {
  const generator = getMotionGenerator(key);
  if (!generator) return null;
  return generator({
    key,
    boneName: (boneId: string) => MOG_BONES[boneId as MogBoneId] ?? boneId,
    restPose: MOG_REST_POSE,
  });
}

export function proceduralBody(key: ContentKey): ResolvedBody | null {
  return getBodyGenerator(key)?.() ?? null;
}

export function proceduralProp(key: ContentKey): THREE.Object3D | null {
  return getPropGenerator(key)?.() ?? null;
}
