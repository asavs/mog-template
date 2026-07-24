/**
 * CC01 is the canonical static-triangle asset for the castle controller.
 *
 * The uniform grid is only a broad phase: it yields a stable, sorted list of
 * candidate triangle ids. Collision always runs against the baked vertices and
 * indices in the narrow phase.
 *
 * Little-endian layout:
 *   fixed header (232 bytes), vertices (f32 x 3), triangle indices (u32 x 3),
 *   cell offsets (u32 x (gridX * gridY * gridZ + 1)), triangle ids (u32).
 */
import fs from 'node:fs';

export const CASTLE_COLLISION_MAGIC = 'CC01';
export const CASTLE_COLLISION_VERSION = 1;
export const CASTLE_COLLISION_HEADER_BYTES = 232;
const SOURCE_NAME_BYTES = 64;
const SOURCE_HASH_BYTES = 32;

/** @param {{
 *   vertices: Float32Array, indices: Uint32Array,
 *   grid: { x: number, y: number, z: number, offsets: Uint32Array, triangleIds: Uint32Array },
 *   min: number[], max: number[], terrainScale: number, terrainOffset: number[],
 *   sourceNodeMatrix: number[], sourceHash: Buffer, sourceNodeName: string,
 * }} data */
export function encodeCastleCollisionBinary(data) {
  if (data.vertices.length % 3 !== 0 || data.indices.length % 3 !== 0) {
    throw new Error('Castle collision vertices and indices must be vec3 triplets');
  }
  const cellCount = data.grid.x * data.grid.y * data.grid.z;
  if (data.grid.offsets.length !== cellCount + 1) {
    throw new Error(`Expected ${cellCount + 1} grid offsets, got ${data.grid.offsets.length}`);
  }
  if (data.grid.offsets[cellCount] !== data.grid.triangleIds.length) {
    throw new Error('Final grid offset must equal triangle id count');
  }
  if (data.sourceHash.length !== SOURCE_HASH_BYTES) {
    throw new Error('Castle collision source hash must be SHA-256 bytes');
  }
  if (data.sourceNodeMatrix.length !== 16) {
    throw new Error('Castle collision source node matrix must have 16 values');
  }

  const vertexBytes = data.vertices.length * 4;
  const indexBytes = data.indices.length * 4;
  const offsetBytes = data.grid.offsets.length * 4;
  const triangleIdBytes = data.grid.triangleIds.length * 4;
  const output = Buffer.alloc(CASTLE_COLLISION_HEADER_BYTES + vertexBytes + indexBytes + offsetBytes + triangleIdBytes);
  output.write(CASTLE_COLLISION_MAGIC, 0, 4, 'ascii');
  output.writeUInt32LE(CASTLE_COLLISION_VERSION, 4);
  output.writeUInt32LE(CASTLE_COLLISION_HEADER_BYTES, 8);
  output.writeUInt32LE(data.vertices.length / 3, 12);
  output.writeUInt32LE(data.indices.length / 3, 16);
  output.writeUInt32LE(data.grid.x, 20);
  output.writeUInt32LE(data.grid.y, 24);
  output.writeUInt32LE(data.grid.z, 28);

  let cursor = 32;
  for (const value of [...data.min, ...data.max]) {
    output.writeFloatLE(value, cursor);
    cursor += 4;
  }
  output.writeFloatLE(data.terrainScale, cursor);
  cursor += 4;
  for (const value of data.terrainOffset) {
    output.writeFloatLE(value, cursor);
    cursor += 4;
  }
  for (const value of data.sourceNodeMatrix) {
    output.writeFloatLE(value, cursor);
    cursor += 4;
  }
  data.sourceHash.copy(output, cursor);
  cursor += SOURCE_HASH_BYTES;
  output.write(data.sourceNodeName, cursor, SOURCE_NAME_BYTES, 'utf8');

  cursor = CASTLE_COLLISION_HEADER_BYTES;
  for (const value of data.vertices) {
    output.writeFloatLE(value, cursor);
    cursor += 4;
  }
  for (const value of data.indices) {
    output.writeUInt32LE(value, cursor);
    cursor += 4;
  }
  for (const value of data.grid.offsets) {
    output.writeUInt32LE(value, cursor);
    cursor += 4;
  }
  for (const value of data.grid.triangleIds) {
    output.writeUInt32LE(value, cursor);
    cursor += 4;
  }
  return output;
}

export function writeCastleCollisionMeta(filePath, data) {
  const content = `/** Auto-generated CC01 asset metadata. Do not edit by hand. */\n`
    + `export const CASTLE_COLLISION_BIN_PUBLIC_PATH = 'models/terrain/castle-collision.bin';\n`
    + `export const CASTLE_COLLISION_VERSION = ${CASTLE_COLLISION_VERSION};\n`
    + `export const CASTLE_COLLISION_SOURCE_NODE = ${JSON.stringify(data.sourceNodeName)};\n`
    + `export const CASTLE_COLLISION_SOURCE_SHA256 = ${JSON.stringify(data.sourceHash.toString('hex'))};\n`
    + `export const CASTLE_COLLISION_TRIANGLE_COUNT = ${data.indices.length / 3};\n`
    + `export const CASTLE_COLLISION_GRID = { x: ${data.grid.x}, y: ${data.grid.y}, z: ${data.grid.z} } as const;\n`;
  fs.writeFileSync(filePath, content);
}
