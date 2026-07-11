import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  canProjectileClaimPendingFireball,
  createPendingFireballCosmeticCast,
  fireballVisualDirectionFromSpawn,
  fireballVisualPositionFromClaim,
  fireballVisualSpawnOriginFromCaster,
  updatePendingFireballVisualOrigin,
} from './fireballVisuals';

describe('fireball visual handoff helpers', () => {
  it('places the cosmetic spawn in front of the rendered caster', () => {
    const origin = fireballVisualSpawnOriginFromCaster(
      new THREE.Vector3(10, 2, 5),
      new THREE.Vector3(0, 0, -1),
    );

    expect(origin.x).toBeCloseTo(10.42);
    expect(origin.y).toBeCloseTo(3.45);
    expect(origin.z).toBeCloseTo(3.8);
  });

  it('aims hand-offset fireballs back through the center aim line', () => {
    const direction = fireballVisualDirectionFromSpawn(
      new THREE.Vector3(10, 2, 5),
      new THREE.Vector3(0, 0, -1),
    );

    expect(direction.x).toBeLessThan(0);
    expect(direction.z).toBeLessThan(-0.99);
  });

  it('keeps pending cosmetic visuals attached to the current rendered caster origin', () => {
    const cast = createPendingFireballCosmeticCast({
      casterKey: 'caster',
      direction: new THREE.Vector3(0, 0, -1),
      origin: new THREE.Vector3(0, 0, 0),
      startedAt: 1000,
    });

    const nextPosition = updatePendingFireballVisualOrigin(
      cast,
      new THREE.Vector3(4, 5, 6),
    );

    expect(nextPosition.x).toBeCloseTo(4.42);
    expect(nextPosition.y).toBeCloseTo(6.45);
    expect(nextPosition.z).toBeCloseTo(4.8);
    expect(cast.currentPosition).toBe(nextPosition);
  });

  it('advances claimed local fireballs along the visual claim line', () => {
    const position = fireballVisualPositionFromClaim(
      new THREE.Vector3(10, 2, 5),
      new THREE.Vector3(0, 0, -1),
      3.5,
    );

    expect(position.x).toBeCloseTo(10);
    expect(position.y).toBeCloseTo(2);
    expect(position.z).toBeCloseTo(1.5);
  });

  it('allows only fresh projectiles to claim pending cosmetic casts', () => {
    expect(canProjectileClaimPendingFireball(0)).toBe(true);
    expect(canProjectileClaimPendingFireball(0.75)).toBe(true);
    expect(canProjectileClaimPendingFireball(0.76)).toBe(false);
  });
});
