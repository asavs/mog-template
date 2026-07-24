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
 * prop and socket, so a drop-in GLB authored to the same convention is held
 * correctly with no code change — and so a prop that sits wrong is fixed by
 * editing three numbers in one table instead of hunting through mesh code.
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

const HALF_PI = Math.PI / 2;

/**
 * Rest T-pose: the right arm runs along world −X, so the hand's local −X points
 * at the fingertips and +X back toward the wrist. With the arms hanging — the
 * locomotion baseline — −X is roughly world-down and +X world-up.
 *
 * So a "carried like a walking staff" hold points +Y → −X, and a "held up out of
 * the fist" hold points +Y → +X. The left hand mirrors in X.
 */
const GRIPS: Partial<Record<PropKey, Partial<Record<SocketId, Grip>>>> = {
  [PROP_KEYS.staff]: {
    rightHand: { position: [-0.03, 0.06, 0.04], rotation: [0.12, 0, HALF_PI] },
    leftHand: { position: [0.03, 0.06, 0.04], rotation: [0.12, 0, -HALF_PI] },
  },
  [PROP_KEYS.sword]: {
    rightHand: { position: [0.02, 0.05, 0.03], rotation: [0, 0.35, -HALF_PI] },
    leftHand: { position: [-0.02, 0.05, 0.03], rotation: [0, -0.35, HALF_PI] },
  },
  [PROP_KEYS.shield]: {
    // Strapped across the forearm, not gripped out of the fist: seat the disc
    // toward the wrist (−X on the left hand, +X on the right — fingertips are
    // the other way), and leave rotation identity.
    //
    // Authoring +Z is the boss. In a presentation stance the hand's local +Z
    // already faces world-forward, so identity keeps the face on the threat.
    // The previous [±π/2, ∓π/2] spin mapped the boss onto hand ±X — the axis
    // that hangs down once the arm is posed — which is why the shield read as
    // a plank stabbed through the torso.
    rightHand: { position: [0.1, 0.02, 0.06], rotation: [0, 0, 0] },
    leftHand: { position: [-0.1, 0.02, 0.06], rotation: [0, 0, 0] },
  },
  [PROP_KEYS.potion]: {
    rightHand: { position: [0.02, 0.05, 0.03], rotation: [0, 0.35, -HALF_PI] },
    leftHand: { position: [-0.02, 0.05, 0.03], rotation: [0, -0.35, HALF_PI] },
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
