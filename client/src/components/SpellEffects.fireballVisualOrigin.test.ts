import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { FireballProjectile } from '../generated/types';
import { fireballServerPosition, fireballVisualSpawnOrigin } from './SpellEffects';
import type { SpellCasterVisualOrigin } from './spellVisualOrigins';

function makeProjectile(overrides: Partial<FireballProjectile> = {}): FireballProjectile {
  return {
    id: 1n,
    caster: { toHexString: () => 'caster-1' },
    position: { x: 10, y: 2, z: -4 },
    previousPosition: { x: 9, y: 2, z: -4 },
    direction: { x: 0, y: 0, z: -1 },
    spawnedAtTick: 10n,
    maxDistance: 30,
    distanceTraveled: 0.5,
    createdAt: {} as FireballProjectile['createdAt'],
    ...overrides,
  } as FireballProjectile;
}

describe('fireball visual spawn origin', () => {
  it('starts near the rendered caster origin while a projectile is fresh', () => {
    const casterOrigins = new Map<string, SpellCasterVisualOrigin>([
      ['caster-1', {
        position: new THREE.Vector3(2, 3, 4),
        rotationY: Math.PI,
      }],
    ]);

    const origin = fireballVisualSpawnOrigin(makeProjectile(), casterOrigins);

    expect(origin?.x).toBeCloseTo(2.42);
    expect(origin?.y).toBeCloseTo(4.45);
    expect(origin?.z).toBeCloseTo(2.8);
  });

  it('falls back to the authoritative projectile position without a caster visual origin', () => {
    const projectile = makeProjectile();

    expect(fireballVisualSpawnOrigin(projectile, new Map())).toBeNull();
    expect(fireballServerPosition(projectile).toArray()).toEqual([10, 2, -4]);
  });

  it('does not pull old projectiles back to the caster', () => {
    const casterOrigins = new Map<string, SpellCasterVisualOrigin>([
      ['caster-1', {
        position: new THREE.Vector3(2, 3, 4),
        rotationY: 0,
      }],
    ]);

    const origin = fireballVisualSpawnOrigin(
      makeProjectile({ distanceTraveled: 0.76 }),
      casterOrigins,
    );

    expect(origin).toBeNull();
  });
});
