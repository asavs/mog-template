/**
 * The export has to round-trip: the source it emits must place the prop where
 * the prop currently is. A rounding slip or a dropped axis here is worse than
 * no tool, because the numbers look authoritative and land in the repo.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { placementOf, placementSource, sceneSource } from './placements';

function objectAt(
  position: [number, number, number],
  rotationDegrees: [number, number, number] = [0, 0, 0],
  scale = 1,
): THREE.Object3D {
  const object = new THREE.Object3D();
  object.position.set(...position);
  const [x, y, z] = rotationDegrees.map(THREE.MathUtils.degToRad);
  object.rotation.set(x, y, z, 'XYZ');
  object.scale.setScalar(scale);
  return object;
}

describe('placement export', () => {
  it('emits turn alone when a prop is only yawed', () => {
    // Scenery stands on its base, so turning is the only thing it ever needs
    // and the source should stay as simple as the scenes are written by hand.
    expect(placementOf('prop.barrel', objectAt([1, 0, -2], [0, 30, 0]))).toEqual({
      key: 'prop.barrel',
      at: [1, 0, -2],
      turn: 30,
    });
  });

  it('emits the full triple once a prop is tipped', () => {
    expect(placementOf('prop.sword', objectAt([-2.35, 0.38, -1.15], [5, 28, -8]))).toEqual({
      key: 'prop.sword',
      at: [-2.35, 0.38, -1.15],
      rotate: [5, 28, -8],
    });
  });

  it('omits rotation entirely when there is none', () => {
    expect(placementOf('prop.crate_wooden', objectAt([0, 0, 0]))).toEqual({
      key: 'prop.crate_wooden',
      at: [0, 0, 0],
    });
  });

  it('keeps a scale only when it is not 1', () => {
    expect(placementOf('prop.table_large', objectAt([0, 0, 0], [0, 0, 0], 0.7)))
      .toEqual({ key: 'prop.table_large', at: [0, 0, 0], scale: 0.7 });
    expect(placementOf('prop.table_large', objectAt([0, 0, 0])))
      .not.toHaveProperty('scale');
  });

  it('round-trips: the emitted numbers put the prop back where it was', () => {
    const original = objectAt([1.234, 0.567, -2.891], [12, -47, 8]);
    const placement = placementOf('prop.axe', original);

    const rebuilt = new THREE.Object3D();
    rebuilt.position.set(...placement.at);
    const [x, y, z] = (placement.rotate ?? [0, placement.turn ?? 0, 0])
      .map(THREE.MathUtils.degToRad);
    rebuilt.rotation.set(x, y, z, 'XYZ');

    expect(rebuilt.position.distanceTo(original.position)).toBeLessThan(0.01);
    expect(rebuilt.quaternion.angleTo(original.quaternion)).toBeLessThan(0.02);
  });

  it('never emits negative zero, which reads as a typo in the source', () => {
    const placement = placementOf('prop.barrel', objectAt([-0.001, 0, -0.004]));
    expect(placementSource(placement)).not.toContain('-0,');
    expect(placementSource(placement)).not.toContain('-0]');
  });

  it('emits a line that matches how scenes are written', () => {
    expect(placementSource({ key: 'prop.stool', at: [0, 0, -0.06] }))
      .toBe("      { key: 'prop.stool', at: [0, 0, -0.06] },");
    expect(placementSource({ key: 'prop.sword', at: [0, 0.4, 0], rotate: [5, 28, -8] }))
      .toBe("      { key: 'prop.sword', at: [0, 0.4, 0], rotate: [5, 28, -8] },");
  });

  it('wraps a whole scene as a pasteable place array', () => {
    const source = sceneSource([
      { key: 'prop.dummy', at: [0.35, 0, 2.05], turn: 180 },
      { key: 'prop.barrel', at: [2.9, 0, -1.1] },
    ]);
    expect(source.split('\n')).toHaveLength(4);
    expect(source.startsWith('    place: [')).toBe(true);
    expect(source.trimEnd().endsWith('],')).toBe(true);
  });
});
