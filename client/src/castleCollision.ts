import { publicAssetPath } from './publicAssets';
import {
  CASTLE_COLLISION_BIN_PUBLIC_PATH,
  CASTLE_COLLISION_VERSION,
} from './castleCollisionMeta';

const HEADER_BYTES = 232;

export interface CastleCollisionAsset {
  readonly sourceNodeName: string;
  readonly sourceHash: string;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly terrainScale: number;
  readonly terrainOffset: readonly [number, number, number];
  readonly sourceNodeMatrix: readonly number[];
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly grid: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly offsets: Uint32Array;
    readonly triangleIds: Uint32Array;
  };
}

let collision: CastleCollisionAsset | null = null;
let loadPromise: Promise<void> | null = null;

function readAscii(view: DataView, start: number, length: number): string {
  let value = '';
  for (let index = 0; index < length; index += 1) {
    const char = view.getUint8(start + index);
    if (char === 0) break;
    value += String.fromCharCode(char);
  }
  return value;
}

function readHash(view: DataView, start: number): string {
  return Array.from({ length: 32 }, (_, index) => view.getUint8(start + index).toString(16).padStart(2, '0')).join('');
}

/** Decode CC01. The grid only chooses stable broad-phase candidates; all contacts use the original indexed triangles. */
export function loadCastleCollisionFromArrayBuffer(buffer: ArrayBuffer): void {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`Castle collision buffer too short: ${buffer.byteLength} bytes`);
  }
  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== 'CC01') {
    throw new Error(`Bad castle collision magic: ${readAscii(view, 0, 4)}`);
  }
  const version = view.getUint32(4, true);
  if (version !== CASTLE_COLLISION_VERSION) {
    throw new Error(`Castle collision version ${version} != expected ${CASTLE_COLLISION_VERSION}`);
  }
  const headerBytes = view.getUint32(8, true);
  if (headerBytes !== HEADER_BYTES) {
    throw new Error(`Castle collision header ${headerBytes} != expected ${HEADER_BYTES}`);
  }
  const vertexCount = view.getUint32(12, true);
  const triangleCount = view.getUint32(16, true);
  const gridX = view.getUint32(20, true);
  const gridY = view.getUint32(24, true);
  const gridZ = view.getUint32(28, true);
  if (!vertexCount || !triangleCount || !gridX || !gridY || !gridZ) {
    throw new Error('Castle collision contains an empty mesh or grid');
  }

  const min: [number, number, number] = [view.getFloat32(32, true), view.getFloat32(36, true), view.getFloat32(40, true)];
  const max: [number, number, number] = [view.getFloat32(44, true), view.getFloat32(48, true), view.getFloat32(52, true)];
  const terrainScale = view.getFloat32(56, true);
  const terrainOffset: [number, number, number] = [view.getFloat32(60, true), view.getFloat32(64, true), view.getFloat32(68, true)];
  const sourceNodeMatrix = Array.from({ length: 16 }, (_, index) => view.getFloat32(72 + index * 4, true));
  const sourceHash = readHash(view, 136);
  const sourceNodeName = readAscii(view, 168, 64);
  const cellCount = gridX * gridY * gridZ;
  if (!Number.isSafeInteger(cellCount)) throw new Error('Castle collision grid dimensions overflow');
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite) || min.some((value, axis) => value >= max[axis])) {
    throw new Error('Castle collision bounds are not finite and ordered');
  }
  const verticesOffset = headerBytes;
  const indicesOffset = verticesOffset + vertexCount * 3 * 4;
  const offsetsOffset = indicesOffset + triangleCount * 3 * 4;
  const triangleIdsOffset = offsetsOffset + (cellCount + 1) * 4;
  if (buffer.byteLength < triangleIdsOffset) {
    throw new Error('Castle collision buffer truncated before grid offsets');
  }
  const triangleIdCount = view.getUint32(offsetsOffset + cellCount * 4, true);
  const requiredBytes = triangleIdsOffset + triangleIdCount * 4;
  if (buffer.byteLength !== requiredBytes) {
    throw new Error(`Castle collision buffer truncated: need ${requiredBytes}, got ${buffer.byteLength}`);
  }

  const vertices = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(triangleCount * 3);
  const offsets = new Uint32Array(cellCount + 1);
  const triangleIds = new Uint32Array(triangleIdCount);
  for (let index = 0; index < vertices.length; index += 1) vertices[index] = view.getFloat32(verticesOffset + index * 4, true);
  for (let index = 0; index < indices.length; index += 1) indices[index] = view.getUint32(indicesOffset + index * 4, true);
  for (let index = 0; index < offsets.length; index += 1) offsets[index] = view.getUint32(offsetsOffset + index * 4, true);
  for (let index = 0; index < triangleIds.length; index += 1) triangleIds[index] = view.getUint32(triangleIdsOffset + index * 4, true);
  if (offsets[offsets.length - 1] !== triangleIds.length) {
    throw new Error('Castle collision grid offset count does not match triangle ids');
  }
  if (indices.some(index => index >= vertexCount)) throw new Error('Castle collision index outside vertex array');
  if (triangleIds.some(id => id >= triangleCount)) throw new Error('Castle collision grid references a missing triangle');
  if (offsets.some((offset, index) => index > 0 && offset < offsets[index - 1])) {
    throw new Error('Castle collision grid offsets are not monotonic');
  }

  collision = { sourceNodeName, sourceHash, min, max, terrainScale, terrainOffset, sourceNodeMatrix, vertices, indices, grid: { x: gridX, y: gridY, z: gridZ, offsets, triangleIds } };
}

