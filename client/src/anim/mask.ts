import * as THREE from 'three';
import { boneNameCandidates, type MogBoneId } from '../avatar/rig';

/**
 * The rig is split into five disjoint BANDS. Every clip the controller plays is
 * filtered to a set of bands, and the sets in play at any moment never overlap —
 * so tracks blend normally without an additive reference pose, and no bone is
 * ever driven by two actions or by none.
 *
 * The vertical split exists because of movement. An action that roots you owns
 * the whole torso: nothing else is using it, and the extra lean is what sells
 * the weight. An action you can walk through cannot own the lower spine,
 * because that is where a walk's counter-rotation lives — take it away and the
 * legs read as belonging to someone else.
 *
 * The arms then split again, left from right, because the library's poses do.
 * `Idle_Shield_Loop` raises the left arm 74 degrees and leaves the right within
 * 13 degrees of plain idle — it is a shield stance, not a sword-and-board one,
 * and a sword placed in the untouched right hand intersects the shield. The fix
 * is not to author around it but to take the left arm from one clip and the
 * right from another. Casting is the same shape from the other side: the
 * `Spell_Simple_*` clips are entirely left-arm, and every sword clip is
 * entirely right-arm.
 *
 * `core` is what cannot be split. The spine, neck and head are shared by both
 * arms, so they belong to exactly one band and one claimant — usually whichever
 * pose is the more committed, since the torso was authored to support it.
 *
 *   lower  hips, legs, feet        always locomotion
 *   mid    spine, spine1           locomotion, unless a rooted action claims it
 *   core   spine2, neck, head      the shared upper axis
 *   armL   left clavicle..hand     stance / action / reaction
 *   armR   right clavicle..hand    stance / action / reaction
 */
const BAND_BONE_IDS = {
  lower: [
    'hips',
    'leftUpperLeg',
    'leftLowerLeg',
    'leftFoot',
    'rightUpperLeg',
    'rightLowerLeg',
    'rightFoot',
  ],
  mid: ['spine', 'spine1'],
  core: ['spine2', 'neck', 'head'],
  armL: ['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand'],
  armR: ['rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand'],
} as const satisfies Record<string, readonly MogBoneId[]>;

export type AnimationBand = keyof typeof BAND_BONE_IDS;

export const ALL_BANDS: readonly AnimationBand[] = ['lower', 'mid', 'core', 'armL', 'armR'];

/** Everything above the waist that a stance or an overlay can hold. */
export const UPPER_BANDS: readonly AnimationBand[] = ['core', 'armL', 'armR'];

/**
 * How wide an overlay reaches. Named for what the animator has to think about:
 * `arms` must read on top of somebody else's walk, `torso` owns everything from
 * the pelvis up. See `movement` in AbilityPlaybackOptions.
 *
 * Both widths still take both arms. A one-armed width is expressible now that
 * the bands exist, but nothing requests one yet, and a width no motion uses is
 * a claim nobody has watched resolve.
 */
export const OVERLAY_BANDS = {
  arms: ['core', 'armL', 'armR'],
  torso: ['mid', 'core', 'armL', 'armR'],
} as const satisfies Record<string, readonly AnimationBand[]>;

export type OverlayWidth = keyof typeof OVERLAY_BANDS;

const BAND_NAMES: Record<AnimationBand, ReadonlySet<string>> = {
  lower: new Set(BAND_BONE_IDS.lower.flatMap(boneNameCandidates)),
  mid: new Set(BAND_BONE_IDS.mid.flatMap(boneNameCandidates)),
  core: new Set(BAND_BONE_IDS.core.flatMap(boneNameCandidates)),
  armL: new Set(BAND_BONE_IDS.armL.flatMap(boneNameCandidates)),
  armR: new Set(BAND_BONE_IDS.armR.flatMap(boneNameCandidates)),
};

/** Retained for callers that only care about "is this above the waist". */
export const UPPER_BODY_BONE_NAMES: ReadonlySet<string> = new Set(
  ['mid', ...UPPER_BANDS].flatMap(band => [...BAND_NAMES[band as AnimationBand]]),
);

const clipCache = new WeakMap<THREE.AnimationClip, Map<string, THREE.AnimationClip>>();

