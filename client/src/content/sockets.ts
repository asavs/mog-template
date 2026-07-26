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

/** Attachment points on the canonical rig. Bone ids from `rig.ts`. */
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


// ---------------------------------------------------------------------------
// Deriving the fist
// ---------------------------------------------------------------------------

/**
 * A hand bone sits at the WRIST, not in the palm, and it carries no information
 * about which way a held object should point. That is the whole reason grips
 * have been hand-tuned per rig: production skeletons add a dedicated socket bone
 * that a rigger placed deliberately, and an animation library ships no such
 * thing.
 *
 * But a rig with fingers already contains the answer. The finger roots fan out
 * from the wrist, so their mean direction is "along the fingers", and the thumb
 * is simply the one that disagrees most with that mean. Two axes give a frame,
 * and a frame gives every prop a correct place to sit — on any rig, with no
 * measuring.
 *
 * Everything here is in the hand bone's LOCAL space, where finger roots sit at
 * their rest offsets, so the frame is a constant and does not move with the pose.
 */
export type FistFrame = {
  /** Where the fist closes, local to the hand bone. */
  origin: THREE.Vector3;
  /** Wrist toward the fingertips. */
  along: THREE.Vector3;
  /** Out of the palm. */
  palm: THREE.Vector3;
  /** The axis a cylindrical handle runs along, pointing thumb-ward. */
  grip: THREE.Vector3;
};

export function fistFrame(hand: THREE.Object3D): FistFrame | null {
  const fingers = hand.children.filter(child => (child as THREE.Bone).isBone === true);
  // One child is a wrist chain, not a hand. Two is the minimum that spans a plane.
  if (fingers.length < 2) return null;

  const mean = new THREE.Vector3();
  for (const finger of fingers) mean.add(finger.position);
  mean.divideScalar(fingers.length);

  const reach = mean.length();
  if (reach < 1e-6) return null;
  const along = mean.clone().normalize();

  // The thumb is the finger root that agrees least with the fan.
  let thumb = fingers[0];
  let least = Infinity;
  for (const finger of fingers) {
    if (finger.position.lengthSq() < 1e-12) continue;
    const agreement = finger.position.clone().normalize().dot(along);
    if (agreement < least) {
      least = agreement;
      thumb = finger;
    }
  }

  const palm = new THREE.Vector3()
    .crossVectors(thumb.position.clone().normalize(), along)
    .normalize();
  if (palm.lengthSq() < 0.5) return null;
  const grip = new THREE.Vector3().crossVectors(along, palm).normalize();

  // The fist closes around the finger bases, a little into the palm.
  const origin = along.clone().multiplyScalar(reach * 0.85);
  return { origin, along, palm, grip };
}

/**
 * How a prop wants to sit in a fist, in words rather than numbers.
 *
 * This is the part that genuinely cannot be derived — only a person knows a
 * sword points out of the top of the fist and a staff points at the floor. But
 * it is the ONLY part, and unlike a raw rotation it survives a change of rig.
 */
type Hold = {
  /** Where the prop's +Y (business end) should point. */
  lengthAxis: keyof Omit<FistFrame, 'origin'>;
  lengthSign: 1 | -1;
  /** Where the prop's +Z (front face) should point. */
  faceAxis: keyof Omit<FistFrame, 'origin'>;
  faceSign: 1 | -1;
  /** Extra shift from the fist, along the frame's own axes. */
  offset?: { along?: number; palm?: number; grip?: number };
  /**
   * Fine correction after the axes have done their work, in degrees, about the
   * PROP's own authoring frame.
   *
   * The axes above can only say "blade out of the top of the fist, flat toward
   * the palm", which lands a sword within about fifteen degrees of right and no
   * closer — a real hand cants a hilt, and no amount of naming axes expresses
   * that. This is where the rest goes.
   *
   * Deliberately in the prop's frame rather than the hand's: "roll the blade
   * eight degrees" is a fact about the sword and survives a change of rig,
   * whereas the same correction written against the bone would not. Derived by
   * dragging it in the drill room; see `stage/grips.ts`.
   */
  trim?: readonly [number, number, number];
};

