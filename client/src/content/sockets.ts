/**
 * Where a prop sits once something is holding it.
 *
 * Props are authored in a canonical AUTHORING FRAME and know nothing about
 * hands:
 *
 *   - origin at the grip point (where the fist closes)
 *   - +Y toward the business end — staff tip, blade point, bottle mouth, top rim
 *   - +Z out the "front" face — the shield's boss, the flat of a blade
 *
 * The grip transform that rotates that frame into a hand lives here, keyed by
 * prop and socket, so a prop that sits wrong is fixed by editing three numbers
 * in one table instead of hunting through mesh code.
 *
 * KNOWN LIMITATION, and it is the interesting one. These numbers are specific to
 * the rig that is bound. Aliasing bone NAMES across rigs — which `rig.ts` does —
 * does not align bone ORIENTATIONS: the procedural mannequin and the UE5
 * skeleton agree about what a hand is called and disagree about which way it
 * faces, so a grip calibrated for one is wrong on the other. They are currently
 * calibrated for the UE5 / Quaternius rig, because that is what renders.
 *
 * The real fix is for a body to declare its own hand frame and for this table to
 * express intent relative to it ("blade up, face forward") rather than a raw
 * local rotation. That is a follow-up, not a hack to avoid — one correction
 * quaternion per socket per rig would make these numbers portable.
 */

import * as THREE from 'three';
import { PROP_KEYS, type PropKey } from './keys';

/** Attachment points on the canonical rig. Bone ids from `avatar/rig.ts`. */
export const SOCKETS = {
  rightHand: 'rightHand',
  leftHand: 'leftHand',
} as const;

export type SocketId = (typeof SOCKETS)[keyof typeof SOCKETS];

export type Grip = {
  /** Local offset from the socket bone, in world units at reference height. */
  position: readonly [number, number, number];
  /** Local XYZ Euler in radians, applied to the authoring frame. */
  rotation: readonly [number, number, number];
  scale?: number;
};

/**
 * Rest T-pose: the right arm runs along world −X, so the hand's local −X points
 * at the fingertips and +X back toward the wrist. With the arms hanging — the
 * locomotion baseline — −X is roughly world-down and +X world-up.
 *
 * So a "carried like a walking staff" hold points +Y → −X, and a "held up out of
 * the fist" hold points +Y → +X. The left hand mirrors in X.
 */
const GRIPS: Partial<Record<PropKey, Partial<Record<SocketId, Grip>>>> = {
  // Measured, not guessed. Each rotation is `inverse(handWorldQuat) * desired`
  // read off the actual rig while wearing the stance that holds the prop — so
  // the prop reads correctly at rest and then follows the hand, which is what a
  // held object does. Re-derive these with the grip probe if the rig changes;
  // they encode that rig's hand orientation and nothing else.
  [PROP_KEYS.staff]: {
    // Carried tip-down, like a walking staff.
    rightHand: { position: [0, 0, 0], rotation: [2.5682, 0.0261, 2.9942] },
    leftHand: { position: [0, 0, 0], rotation: [-2.5682, -0.0261, 2.9942] },
  },
  [PROP_KEYS.sword]: {
    // Blade up out of the fist.
    rightHand: { position: [0, 0, 0], rotation: [-0.5051, -0.5855, -2.9189] },
    leftHand: { position: [0, 0, 0], rotation: [0.5051, 0.5855, -2.9189] },
  },
  [PROP_KEYS.shield]: {
    // Face and boss toward the threat, top rim up.
    leftHand: { position: [0, 0, 0], rotation: [-1.665, -1.4449, 3.1137] },
    rightHand: { position: [0, 0, 0], rotation: [1.665, 1.4449, 3.1137] },
  },
  [PROP_KEYS.potion]: {
    // Mouth up, so the raise-to-drink reads.
    rightHand: { position: [0, 0, 0], rotation: [-0.5734, -0.0261, -2.9942] },
    leftHand: { position: [0, 0, 0], rotation: [0.5734, 0.0261, -2.9942] },
  },
};

const IDENTITY_GRIP: Grip = { position: [0, 0, 0], rotation: [0, 0, 0] };

export function gripFor(prop: PropKey, socket: SocketId): Grip {
  return GRIPS[prop]?.[socket] ?? IDENTITY_GRIP;
}

/**
 * Apply a grip to a resolved prop, in place. The object keeps its authoring
 * frame internally; only its root transform changes, so the same mesh can be
 * held in either hand.
 */
export function applyGrip(object: THREE.Object3D, prop: PropKey, socket: SocketId): THREE.Object3D {
  const grip = gripFor(prop, socket);
  object.position.set(...grip.position);
  object.rotation.set(...grip.rotation, 'XYZ');
  if (grip.scale !== undefined) object.scale.setScalar(grip.scale);
  return object;
}
