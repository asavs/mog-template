import * as THREE from 'three';
import { publicAssetPath } from './publicAssets';
import {
  HEIGHTMAP_BIN_PUBLIC_PATH,
  HEIGHTMAP_MAX_X,
  HEIGHTMAP_MAX_Z,
  HEIGHTMAP_MIN_X,
  HEIGHTMAP_MIN_Z,
  HEIGHTMAP_SIZE,
  TERRAIN_MAX_WALKABLE_SLOPE_DEGREES,
} from './heightmapMeta';

export {
  HEIGHTMAP_MAX_X,
  HEIGHTMAP_MAX_Z,
  HEIGHTMAP_MIN_X,
  HEIGHTMAP_MIN_Z,
  HEIGHTMAP_SIZE,
  TERRAIN_MAX_WALKABLE_SLOPE_DEGREES,
};

const TERRAIN_MAX_WALKABLE_SLOPE = Math.tan(
  THREE.MathUtils.degToRad(TERRAIN_MAX_WALKABLE_SLOPE_DEGREES),
);

let heights: Float32Array | null = null;
let walkable: Uint8Array | null = null;
let loadPromise: Promise<void> | null = null;

function requireHeights(): Float32Array {
  if (!heights) {
    throw new Error('Heightmap not loaded — call await initHeightmap() before sampling');
  }
  return heights;
}

function requireWalkable(): Uint8Array {
  if (!walkable) {
    throw new Error('Heightmap not loaded — call await initHeightmap() before sampling');
  }
  return walkable;
}

/** Decode HM01 binary (see scripts/convert-heightmap-binary.mjs). */
export function loadHeightmapFromArrayBuffer(buffer: ArrayBuffer): void {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== 'HM01') {
    throw new Error(`Bad heightmap magic: ${magic}`);
  }
  const size = view.getUint32(4, true);
  if (size !== HEIGHTMAP_SIZE) {
    throw new Error(`Heightmap size ${size} != expected ${HEIGHTMAP_SIZE}`);
  }

  const count = size * size;
  const heightsOffset = 4 + 4 + 4 * 6;
  const nextHeights = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    nextHeights[i] = view.getFloat32(heightsOffset + i * 4, true);
  }

  const walkOffset = heightsOffset + count * 4;
  const walkBytes = Math.ceil(count / 8);
  const nextWalkable = new Uint8Array(buffer, walkOffset, walkBytes);

  heights = nextHeights;
  walkable = new Uint8Array(nextWalkable); // copy out of the shared buffer
}

/**
 * Load collision heightmap from the public binary asset.
 * Safe to call multiple times; concurrent callers share one fetch.
 */
export function initHeightmap(
  url = publicAssetPath(HEIGHTMAP_BIN_PUBLIC_PATH),
): Promise<void> {
  if (heights && walkable) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = fetch(url)
      .then(response => {
        if (!response.ok) {
          throw new Error(`Failed to fetch heightmap: ${response.status} ${url}`);
        }
        return response.arrayBuffer();
      })
      .then(buffer => {
        loadHeightmapFromArrayBuffer(buffer);
      })
      .catch(error => {
        loadPromise = null;
        throw error;
      });
  }
  return loadPromise;
}

/** Test/helper: inject samples without fetch. */
export function loadHeightmapFromBytes(bytes: Uint8Array): void {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  loadHeightmapFromArrayBuffer(copy);
}

export function isHeightmapReady(): boolean {
  return heights != null && walkable != null;
}

export function terrainHeightAt(position: THREE.Vector3): number {
  return sampleHeight(position.x, position.z);
}

export function sampleHeight(x: number, z: number): number {
  const u = THREE.MathUtils.clamp((x - HEIGHTMAP_MIN_X) / (HEIGHTMAP_MAX_X - HEIGHTMAP_MIN_X), 0, 1);
  const v = THREE.MathUtils.clamp((z - HEIGHTMAP_MIN_Z) / (HEIGHTMAP_MAX_Z - HEIGHTMAP_MIN_Z), 0, 1);
  const gx = u * (HEIGHTMAP_SIZE - 1);
  const gz = v * (HEIGHTMAP_SIZE - 1);
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const x1 = Math.min(x0 + 1, HEIGHTMAP_SIZE - 1);
  const z1 = Math.min(z0 + 1, HEIGHTMAP_SIZE - 1);
  const tx = gx - x0;
  const tz = gz - z0;
  const h00 = heightAtIndex(x0, z0);
  const h10 = heightAtIndex(x1, z0);
  const h01 = heightAtIndex(x0, z1);
  const h11 = heightAtIndex(x1, z1);
  const h0 = THREE.MathUtils.lerp(h00, h10, tx);
  const h1 = THREE.MathUtils.lerp(h01, h11, tx);
  return THREE.MathUtils.lerp(h0, h1, tz);
}

export function isTerrainWalkableAt(x: number, z: number): boolean {
  const u = THREE.MathUtils.clamp((x - HEIGHTMAP_MIN_X) / (HEIGHTMAP_MAX_X - HEIGHTMAP_MIN_X), 0, 1);
  const v = THREE.MathUtils.clamp((z - HEIGHTMAP_MIN_Z) / (HEIGHTMAP_MAX_Z - HEIGHTMAP_MIN_Z), 0, 1);
  const gridX = Math.round(u * (HEIGHTMAP_SIZE - 1));
  const gridZ = Math.round(v * (HEIGHTMAP_SIZE - 1));
  return isWalkableIndex(gridZ * HEIGHTMAP_SIZE + gridX)
    && terrainSlopeAt(x, z) <= TERRAIN_MAX_WALKABLE_SLOPE;
}

export function terrainSlopeAt(x: number, z: number): number {
  const cellX = (HEIGHTMAP_MAX_X - HEIGHTMAP_MIN_X) / (HEIGHTMAP_SIZE - 1);
  const cellZ = (HEIGHTMAP_MAX_Z - HEIGHTMAP_MIN_Z) / (HEIGHTMAP_SIZE - 1);
  const left = sampleHeight(x - cellX, z);
  const right = sampleHeight(x + cellX, z);
  const down = sampleHeight(x, z - cellZ);
  const up = sampleHeight(x, z + cellZ);
  const dhdx = (right - left) / (cellX * 2);
  const dhdz = (up - down) / (cellZ * 2);
  return Math.hypot(dhdx, dhdz);
}

function heightAtIndex(x: number, z: number): number {
  return requireHeights()[z * HEIGHTMAP_SIZE + x];
}

function isWalkableIndex(index: number): boolean {
  const byte = requireWalkable()[index >> 3];
  return (byte & (0x80 >> (index & 7))) !== 0;
}
