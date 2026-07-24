import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  castleCollisionAsset,
  castleTriangleCandidates,
  loadCastleCollisionFromArrayBuffer,
} from './castleCollision';
import {
  CASTLE_COLLISION_SOURCE_NODE,
  CASTLE_COLLISION_SOURCE_SHA256,
  CASTLE_COLLISION_TRIANGLE_COUNT,
} from './castleCollisionMeta';

describe('castle collision CC01 asset', () => {
  it('loads the canonical collision triangles and deterministic broad phase', () => {
    const bytes = readFileSync(new URL('../public/models/terrain/castle-collision.bin', import.meta.url));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    loadCastleCollisionFromArrayBuffer(buffer);

    const asset = castleCollisionAsset();
    expect(asset.sourceNodeName).toBe(CASTLE_COLLISION_SOURCE_NODE);
    expect(asset.sourceHash).toBe(CASTLE_COLLISION_SOURCE_SHA256);
    expect(asset.indices.length / 3).toBe(CASTLE_COLLISION_TRIANGLE_COUNT);
    expect(asset.grid.offsets[asset.grid.offsets.length - 1]).toBe(asset.grid.triangleIds.length);

    const candidates = castleTriangleCandidates(asset.min, asset.max);
    expect(candidates).not.toHaveLength(0);
    expect(candidates.every((id, index) => index === 0 || candidates[index - 1] < id)).toBe(true);

    expect(castleTriangleCandidates(
      [asset.max[0] + 100, asset.max[1] + 100, asset.max[2] + 100],
      [asset.max[0] + 101, asset.max[1] + 101, asset.max[2] + 101],
    )).toEqual([]);
  });
});
