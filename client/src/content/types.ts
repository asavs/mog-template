/**
 * Content seam types.
 *
 * Game code refers to content by a stable logical KEY (`motion.action.magic_cast`),
 * never by a file path. A key resolves to a SOURCE (procedural code, or an asset
 * file), and every source produces the same RUNTIME object. Swapping a
 * placeholder for real art is therefore a binding change, not a code change.
 */

import type * as THREE from 'three';

/** Stable logical name for a piece of content. See `keys.ts` for the vocabulary. */
export type ContentKey = string;

/** Where the bytes (or the code) for a key come from. */
export type ContentSource =
  | {
      kind: 'procedural';
      /** Generator id registered in `registry.ts`. */
      generator: string;
    }
  | {
      kind: 'file';
      url: string;
      /**
       * Clip to pick out of a multi-clip file. Omit to take the first clip,
       * which is the norm for single-take exports.
       */
      clipName?: string;
      /** Object to pick out of a multi-object file (prop packs). */
      objectName?: string;
      trimStartSeconds?: number;
      trimEndSeconds?: number;
    };

/** Which rule bound a key to its source — surfaced for debugging the seam. */
export type ContentBindingOrigin = 'dropin' | 'manifest' | 'procedural' | 'unbound';

export type ContentBinding = {
  key: ContentKey;
  source: ContentSource | null;
  origin: ContentBindingOrigin;
};

/**
 * A body: skeleton plus whatever renders it. Procedural mannequins and real
 * skinned meshes both surface this shape, so nothing downstream branches on
 * which one it got.
 */
export type ResolvedBody = {
  /** Scene-graph root to add to the world. */
  root: THREE.Object3D;
  /** Canonical mog_humanoid skeleton driving this body. */
  skeleton: THREE.Skeleton;
  /** Canonical bone id -> bone, for sockets, VFX spawns, and anim events. */
  bones: Record<string, THREE.Bone>;
  /** Height in world units at scale 1, for normalizing props and camera. */
  referenceHeight: number;
};

export type MotionGenerator = (context: MotionGeneratorContext) => THREE.AnimationClip;

/**
 * Procedural motion is authored against the canonical rest pose, so a generator
 * never needs a loaded body — it emits bone tracks by canonical bone name.
 */
export type MotionGeneratorContext = {
  key: ContentKey;
  /** Canonical bone name for a bone id (e.g. 'rightHand' -> 'RightHand'). */
  boneName: (boneId: string) => string;
  /** Canonical rest pose, so generators can offset rather than hardcode. */
  restPose: RestPose;
};

export type BodyGenerator = () => ResolvedBody;
export type PropGenerator = () => THREE.Object3D;

/** Rest-pose data for the canonical rig: local offsets and default rotations. */
export type RestPose = {
  referenceHeight: number;
  /** Canonical bone id -> local position offset from its parent, in world units. */
  offsets: Record<string, readonly [number, number, number]>;
  /** Canonical bone id -> parent bone id (null for the root). */
  parents: Record<string, string | null>;
};