function trackBoneName(trackName: string): string | undefined {
  try {
    const parsed = THREE.PropertyBinding.parseTrackName(trackName);
    if (parsed.objectName === 'bones' && typeof parsed.objectIndex === 'string') {
      return parsed.objectIndex;
    }
    return parsed.nodeName;
  } catch {
    return undefined;
  }
}

/**
 * Bones we have not named, matched by shape of the name.
 *
 * Imported rigs carry far more bones than the twenty we name — Mixamo alone
 * adds thirty finger bones, toes, and an eye/head terminator. Leaving them
 * unclassified drops them into `lower`, the band that is never suppressed,
 * which would leave fingers playing a walk cycle while the arms swing a sword.
 *
 * This is a heuristic and is meant to be. It is checked only after the exact
 * canonical and alias lookup fails, so naming a bone properly always wins.
 */
/**
 * `arm` is resolved to a side afterwards; everything else names its band.
 *
 * `root` and `armature` are matched first and explicitly, because `/arm/` would
 * otherwise claim an armature as a limb — and the object holding the skeleton is
 * the one bone that must never be suppressed.
 */
const BAND_PATTERNS: readonly (readonly [RegExp, AnimationBand | 'arm'])[] = [
  [/^(root|armature)$/i, 'lower'],
  // LeftHandThumb2, mixamorig:RightHandIndex1, ...
  [/hand|finger|thumb|index|middle|ring|pinky/i, 'arm'],
  [/toe|ball|heel|ankle|knee/i, 'lower'],
  [/clavicle|shoulder|arm|elbow|wrist/i, 'arm'],
  [/head|neck|eye|jaw|face/i, 'core'],
  [/spine|chest|torso/i, 'mid'],
  [/hip|pelvis|root|leg|thigh|shin|foot|calf/i, 'lower'],
];

/**
 * Which side of the body a bone name claims, across every spelling we import.
 *
 * UE5 and Quaternius suffix (`upperarm_l`, `thumb_03_r`); Mixamo and our legacy
 * spelling prefix the word (`LeftForeArm`, `RightHand`). Only consulted once a
 * bone is already known to be an arm, so `calf_l` is never asked — it matched
 * `lower` long before this.
 */
function sideOfBoneName(name: string): 'armL' | 'armR' | undefined {
  if (/left|_l(_|$)/i.test(name)) return 'armL';
  if (/right|_r(_|$)/i.test(name)) return 'armR';
  return undefined;
}

export function bandOfBoneName(name: string): AnimationBand | undefined {
  for (const band of ALL_BANDS) {
    if (BAND_NAMES[band].has(name)) return band;
  }
  for (const [pattern, band] of BAND_PATTERNS) {
    if (!pattern.test(name)) continue;
    // An arm bone whose side we cannot read belongs to neither arm, so it goes
    // to the band both of them share rather than to an arbitrary one.
    if (band === 'arm') return sideOfBoneName(name) ?? 'core';
    return band;
  }
  return undefined;
}

/**
 * Filter a clip down to the given bands.
 *
 * Tracks on bones outside the canonical rig fall to `lower` — the band that is
 * never suppressed — so a clip that animates a prop, a cape, or a bone we have
 * not named yet keeps playing under locomotion instead of vanishing.
 */
export function maskClipToBands(
  source: THREE.AnimationClip,
  bands: readonly AnimationBand[],
): THREE.AnimationClip {
  const wanted = new Set(bands);
  const cacheKey = ALL_BANDS.filter(band => wanted.has(band)).join('+');

  let variants = clipCache.get(source);
  if (!variants) {
    variants = new Map();
    clipCache.set(source, variants);
  }
  const cached = variants.get(cacheKey);
  if (cached) return cached;

  const tracks = source.tracks.filter(track => {
    const boneName = trackBoneName(track.name);
    const band = boneName === undefined ? undefined : bandOfBoneName(boneName);
    return wanted.has(band ?? 'lower');
  });
  const derived = new THREE.AnimationClip(
    `${source.name}__mog_${cacheKey}`,
    source.duration,
    tracks,
    THREE.NormalAnimationBlendMode,
  );
  variants.set(cacheKey, derived);
  return derived;
}

export function maskClipToOverlay(
  source: THREE.AnimationClip,
  width: OverlayWidth,
): THREE.AnimationClip {
  return maskClipToBands(source, OVERLAY_BANDS[width]);
}

export function isUpperBodyBoneName(name: string): boolean {
  return UPPER_BODY_BONE_NAMES.has(name);
}
