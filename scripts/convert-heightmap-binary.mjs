/**
 * One-shot / bake helper: turn the legacy source-embedded height grid into
 * a compact binary used by client + server loaders.
 *
 * Format (little-endian):
 *   magic:     "HM01" (4 bytes)
 *   size:      u32   (grid dimension, e.g. 513)
 *   minX,maxX,minZ,maxZ,minH,maxH: f32 × 6
 *   heights:   f32 × (size * size)
 *   walkable:  bit-packed MSB-first per byte, row-major z*size+x
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const LEGACY_RS = path.join(ROOT, 'server/spacetimedb/src/heightmap.rs');
const OUT_CLIENT = path.join(ROOT, 'client/public/models/terrain/heightmap.bin');
const OUT_SERVER = path.join(ROOT, 'server/spacetimedb/src/heightmap.bin');
const OUT_META = path.join(ROOT, 'client/src/heightmapMeta.ts');

const MAGIC = Buffer.from('HM01');

function parseLegacyRust() {
  const rs = fs.readFileSync(LEGACY_RS, 'utf8');
  const sizeMatch = rs.match(/HEIGHTMAP_SIZE:\s*usize\s*=\s*(\d+)/);
  const minX = Number(rs.match(/HEIGHTMAP_MIN_X:\s*f32\s*=\s*([-\d.]+)/)?.[1]);
  const maxX = Number(rs.match(/HEIGHTMAP_MAX_X:\s*f32\s*=\s*([-\d.]+)/)?.[1]);
  const minZ = Number(rs.match(/HEIGHTMAP_MIN_Z:\s*f32\s*=\s*([-\d.]+)/)?.[1]);
  const maxZ = Number(rs.match(/HEIGHTMAP_MAX_Z:\s*f32\s*=\s*([-\d.]+)/)?.[1]);
  const size = Number(sizeMatch?.[1] ?? 513);

  const heightsMatch = rs.match(/const HEIGHTS[^=]*=\s*\[([\s\S]*?)\];/);
  if (!heightsMatch) throw new Error('Could not find HEIGHTS array in legacy heightmap.rs');
  const heights = heightsMatch[1]
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  if (heights.length !== size * size) {
    throw new Error(`Expected ${size * size} heights, got ${heights.length}`);
  }
  if (heights.some(value => !Number.isFinite(value))) {
    throw new Error('Non-finite height sample in legacy data');
  }

  const maskMatch = rs.match(/const WALKABLE_MASK[^=]*=\s*concat!\(([\s\S]*?)\);/);
  if (!maskMatch) throw new Error('Could not find WALKABLE_MASK in legacy heightmap.rs');
  const parts = [...maskMatch[1].matchAll(/"([01]+)"/g)].map(match => match[1]);
  const mask = parts.join('');
  if (mask.length !== size * size) {
    throw new Error(`Expected ${size * size} walkable bits, got ${mask.length}`);
  }

  const minH = heights.reduce((min, value) => Math.min(min, value), Infinity);
  const maxH = heights.reduce((max, value) => Math.max(max, value), -Infinity);

  return { size, minX, maxX, minZ, maxZ, minH, maxH, heights, mask };
}

function packWalkable(mask) {
  const bytes = Buffer.alloc(Math.ceil(mask.length / 8));
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === '1') {
      bytes[i >> 3] |= 0x80 >> (i & 7);
    }
  }
  return bytes;
}

function encodeBinary(data) {
  const header = Buffer.alloc(4 + 4 + 4 * 6);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(data.size, 4);
  header.writeFloatLE(data.minX, 8);
  header.writeFloatLE(data.maxX, 12);
  header.writeFloatLE(data.minZ, 16);
  header.writeFloatLE(data.maxZ, 20);
  header.writeFloatLE(data.minH, 24);
  header.writeFloatLE(data.maxH, 28);

  const heightBytes = Buffer.alloc(data.heights.length * 4);
  for (let i = 0; i < data.heights.length; i += 1) {
    heightBytes.writeFloatLE(data.heights[i], i * 4);
  }

  return Buffer.concat([header, heightBytes, packWalkable(data.mask)]);
}

function writeMeta(data) {
  const content = `/** Auto-generated bounds for the heightmap binary — do not edit by hand. */\n`
    + `export const HEIGHTMAP_SIZE = ${data.size};\n`
    + `export const HEIGHTMAP_MIN_X = ${data.minX};\n`
    + `export const HEIGHTMAP_MAX_X = ${data.maxX};\n`
    + `export const HEIGHTMAP_MIN_Z = ${data.minZ};\n`
    + `export const HEIGHTMAP_MAX_Z = ${data.maxZ};\n`
    + `export const HEIGHTMAP_MIN_H = ${data.minH};\n`
    + `export const HEIGHTMAP_MAX_H = ${data.maxH};\n`
    + `export const TERRAIN_MAX_WALKABLE_SLOPE_DEGREES = 70;\n`
    + `export const HEIGHTMAP_BIN_PUBLIC_PATH = 'models/terrain/heightmap.bin';\n`;
  fs.writeFileSync(OUT_META, content);
}

function main() {
  const data = parseLegacyRust();
  const bin = encodeBinary(data);
  fs.mkdirSync(path.dirname(OUT_CLIENT), { recursive: true });
  fs.writeFileSync(OUT_CLIENT, bin);
  fs.writeFileSync(OUT_SERVER, bin);
  writeMeta(data);
  console.log(`Wrote ${OUT_CLIENT} (${bin.length} bytes)`);
  console.log(`Wrote ${OUT_SERVER}`);
  console.log(`Wrote ${OUT_META}`);
  console.log(`Grid ${data.size}×${data.size}, heights [${data.minH.toFixed(2)}, ${data.maxH.toFixed(2)}]`);
}

main();
