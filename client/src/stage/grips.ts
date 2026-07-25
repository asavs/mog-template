/**
 * Reading a grip back off the prop you just moved in someone's hand.
 *
 * The sibling of `placements.ts`, and the harder of the two, because a held
 * prop is not positioned — it is SOLVED. `applyGrip` prefers a transform
 * derived from the rig's own fingers over any stored number, so writing raw
 * positions and rotations back into the grip table would appear to work and
 * change nothing the next time the room loaded.
 *
 * What survives is a `Hold`: which way the length points, which way the face
 * points, and a correction. So that is what this emits. The correction has two
 * parts and both are expressed against something that is not the bone —
 *
 *   offset  in the fist frame's own axes (along the fingers, out of the palm,
 *           along the handle), because those are derived per rig
 *   trim    in the PROP's authoring frame, because "roll the blade eight
 *           degrees" is a fact about the sword
 *
 * — which is what lets a grip tuned on this mannequin still be right on a body
 * we have not imported yet.
 */

import * as THREE from 'three';
import { holdBasis, type FistFrame, type Hold, type PropKey } from '../content';

export type GripTrim = {
  offset: { along: number; palm: number; grip: number };
  trim: [number, number, number];
};

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return (Math.round(value * factor) + 0) / factor;
}

/**
 * The correction that would reproduce where this prop now sits.
 *
 * `object` must be a child of the hand bone, with its local transform already
 * moved — which is what a gizmo attached to it produces.
 */
export function gripTrimOf(
  hold: Hold,
  frame: FistFrame,
  object: THREE.Object3D,
): GripTrim | null {
  const basis = holdBasis(hold, frame);
  if (!basis) return null;

  // Position: the frame's axes are orthonormal, so projecting the displacement
  // onto each one recovers the offset directly.
  const delta = object.position.clone().sub(frame.origin);
  const offset = {
    along: round(delta.dot(frame.along), 3),
    palm: round(delta.dot(frame.palm), 3),
    grip: round(delta.dot(frame.grip), 3),
  };

  // Rotation: whatever the axes did not already account for. Left-inverse,
  // because trim multiplies on the right in `holdInFist`.
  const correction = basis.clone().invert().multiply(object.quaternion.clone());
  const euler = new THREE.Euler().setFromQuaternion(correction, 'XYZ');
  const trim: [number, number, number] = [
    round(THREE.MathUtils.radToDeg(euler.x), 1),
    round(THREE.MathUtils.radToDeg(euler.y), 1),
    round(THREE.MathUtils.radToDeg(euler.z), 1),
  ];

  return { offset, trim };
}

const isZero = (value: number) => Math.abs(value) < 1e-9;

/**
 * A hold as the source that would produce it, ready to paste into `HOLDS`.
 *
 * Axis choices are carried through untouched — a gizmo cannot revise "the blade
 * points out of the top of the fist", and should not pretend to. Only the two
 * correction terms come from the drag, and each is omitted when it is zero so
 * an unedited hold exports exactly as it was written.
 */
export function holdSource(prop: PropKey, hold: Hold, correction: GripTrim): string {
  const parts = [
    `lengthAxis: '${hold.lengthAxis}', lengthSign: ${hold.lengthSign}`,
    `faceAxis: '${hold.faceAxis}', faceSign: ${hold.faceSign}`,
  ];

  const shifts = Object.entries(correction.offset)
    .filter(([, value]) => !isZero(value))
    .map(([axis, value]) => `${axis}: ${value}`);
  if (shifts.length > 0) parts.push(`offset: { ${shifts.join(', ')} }`);

  if (!correction.trim.every(isZero)) parts.push(`trim: [${correction.trim.join(', ')}]`);

  return [
    `  [PROP_KEYS.${prop.replace(/^prop\./, '')}]: {`,
    `    ${parts.join(',\n    ')},`,
    '  },',
  ].join('\n');
}