export function initCastleCollision(url = publicAssetPath(CASTLE_COLLISION_BIN_PUBLIC_PATH)): Promise<void> {
  if (collision) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = fetch(url)
      .then(response => {
        if (!response.ok) throw new Error(`Failed to fetch castle collision: ${response.status} ${url}`);
        return response.arrayBuffer();
      })
      .then(loadCastleCollisionFromArrayBuffer)
      .catch(error => {
        loadPromise = null;
        throw error;
      });
  }
  return loadPromise;
}

export function castleCollisionAsset(): CastleCollisionAsset {
  if (!collision) throw new Error('Castle collision not loaded — call await initCastleCollision() before querying');
  return collision;
}

export function isCastleCollisionReady(): boolean {
  return collision !== null;
}

/** Returns ascending triangle ids for a world-space AABB, with duplicate grid hits removed. */
export function castleTriangleCandidates(min: readonly number[], max: readonly number[]): readonly number[] {
  const asset = castleCollisionAsset();
  if (
    max[0] < asset.min[0] || min[0] > asset.max[0]
    || max[1] < asset.min[1] || min[1] > asset.max[1]
    || max[2] < asset.min[2] || min[2] > asset.max[2]
  ) {
    return [];
  }
  const { grid } = asset;
  const dims = [grid.x, grid.y, grid.z];
  const start = [0, 1, 2].map(axis => gridCoordinate(min[axis], asset.min[axis], asset.max[axis], dims[axis]));
  const end = [0, 1, 2].map(axis => gridCoordinate(max[axis], asset.min[axis], asset.max[axis], dims[axis]));
  const candidates = new Set<number>();
  for (let z = start[2]; z <= end[2]; z += 1) {
    for (let y = start[1]; y <= end[1]; y += 1) {
      for (let x = start[0]; x <= end[0]; x += 1) {
        const cell = (z * grid.y + y) * grid.x + x;
        for (let index = grid.offsets[cell]; index < grid.offsets[cell + 1]; index += 1) candidates.add(grid.triangleIds[index]);
      }
    }
  }
  return [...candidates].sort((left, right) => left - right);
}

function gridCoordinate(value: number, min: number, max: number, dimension: number): number {
  if (value <= min) return 0;
  if (value >= max) return dimension - 1;
  return Math.min(dimension - 1, Math.max(0, Math.floor(((value - min) / (max - min)) * dimension)));
}
