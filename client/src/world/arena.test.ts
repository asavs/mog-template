/**
 * Synchronous checks for arena architecture + dressing placement contracts.
 * No DOM or GLTF loading — only geometry build and placement data.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ALL_PROP_KEYS, ALL_SCENERY_KEYS } from '../content';
import { buildArena } from './arenaArchitecture';
import { ARENA_DRESSING } from './dressing';

/** Mirrors shared/arena.json spawn points — frozen; do not import across the package boundary. */
const SPAWN_POINTS: readonly (readonly [number, number])[] = [
  [0, -14],
  [0, 14],
  [-14, 0],
  [14, 0],
];

function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse(obj => {
    if ((obj as THREE.Mesh).isMesh) meshes.push(obj as THREE.Mesh);
  });
  return meshes;
}

function attributeArraysEqual(
  a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined,
  b: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const aa = Array.from(a.array as ArrayLike<number>);
  const bb = Array.from(b.array as ArrayLike<number>);
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] !== bb[i]) return false;
  }
  return true;
}

describe('buildArena', () => {
  it('is deterministic across two builds (mesh count, names, position/normal attrs)', () => {
    const a = buildArena();
    const b = buildArena();
    const meshesA = collectMeshes(a);
    const meshesB = collectMeshes(b);

    expect(meshesA.length).toBe(meshesB.length);
    expect(meshesA.length).toBeGreaterThan(0);

    for (let i = 0; i < meshesA.length; i++) {
      const ma = meshesA[i]!;
      const mb = meshesB[i]!;
      expect(ma.name).toBe(mb.name);

      const posA = ma.geometry.getAttribute('position');
      const posB = mb.geometry.getAttribute('position');
      expect(attributeArraysEqual(posA, posB)).toBe(true);

      const normA = ma.geometry.getAttribute('normal');
      const normB = mb.geometry.getAttribute('normal');
      if (normA || normB) {
        expect(attributeArraysEqual(normA, normB)).toBe(true);
      }
    }
  });

  it('stays within geometry budgets (with a non-empty floor)', () => {
    const { stats } = buildArena().userData as {
      stats: { triangles: number; meshes: number; materials: number };
    };

    expect(stats.triangles).toBeGreaterThan(0);
    expect(stats.meshes).toBeGreaterThan(0);
    expect(stats.triangles).toBeLessThanOrEqual(50_000);
    expect(stats.meshes).toBeLessThanOrEqual(40);
    expect(stats.materials).toBeLessThanOrEqual(6);
  });
});

describe('ARENA_DRESSING', () => {
  it('only uses keys from ALL_SCENERY_KEYS or ALL_PROP_KEYS', () => {
    const allowed = new Set<string>([...ALL_SCENERY_KEYS, ...ALL_PROP_KEYS]);
    for (const row of ARENA_DRESSING) {
      expect(allowed.has(row.key), `unknown dressing key: ${row.key}`).toBe(true);
    }
  });

  it('keeps every placement inboard of walls and clear of spawn points', () => {
    for (const row of ARENA_DRESSING) {
      const [x, , z] = row.at;
      expect(Math.abs(x)).toBeLessThan(19.5);
      expect(Math.abs(z)).toBeLessThan(19.5);

      for (const [sx, sz] of SPAWN_POINTS) {
        const dist = Math.hypot(x - sx, z - sz);
        expect(
          dist,
          `placement ${row.key} at (${x}, ${z}) too close to spawn (${sx}, ${sz}): ${dist}`,
        ).toBeGreaterThanOrEqual(1.2);
      }
    }
  });
});
