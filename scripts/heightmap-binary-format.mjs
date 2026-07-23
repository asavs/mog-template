/**
 * HM01 heightmap binary codec shared by bake + convert helpers.
 *
 * Format (little-endian):
 *   magic:     "HM01" (4 bytes)
 *   size:      u32
 *   minX,maxX,minZ,maxZ,minH,maxH: f32 × 6
 *   heights:   f32 × (size * size)
 *   walkable:  bit-packed MSB-first per byte, row-major z*size+x
 */
import fs from 'node:fs';

const MAGIC = Buffer.from('HM01');
export const HM01_HEADER_BYTES = 4 + 4 + 4 * 6;

export function packWalkableMask(mask) {
  const bytes = Buffer.alloc(Math.ceil(mask.length / 8));
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === '1') {
      bytes[i >> 3] |= 0x80 >> (i & 7);
    }
  }
  return bytes;
}

/**
 * @param {{
 *   size: number,
 *   minX: number, maxX: number, minZ: number, maxZ: number,
 *   minH: number, maxH: number,
 *   heights: ArrayLike<number>,
 *   mask: string,
 * }} data
 */
export function encodeHeightmapBinary(data) {
  const count = data.size * data.size;
  if (data.heights.length !== count) {
    throw new Error(`Expected ${count} heights, got ${data.heights.length}`);
  }
  if (data.mask.length !== count) {
    throw new Error(`Expected ${count} walkable bits, got ${data.mask.length}`);
  }

  const header = Buffer.alloc(HM01_HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(data.size, 4);
  header.writeFloatLE(data.minX, 8);
  header.writeFloatLE(data.maxX, 12);
  header.writeFloatLE(data.minZ, 16);
  header.writeFloatLE(data.maxZ, 20);
  header.writeFloatLE(data.minH, 24);
  header.writeFloatLE(data.maxH, 28);

  const heightBytes = Buffer.alloc(count * 4);
  for (let i = 0; i < count; i += 1) {
    heightBytes.writeFloatLE(data.heights[i], i * 4);
  }

  return Buffer.concat([header, heightBytes, packWalkableMask(data.mask)]);
}

export function writeHeightmapMeta(filePath, data, slopeDegrees = 70) {
  const content = `/** Auto-generated bounds for the heightmap binary — do not edit by hand. */\n`
    + `export const HEIGHTMAP_SIZE = ${data.size};\n`
    + `export const HEIGHTMAP_MIN_X = ${data.minX};\n`
    + `export const HEIGHTMAP_MAX_X = ${data.maxX};\n`
    + `export const HEIGHTMAP_MIN_Z = ${data.minZ};\n`
    + `export const HEIGHTMAP_MAX_Z = ${data.maxZ};\n`
    + `export const HEIGHTMAP_MIN_H = ${data.minH};\n`
    + `export const HEIGHTMAP_MAX_H = ${data.maxH};\n`
    + `export const TERRAIN_MAX_WALKABLE_SLOPE_DEGREES = ${slopeDegrees};\n`
    + `export const HEIGHTMAP_BIN_PUBLIC_PATH = 'models/terrain/heightmap.bin';\n`;
  fs.writeFileSync(filePath, content);
}
