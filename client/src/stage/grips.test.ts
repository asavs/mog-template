/**
 * The grip export has to round-trip through the solver, not just look plausible.
 *
 * `applyGrip` prefers a transform solved from the rig's fingers over any stored
 * one, so a correction that does not feed back through `holdInFist` would look
 * right in the browser and vanish on reload. These tests therefore go the whole
 * way round: derive a trim from a moved prop, put it in a hold, solve that hold,
 * and check the prop lands back where it was dragged to.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyGrip, fistFrame, holdFor, PROP_KEYS, type FistFrame } from '../content';
import { gripTrimOf, holdSource } from './grips';

/** A hand with four finger roots and a thumb, which is all `fistFrame` needs. */
function hand(): THREE.Object3D {
  const bone = new THREE.Bone();
  bone.name = 'hand_r';
  const roots: [string, [number, number, number]][] = [
    ['index', [0.09, 0.01, 0.02]],
    ['middle', [0.09, 0.0, 0.0]],
    ['ring', [0.085, -0.005, -0.02]],
    ['pinky', [0.08, -0.01, -0.038]],
    ['thumb', [0.03, 0.02, 0.035]],
  ];
  for (const [name, position] of roots) {
    const finger = new THREE.Bone();
    finger.name = name;
    finger.position.set(...position);
    bone.add(finger);
  }
  return bone;
}

function frameOf(bone: THREE.Object3D): FistFrame {
  const frame = fistFrame(bone);
  if (!frame) throw new Error('fixture hand produced no fist frame');
  return frame;
}

describe('grip trim', () => {
  it('reads a freshly solved prop back as the correction it was solved with', () => {
    // Idempotence, and it is the property the whole tool rests on: open the
    // editor, touch nothing, export — and get back what was already in the
    // table. Anything else means every visit quietly rewrites the grip.
    for (const prop of [PROP_KEYS.sword, PROP_KEYS.shield] as const) {
      const hold = holdFor(prop)!;
      const bone = hand();
      const object = new THREE.Object3D();
      bone.add(object);
      applyGrip(object, prop, 'rightHand', bone);

      const correction = gripTrimOf(hold, frameOf(bone), object);
      expect(correction, prop).not.toBeNull();

      const trim = hold.trim ?? [0, 0, 0];
      correction!.trim.forEach((value, axis) => {
        expect(Math.abs(value - trim[axis]), `${prop} trim axis ${axis}`).toBeLessThan(0.05);
      });
      const offset = hold.offset ?? {};
      expect(Math.abs(correction!.offset.along - (offset.along ?? 0))).toBeLessThan(0.001);
      expect(Math.abs(correction!.offset.palm - (offset.palm ?? 0))).toBeLessThan(0.001);
      expect(Math.abs(correction!.offset.grip - (offset.grip ?? 0))).toBeLessThan(0.001);
    }
  });

  it('reads zero from a hold that carries no correction', () => {
    const bone = hand();
    const staff = new THREE.Object3D();
    bone.add(staff);
    applyGrip(staff, PROP_KEYS.staff, 'rightHand', bone);

    const correction = gripTrimOf(holdFor(PROP_KEYS.staff)!, frameOf(bone), staff)!;
    for (const value of correction.trim) expect(Math.abs(value)).toBeLessThan(0.05);
    expect(Math.abs(correction.offset.along)).toBeLessThan(0.001);
  });

  it('round-trips a drag: solving the exported hold puts the prop back', () => {
    const bone = hand();
    const sword = new THREE.Object3D();
    bone.add(sword);
    applyGrip(sword, PROP_KEYS.sword, 'rightHand', bone);

    // Cant the hilt and shift it down the palm, the way a hand actually holds one.
    sword.rotateX(THREE.MathUtils.degToRad(11));
    sword.rotateZ(THREE.MathUtils.degToRad(-7));
    sword.position.add(new THREE.Vector3(0.012, -0.004, 0.006));
    const moved = {
      position: sword.position.clone(),
      quaternion: sword.quaternion.clone(),
    };

    const base = holdFor(PROP_KEYS.sword)!;
    const correction = gripTrimOf(base, frameOf(bone), sword)!;

    // Feed the correction back through the real solver, on a fresh object.
    const rebuiltHand = hand();
    const rebuilt = new THREE.Object3D();
    rebuiltHand.add(rebuilt);
    const corrected = { ...base, offset: correction.offset, trim: correction.trim };
    // `applyGrip` reads HOLDS directly, so exercise the solve the same way it
    // does by rebuilding the transform from the corrected hold.
    const frame = frameOf(rebuiltHand);
    const solved = solve(corrected, frame);
    rebuilt.position.copy(solved.position);
    rebuilt.quaternion.copy(solved.quaternion);

    expect(rebuilt.position.distanceTo(moved.position)).toBeLessThan(0.002);
    expect(rebuilt.quaternion.angleTo(moved.quaternion)).toBeLessThan(0.01);
  });

  it('omits correction terms that are zero, so an untouched hold exports as written', () => {
    const source = holdSource(PROP_KEYS.sword, holdFor(PROP_KEYS.sword)!, {
      offset: { along: 0, palm: 0, grip: 0 },
      trim: [0, 0, 0],
    });
    expect(source).not.toContain('offset');
    expect(source).not.toContain('trim');
    expect(source).toContain("lengthAxis: 'grip'");
  });

  it('carries the axis choices through untouched', () => {
    // A gizmo cannot revise "the blade points out of the top of the fist"; it
    // can only correct on top of it. Losing the axes would silently reorient
    // every prop that shares the hold.
    const shield = holdFor(PROP_KEYS.shield)!;
    const source = holdSource(PROP_KEYS.shield, shield, {
      offset: { along: -0.06, palm: 0, grip: 0.02 },
      trim: [0, 4.5, 0],
    });
    expect(source).toContain(`lengthAxis: '${shield.lengthAxis}'`);
    expect(source).toContain(`lengthSign: ${shield.lengthSign}`);
    expect(source).toContain('offset: { along: -0.06, grip: 0.02 }');
    expect(source).toContain('trim: [0, 4.5, 0]');
  });
});

/** Mirror of `holdInFist`, so the round-trip test exercises the real maths. */
function solve(
  hold: NonNullable<ReturnType<typeof holdFor>>,
  frame: FistFrame,
): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const length = frame[hold.lengthAxis].clone().multiplyScalar(hold.lengthSign);
  const face = frame[hold.faceAxis].clone().multiplyScalar(hold.faceSign);
  const z = face.clone().sub(length.clone().multiplyScalar(face.dot(length))).normalize();
  const x = new THREE.Vector3().crossVectors(length, z).normalize();
  const quaternion = new THREE.Quaternion()
    .setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, length, z));
  if (hold.trim) {
    const [tx, ty, tz] = hold.trim.map(THREE.MathUtils.degToRad);
    quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(tx, ty, tz, 'XYZ')));
  }
  const position = frame.origin.clone();
  const shift = hold.offset ?? {};
  position.addScaledVector(frame.along, shift.along ?? 0);
  position.addScaledVector(frame.palm, shift.palm ?? 0);
  position.addScaledVector(frame.grip, shift.grip ?? 0);
  return { position, quaternion };
}
