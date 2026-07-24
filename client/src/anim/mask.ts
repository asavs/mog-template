import * as THREE from 'three';
import { boneNameCandidates, type MogBoneId } from '../avatar/rig';

/**
 * The rig is split into three disjoint BANDS. Every clip the controller plays is
 * filtered to a set of bands, and the sets in play at any moment never overlap —
 * so tracks blend normally without an additive reference pose, and no bone is
 * ever driven by two actions or by none.
 *
 * The split exists because of movement. An action that roots you owns the whole
 * torso: nothing else is using it, and the extra lean is what sells the weight.
 * An action you can walk through cannot own the lower spine, because that is
 * where a walk's counter-rotation lives — take it away and the legs read as
 * belonging to someone else.
 *
 *   lower  hips, legs, feet          always locomotion
 *   mid    spine, spine1             locomotion, unless a rooted action claims it
 *   upper  spine2..head, arms, hands stance / action / reaction
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
  upper: [
    'spine2',
    'neck',
    'head',
    'leftShoulder',
    'leftUpperArm',
    'leftLowerArm',
    'leftHand',
    'rightShoulder',
    'rightUpperArm',
    'rightLowerArm',
    'rightHand',
  ],
} as const satisfies Record<string, readonly MogBoneId[]>;

export type AnimationBand = keyof typeof BAND_BONE_IDS;

export const ALL_BANDS: readonly AnimationBand[] = ['lower', 'mid', 'upper'];

/**
 * How wide an overlay reaches. Named for what the animator has to think about:
 * `arms` must read on top of somebody else's walk, `torso` owns everything from
 * the pelvis up. See `movement` in AbilityPlaybackOptions.
 */
export const OVERLAY_BANDS = {
  arms: ['upper'],
  torso: ['mid', 'upper'],
} as const satisfies Record<string, readonly AnimationBand[]>;

export type OverlayWidth = keyof typeof OVERLAY_BANDS;

const BAND_NAMES: Record<AnimationBand, ReadonlySet<string>> = {
  lower: new Set(BAND_BONE_IDS.lower.flatMap(boneNameCandidates)),
  mid: new Set(BAND_BONE_IDS.mid.flatMap(boneNameCandidates)),
  upper: new Set(BAND_BONE_IDS.upper.flatMap(boneNameCandidates)),
};

/** Retained for callers that only care about "is this above the waist". */
export const UPPER_BODY_BONE_NAMES: ReadonlySet<string> = new Set([
  ...BAND_NAMES.mid,
  ...BAND_NAMES.upper,
]);

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
const BAND_PATTERNS: readonly (readonly [RegExp, AnimationBand])[] = [
  // LeftHandThumb2, mixamorig:RightHandIndex1, ...
  [/hand|finger|thumb|index|middle|ring|pinky/i, 'upper'],
  [/toe|ball|heel|ankle|knee/i, 'lower'],
  [/head|neck|eye|jaw|face|clavicle|shoulder|arm|elbow|wrist/i, 'upper'],
  [/spine|chest|torso/i, 'mid'],
  [/hip|pelvis|root|leg|thigh|shin|foot/i, 'lower'],
];

export function bandOfBoneName(name: string): AnimationBand | undefined {
  for (const band of ALL_BANDS) {
    if (BAND_NAMES[band].has(name)) return band;
  }
  for (const [pattern, band] of BAND_PATTERNS) {
    if (pattern.test(name)) return band;
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
