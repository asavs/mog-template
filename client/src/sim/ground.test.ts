import { describe, expect, it } from 'vitest';
import type { ArenaCollider } from './arena.generated';
import {
  PLAYER_COLLISION_RADIUS,
  penetrationPushOut,
  resolveAgainstColliders,
  resolvePlayerMovement,
} from './ground';

describe('arena ground collision parity', () => {
  it('allows movement through open space', () => {
    const current = { x: 0, y: 0, z: 0 };
    const desired = { x: 1, y: 0, z: -1 };

    expect(resolvePlayerMovement(current, desired)).toEqual(desired);
  });

  it('stops movement into wall_n at the playable edge', () => {
    const resolved = resolvePlayerMovement(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -30 },
    );

    expect(resolved.x).toBeCloseTo(0, 4);
    expect(resolved.z).toBeCloseTo(-19.55, 4);
  });

  it('pushes a player radially out of pillar_nw', () => {
    const resolved = resolvePlayerMovement(
      { x: 0, y: 0, z: 0 },
      { x: -10.5, y: 0, z: -10 },
    );

    expect(resolved.x).toBeCloseTo(-11.35, 4);
    expect(resolved.z).toBeCloseTo(-10, 4);
  });

  it('uses the shallow open axis for a box push-out', () => {
    const blocker: ArenaCollider = {
      id: 'synthetic_box',
      center: [0, 0, 0],
      shape: { kind: 'box', halfExtents: [0.5, 1, 0.5], yaw: 0 },
    };

    const push = penetrationPushOut({ x: 0.8, y: 3, z: 0.2 }, blocker);

    expect(push).not.toBeNull();
    expect(push![0]).toBeCloseTo(0.15, 4);
    expect(push![1]).toBeCloseTo(0, 4);
  });

  it('rotates a box push-out back into world space', () => {
    const blocker: ArenaCollider = {
      id: 'rotated_box',
      center: [0, 0, 0],
      shape: {
        kind: 'box',
        halfExtents: [0.5, 1, 0.5],
        yaw: Math.PI / 2,
      },
    };

    const push = penetrationPushOut({ x: 0.2, y: 0, z: 0.8 }, blocker);

    expect(push).not.toBeNull();
    expect(push![0]).toBeCloseTo(0, 4);
    expect(push![1]).toBeCloseTo(0.15, 4);
  });

  it('lets two blockers correct both axes during the same solve', () => {
    const blockers: readonly ArenaCollider[] = [
      {
        id: 'x_blocker',
        center: [0, 0, 0],
        shape: { kind: 'box', halfExtents: [0.5, 1, 5], yaw: 0 },
      },
      {
        id: 'z_blocker',
        center: [0, 0, 0],
        shape: { kind: 'box', halfExtents: [5, 1, 0.5], yaw: 0 },
      },
    ];

    const resolved = resolveAgainstColliders(
      { x: 0.2, y: 0, z: 0.2 },
      blockers,
    );

    expect(resolved.x).toBeCloseTo(0.95, 4);
    expect(resolved.z).toBeCloseTo(0.95, 4);
  });

  it('clamps both axes at an arena corner', () => {
    const resolved = resolvePlayerMovement(
      { x: 0, y: 0, z: 0 },
      { x: 100, y: 0, z: -100 },
    );

    expect(resolved.x).toBeCloseTo(20 - PLAYER_COLLISION_RADIUS, 4);
    expect(resolved.z).toBeCloseTo(-20 + PLAYER_COLLISION_RADIUS, 4);
  });

  it('preserves vertical motion while resolving XZ collision', () => {
    const blocker: ArenaCollider = {
      id: 'synthetic_box',
      center: [0, 0, 0],
      shape: { kind: 'box', halfExtents: [0.5, 1, 0.5], yaw: 0 },
    };

    const resolved = resolveAgainstColliders(
      { x: 0.8, y: 3, z: 0.2 },
      [blocker],
    );

    expect(resolved.x).toBeCloseTo(0.95, 4);
    expect(resolved.y).toBe(3);
    expect(resolved.z).toBeCloseTo(0.2, 4);
  });
});