const HOLDS: Partial<Record<PropKey, Hold>> = {
  // Blade out of the top of the fist, flat of the blade facing the palm side.
  // Trimmed by hand in the drill room, in the RIGHT hand: the axes alone put
  // the blade about twenty-six degrees off, which is the cant a fist puts on a
  // hilt and the amount no naming of axes can express.
  [PROP_KEYS.sword]: {
    lengthAxis: 'grip', lengthSign: 1, faceAxis: 'palm', faceSign: 1,
    offset: { along: 0.003, palm: 0.025, grip: -0.018 },
    trim: [-25.7, -16.1, 0.6],
  },
  // Staff runs the other way down the fist so the length reaches the ground.
  [PROP_KEYS.staff]: { lengthAxis: 'grip', lengthSign: -1, faceAxis: 'palm', faceSign: 1 },
  [PROP_KEYS.potion]: { lengthAxis: 'grip', lengthSign: 1, faceAxis: 'palm', faceSign: 1 },
  // A shield is strapped across the forearm, not gripped: its face looks out of
  // the back of the hand, and it sits back toward the elbow. Trimmed by hand in
  // the LEFT hand, which is where the sword-and-board stance puts it.
  [PROP_KEYS.shield]: {
    lengthAxis: 'along', lengthSign: -1, faceAxis: 'palm', faceSign: 1,
    offset: { along: -0.102, palm: 0.055, grip: -0.036 },
    trim: [1.9, 25.6, 10.3],
  },
};

/**
 * The orientation a hold asks for, before any trim.
 *
 * Split out because the grip editor needs exactly this: the trim it derives is
 * the difference between where a prop was dragged to and what the axes alone
 * would have produced.
 */
export function holdBasis(hold: Hold, frame: FistFrame): THREE.Quaternion | null {
  const length = frame[hold.lengthAxis].clone().multiplyScalar(hold.lengthSign);
  const face = frame[hold.faceAxis].clone().multiplyScalar(hold.faceSign);
  // Orthogonalise: the two named axes may not be exactly perpendicular.
  const z = face.clone().sub(length.clone().multiplyScalar(face.dot(length))).normalize();
  if (z.lengthSq() < 0.5) return null;
  const x = new THREE.Vector3().crossVectors(length, z).normalize();

  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(x, length, z),
  );
}

/** Solve a prop's local transform from the fist frame and its hold. */
function holdInFist(prop: PropKey, frame: FistFrame): Grip | null {
  const hold = HOLDS[prop];
  if (!hold) return null;

  const basis = holdBasis(hold, frame);
  if (!basis) return null;

  // Trim is in the prop's own frame, so it multiplies on the right — the prop
  // turns about its own blade, not about the hand.
  if (hold.trim) {
    const [x, y, z] = hold.trim.map(THREE.MathUtils.degToRad);
    basis.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ')));
  }
  const rotation = new THREE.Euler().setFromQuaternion(basis, 'XYZ');

  const position = frame.origin.clone();
  const shift = hold.offset ?? {};
  position.addScaledVector(frame.along, shift.along ?? 0);
  position.addScaledVector(frame.palm, shift.palm ?? 0);
  position.addScaledVector(frame.grip, shift.grip ?? 0);

  return {
    position: [position.x, position.y, position.z],
    rotation: [rotation.x, rotation.y, rotation.z],
  };
}

export type { Hold };

/** The hold a prop is currently authored with, for tools that want to edit it. */
export function holdFor(prop: PropKey): Hold | null {
  return HOLDS[prop] ?? null;
}

const IDENTITY_GRIP: Grip = { position: [0, 0, 0], rotation: [0, 0, 0] };

export function gripFor(prop: PropKey, socket: SocketId): Grip {
  return GRIPS[prop]?.[socket] ?? IDENTITY_GRIP;
}

/**
 * Apply a grip to a resolved prop, in place. The object keeps its authoring
 * frame internally; only its root transform changes, so the same mesh can be
 * held in either hand.
 */
export function applyGrip(
  object: THREE.Object3D,
  prop: PropKey,
  socket: SocketId,
  hand?: THREE.Object3D | null,
): THREE.Object3D {
  // Prefer a grip solved from the rig's own fingers. The static table is the
  // fallback for rigs that do not have them.
  const frame = hand ? fistFrame(hand) : null;
  const grip = (frame && holdInFist(prop, frame)) ?? gripFor(prop, socket);
  object.position.set(...grip.position);
  object.rotation.set(...grip.rotation, 'XYZ');
  if (grip.scale !== undefined) object.scale.setScalar(grip.scale);
  return object;
}
