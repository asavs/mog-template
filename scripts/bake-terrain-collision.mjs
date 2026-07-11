import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const GLB_PATH = path.join(ROOT, 'client/public/models/terrain/dark-fantasy-map-2.glb');
const CLIENT_OUT = path.join(ROOT, 'client/src/heightmap.ts');
const SERVER_OUT = path.join(ROOT, 'server/spacetimedb/src/heightmap.rs');

const TERRAIN_TARGET_SIZE = 3148.07;
const HEIGHTMAP_SIZE = 513;
const MAX_WALKABLE_SLOPE_DEGREES = 70;
const MAX_WALKABLE_SLOPE = Math.tan((MAX_WALKABLE_SLOPE_DEGREES * Math.PI) / 180);
const MIN_WALKABLE_NORMAL_Y = Math.cos((MAX_WALKABLE_SLOPE_DEGREES * Math.PI) / 180);
const MIN_TOP_NORMAL_Y = 0.02;

const COMPONENT_BYTE_SIZE = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

const TYPE_COMPONENTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

function readGlb(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.subarray(0, 4).toString('ascii') !== 'glTF') {
    throw new Error(`${filePath} is not a GLB file`);
  }

  const version = data.readUInt32LE(4);
  if (version !== 2) {
    throw new Error(`Unsupported GLB version ${version}`);
  }

  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < data.length) {
    const chunkLength = data.readUInt32LE(offset);
    const chunkType = data.readUInt32LE(offset + 4);
    offset += 8;
    const chunk = data.subarray(offset, offset + chunkLength);
    offset += chunkLength;

    if (chunkType === 0x4e4f534a) {
      json = JSON.parse(chunk.toString('utf8'));
    } else if (chunkType === 0x004e4942) {
      bin = chunk;
    }
  }

  if (!json || !bin) {
    throw new Error('GLB must contain JSON and BIN chunks');
  }

  return { json, bin };
}

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrix(a, b) {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      for (let k = 0; k < 4; k += 1) {
        out[row * 4 + col] += a[row * 4 + k] * b[k * 4 + col];
      }
    }
  }
  return out;
}

function composeNodeMatrix(node) {
  if (node.matrix) {
    return [
      node.matrix[0], node.matrix[4], node.matrix[8], node.matrix[12],
      node.matrix[1], node.matrix[5], node.matrix[9], node.matrix[13],
      node.matrix[2], node.matrix[6], node.matrix[10], node.matrix[14],
      node.matrix[3], node.matrix[7], node.matrix[11], node.matrix[15],
    ];
  }

  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];

  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  return [
    (1 - (yy + zz)) * sx, (xy - wz) * sy, (xz + wy) * sz, tx,
    (xy + wz) * sx, (1 - (xx + zz)) * sy, (yz - wx) * sz, ty,
    (xz - wy) * sx, (yz + wx) * sy, (1 - (xx + yy)) * sz, tz,
    0, 0, 0, 1,
  ];
}

function transformPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3],
    matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7],
    matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11],
  ];
}

function getAccessorReader(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex];
  const view = gltf.bufferViews[accessor.bufferView];
  const componentSize = COMPONENT_BYTE_SIZE[accessor.componentType];
  const componentCount = TYPE_COMPONENTS[accessor.type];
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const byteStride = view.byteStride ?? componentSize * componentCount;

  function readComponent(offset, componentType) {
    if (componentType === 5126) return bin.readFloatLE(offset);
    if (componentType === 5125) return bin.readUInt32LE(offset);
    if (componentType === 5123) return bin.readUInt16LE(offset);
    if (componentType === 5121) return bin.readUInt8(offset);
    if (componentType === 5122) return bin.readInt16LE(offset);
    if (componentType === 5120) return bin.readInt8(offset);
    throw new Error(`Unsupported component type ${componentType}`);
  }

  return {
    count: accessor.count,
    read(index) {
      const start = byteOffset + index * byteStride;
      if (componentCount === 1) return readComponent(start, accessor.componentType);
      const value = [];
      for (let i = 0; i < componentCount; i += 1) {
        value.push(readComponent(start + i * componentSize, accessor.componentType));
      }
      return value;
    },
  };
}

function isTerrainMesh(label) {
  return /(Landscape|Mesh_0|Object_)/i.test(label)
    && !/(-col|PSX|Tree|Grass|Dandelion|Lavender|Reed|Rock|Pine|Cone|Cylinder|Plane|Cube)/i.test(label);
}

function collectMeshInstances(gltf) {
  const instances = [];
  const scenes = gltf.scenes?.length ? gltf.scenes : [{ nodes: gltf.nodes.map((_, index) => index) }];
  const scene = scenes[gltf.scene ?? 0] ?? scenes[0];

  function visit(nodeIndex, parentMatrix, parentLabel) {
    const node = gltf.nodes[nodeIndex];
    const matrix = multiplyMatrix(parentMatrix, composeNodeMatrix(node));
    const label = [parentLabel, node.name].filter(Boolean).join('/');

    if (node.mesh !== undefined) {
      const mesh = gltf.meshes[node.mesh];
      instances.push({
        meshIndex: node.mesh,
        mesh,
        matrix,
        label: [label, mesh.name].filter(Boolean).join('/'),
      });
    }

    for (const childIndex of node.children ?? []) {
      visit(childIndex, matrix, label);
    }
  }

  for (const nodeIndex of scene.nodes ?? []) {
    visit(nodeIndex, identity(), '');
  }

  return instances;
}

function computeRawBounds(gltf, bin, instances) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const instance of instances) {
    for (const primitive of instance.mesh.primitives ?? []) {
      const positionAccessor = primitive.attributes?.POSITION;
      if (positionAccessor === undefined) continue;

      const positions = getAccessorReader(gltf, bin, positionAccessor);
      for (let i = 0; i < positions.count; i += 1) {
        const point = transformPoint(instance.matrix, positions.read(i));
        for (let axis = 0; axis < 3; axis += 1) {
          min[axis] = Math.min(min[axis], point[axis]);
          max[axis] = Math.max(max[axis], point[axis]);
        }
      }
    }
  }

  return { min, max };
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalizeY(normal) {
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  return length > 0.000001 ? normal[1] / length : 0;
}

function finalTransform(point, scale, offset) {
  return [
    point[0] * scale + offset[0],
    point[1] * scale + offset[1],
    point[2] * scale + offset[2],
  ];
}

function rasterizeTriangle(a, b, c, heights, normalYs, hitCounts, bounds) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const normalY = normalizeY(cross(ab, ac));
  if (Math.abs(normalY) < MIN_TOP_NORMAL_Y) return 0;

  const minX = Math.min(a[0], b[0], c[0]);
  const maxX = Math.max(a[0], b[0], c[0]);
  const minZ = Math.min(a[2], b[2], c[2]);
  const maxZ = Math.max(a[2], b[2], c[2]);

  const startX = Math.max(0, Math.floor((minX - bounds.minX) / bounds.cellX));
  const endX = Math.min(HEIGHTMAP_SIZE - 1, Math.ceil((maxX - bounds.minX) / bounds.cellX));
  const startZ = Math.max(0, Math.floor((minZ - bounds.minZ) / bounds.cellZ));
  const endZ = Math.min(HEIGHTMAP_SIZE - 1, Math.ceil((maxZ - bounds.minZ) / bounds.cellZ));
  if (startX > endX || startZ > endZ) return 0;

  const v0x = b[0] - a[0];
  const v0z = b[2] - a[2];
  const v1x = c[0] - a[0];
  const v1z = c[2] - a[2];
  const denom = v0x * v1z - v1x * v0z;
  if (Math.abs(denom) < 0.000001) return 0;

  let hits = splatTriangleKeyPoints(a, b, c, heights, normalYs, hitCounts, bounds, normalY);
  for (let z = startZ; z <= endZ; z += 1) {
    const sampleZ = bounds.minZ + z * bounds.cellZ;
    for (let x = startX; x <= endX; x += 1) {
      const sampleX = bounds.minX + x * bounds.cellX;
      const v2x = sampleX - a[0];
      const v2z = sampleZ - a[2];
      const u = (v2x * v1z - v1x * v2z) / denom;
      const v = (v0x * v2z - v2x * v0z) / denom;
      const w = 1 - u - v;
      if (u < -0.0001 || v < -0.0001 || w < -0.0001) continue;

      const y = w * a[1] + u * b[1] + v * c[1];
      hits += writeHeightSample(heights, normalYs, hitCounts, z * HEIGHTMAP_SIZE + x, y, normalY);
    }
  }
  return hits;
}

function splatTriangleKeyPoints(a, b, c, heights, normalYs, hitCounts, bounds, normalY) {
  return [
    a,
    b,
    c,
    midpoint(a, b),
    midpoint(b, c),
    midpoint(c, a),
    [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ],
  ].reduce((hits, point) => hits + splatPointToNearestSample(point, heights, normalYs, hitCounts, bounds, normalY), 0);
}

function midpoint(a, b) {
  return [
    (a[0] + b[0]) / 2,
    (a[1] + b[1]) / 2,
    (a[2] + b[2]) / 2,
  ];
}

function splatPointToNearestSample(point, heights, normalYs, hitCounts, bounds, normalY) {
  const x = Math.round((point[0] - bounds.minX) / bounds.cellX);
  const z = Math.round((point[2] - bounds.minZ) / bounds.cellZ);
  if (x < 0 || z < 0 || x >= HEIGHTMAP_SIZE || z >= HEIGHTMAP_SIZE) return 0;
  return writeHeightSample(heights, normalYs, hitCounts, z * HEIGHTMAP_SIZE + x, point[1], normalY);
}

function writeHeightSample(heights, normalYs, hitCounts, index, y, normalY) {
  if (!Number.isFinite(heights[index]) || y > heights[index]) {
    heights[index] = y;
    normalYs[index] = Math.abs(normalY);
  }
  hitCounts[index] += 1;
  return 1;
}

function fillMissingHeights(heights, normalYs, hitCounts) {
  let filled = 0;
  let changed = true;
  while (changed) {
    changed = false;
    const next = heights.slice();
    for (let z = 0; z < HEIGHTMAP_SIZE; z += 1) {
      for (let x = 0; x < HEIGHTMAP_SIZE; x += 1) {
        const index = z * HEIGHTMAP_SIZE + x;
        if (Number.isFinite(heights[index])) continue;

        let total = 0;
        let count = 0;
        for (let dz = -1; dz <= 1; dz += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dz === 0) continue;
            const nx = x + dx;
            const nz = z + dz;
            if (nx < 0 || nz < 0 || nx >= HEIGHTMAP_SIZE || nz >= HEIGHTMAP_SIZE) continue;
            const value = heights[nz * HEIGHTMAP_SIZE + nx];
            if (!Number.isFinite(value)) continue;
            total += value;
            count += 1;
          }
        }

        if (count > 0) {
          next[index] = total / count;
          normalYs[index] = 0;
          hitCounts[index] = 0;
          filled += 1;
          changed = true;
        }
      }
    }
    heights.set(next);
  }
  return filled;
}

function buildHeightmap() {
  const { json: gltf, bin } = readGlb(GLB_PATH);
  const instances = collectMeshInstances(gltf);
  const rawBounds = computeRawBounds(gltf, bin, instances);
  const rawSizeX = rawBounds.max[0] - rawBounds.min[0];
  const rawSizeZ = rawBounds.max[2] - rawBounds.min[2];
  const scale = TERRAIN_TARGET_SIZE / Math.max(rawSizeX, rawSizeZ);
  const rawCenter = [
    (rawBounds.min[0] + rawBounds.max[0]) / 2,
    (rawBounds.min[1] + rawBounds.max[1]) / 2,
    (rawBounds.min[2] + rawBounds.max[2]) / 2,
  ];
  const offset = [-rawCenter[0] * scale, -rawBounds.min[1] * scale, -rawCenter[2] * scale];

  const minX = rawBounds.min[0] * scale + offset[0];
  const maxX = rawBounds.max[0] * scale + offset[0];
  const minZ = rawBounds.min[2] * scale + offset[2];
  const maxZ = rawBounds.max[2] * scale + offset[2];
  const bounds = {
    minX,
    maxX,
    minZ,
    maxZ,
    cellX: (maxX - minX) / (HEIGHTMAP_SIZE - 1),
    cellZ: (maxZ - minZ) / (HEIGHTMAP_SIZE - 1),
  };

  const heights = new Float64Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
  const normalYs = new Float64Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
  const hitCounts = new Uint32Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
  heights.fill(NaN);

  let triangles = 0;
  let rasterHits = 0;
  for (const instance of instances) {
    if (!isTerrainMesh(instance.label)) continue;

    for (const primitive of instance.mesh.primitives ?? []) {
      if (primitive.mode !== undefined && primitive.mode !== 4) continue;
      const positionAccessor = primitive.attributes?.POSITION;
      if (positionAccessor === undefined) continue;

      const positions = getAccessorReader(gltf, bin, positionAccessor);
      const indices = primitive.indices !== undefined ? getAccessorReader(gltf, bin, primitive.indices) : null;
      const indexCount = indices ? indices.count : positions.count;

      for (let i = 0; i + 2 < indexCount; i += 3) {
        const ia = indices ? indices.read(i) : i;
        const ib = indices ? indices.read(i + 1) : i + 1;
        const ic = indices ? indices.read(i + 2) : i + 2;
        const a = finalTransform(transformPoint(instance.matrix, positions.read(ia)), scale, offset);
        const b = finalTransform(transformPoint(instance.matrix, positions.read(ib)), scale, offset);
        const c = finalTransform(transformPoint(instance.matrix, positions.read(ic)), scale, offset);
        rasterHits += rasterizeTriangle(a, b, c, heights, normalYs, hitCounts, bounds);
        triangles += 1;
      }
    }
  }

  const missingBeforeFill = heights.reduce((count, value) => count + (Number.isFinite(value) ? 0 : 1), 0);
  const filled = fillMissingHeights(heights, normalYs, hitCounts);
  const missingAfterFill = heights.reduce((count, value) => count + (Number.isFinite(value) ? 0 : 1), 0);
  if (missingAfterFill > 0) {
    throw new Error(`Could not fill ${missingAfterFill} heightmap cells`);
  }

  const walkable = buildWalkableMask(heights, normalYs, hitCounts, bounds);

  const minHeight = heights.reduce((min, value) => Math.min(min, value), Infinity);
  const maxHeight = heights.reduce((max, value) => Math.max(max, value), -Infinity);

  return {
    heights,
    walkable,
    bounds,
    stats: {
      scale,
      triangles,
      rasterHits,
      missingBeforeFill,
      filled,
      minHeight,
      maxHeight,
      centerHeight: sampleHeight(heights, bounds, 0, 0),
      walkableCells: walkable.split('').filter((value) => value === '1').length,
    },
  };
}

function buildWalkableMask(heights, normalYs, hitCounts, bounds) {
  let mask = '';
  for (let z = 0; z < HEIGHTMAP_SIZE; z += 1) {
    for (let x = 0; x < HEIGHTMAP_SIZE; x += 1) {
      const index = z * HEIGHTMAP_SIZE + x;
      const sampleX = bounds.minX + x * bounds.cellX;
      const sampleZ = bounds.minZ + z * bounds.cellZ;
      const slopeWalkable = terrainSlopeAt(heights, bounds, sampleX, sampleZ) <= MAX_WALKABLE_SLOPE;
      const triangleWalkable = hitCounts[index] > 0 ? normalYs[index] >= MIN_WALKABLE_NORMAL_Y : true;
      mask += slopeWalkable && triangleWalkable ? '1' : '0';
    }
  }
  return mask;
}

function heightAtIndex(heights, x, z) {
  return heights[z * HEIGHTMAP_SIZE + x];
}

function sampleHeight(heights, bounds, x, z) {
  const u = clamp((x - bounds.minX) / (bounds.maxX - bounds.minX), 0, 1);
  const v = clamp((z - bounds.minZ) / (bounds.maxZ - bounds.minZ), 0, 1);
  const gx = u * (HEIGHTMAP_SIZE - 1);
  const gz = v * (HEIGHTMAP_SIZE - 1);
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const x1 = Math.min(x0 + 1, HEIGHTMAP_SIZE - 1);
  const z1 = Math.min(z0 + 1, HEIGHTMAP_SIZE - 1);
  const tx = gx - x0;
  const tz = gz - z0;
  const h00 = heightAtIndex(heights, x0, z0);
  const h10 = heightAtIndex(heights, x1, z0);
  const h01 = heightAtIndex(heights, x0, z1);
  const h11 = heightAtIndex(heights, x1, z1);
  const h0 = h00 + (h10 - h00) * tx;
  const h1 = h01 + (h11 - h01) * tx;
  return h0 + (h1 - h0) * tz;
}

function terrainSlopeAt(heights, bounds, x, z) {
  const left = sampleHeight(heights, bounds, x - bounds.cellX, z);
  const right = sampleHeight(heights, bounds, x + bounds.cellX, z);
  const down = sampleHeight(heights, bounds, x, z - bounds.cellZ);
  const up = sampleHeight(heights, bounds, x, z + bounds.cellZ);
  const dhdx = (right - left) / (bounds.cellX * 2);
  const dhdz = (up - down) / (bounds.cellZ * 2);
  return Math.hypot(dhdx, dhdz);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatNumber(value) {
  return value.toFixed(2);
}

function formatArray(heights, indent) {
  const lines = [];
  for (let i = 0; i < heights.length; i += 8) {
    const values = [];
    for (let j = i; j < Math.min(i + 8, heights.length); j += 1) {
      values.push(formatNumber(heights[j]));
    }
    lines.push(`${indent}${values.join(',')},`);
  }
  return lines.join('\n');
}

function formatMask(mask, indent) {
  const lines = [];
  for (let i = 0; i < mask.length; i += 128) {
    lines.push(`${indent}'${mask.slice(i, i + 128)}'`);
  }
  return lines.join(' +\n');
}

function formatRustMask(mask, indent) {
  const lines = [];
  for (let i = 0; i < mask.length; i += 128) {
    lines.push(`${indent}"${mask.slice(i, i + 128)}",`);
  }
  return `concat!(\n${lines.join('\n')}\n)`;
}

function writeClient({ heights, walkable, bounds }) {
  const content = `import * as THREE from 'three';\n\n`
    + `export const HEIGHTMAP_SIZE = ${HEIGHTMAP_SIZE};\n`
    + `export const HEIGHTMAP_MIN_X = ${formatNumber(bounds.minX)};\n`
    + `export const HEIGHTMAP_MAX_X = ${formatNumber(bounds.maxX)};\n`
    + `export const HEIGHTMAP_MIN_Z = ${formatNumber(bounds.minZ)};\n`
    + `export const HEIGHTMAP_MAX_Z = ${formatNumber(bounds.maxZ)};\n`
    + `export const TERRAIN_MAX_WALKABLE_SLOPE_DEGREES = ${MAX_WALKABLE_SLOPE_DEGREES};\n\n`
    + `const TERRAIN_MAX_WALKABLE_SLOPE = Math.tan(THREE.MathUtils.degToRad(TERRAIN_MAX_WALKABLE_SLOPE_DEGREES));\n\n`
    + `// Baked simplified static terrain collision surface from dark-fantasy-map-2.glb.\n`
    + `const HEIGHTS = [\n${formatArray(heights, '  ')}\n];\n\n`
    + `const WALKABLE_MASK =\n${formatMask(walkable, '  ')};\n\n`
    + `export function terrainHeightAt(position: THREE.Vector3): number {\n`
    + `  return sampleHeight(position.x, position.z);\n`
    + `}\n\n`
    + `export function sampleHeight(x: number, z: number): number {\n`
    + `  const u = THREE.MathUtils.clamp((x - HEIGHTMAP_MIN_X) / (HEIGHTMAP_MAX_X - HEIGHTMAP_MIN_X), 0, 1);\n`
    + `  const v = THREE.MathUtils.clamp((z - HEIGHTMAP_MIN_Z) / (HEIGHTMAP_MAX_Z - HEIGHTMAP_MIN_Z), 0, 1);\n`
    + `  const gx = u * (HEIGHTMAP_SIZE - 1);\n`
    + `  const gz = v * (HEIGHTMAP_SIZE - 1);\n`
    + `  const x0 = Math.floor(gx);\n`
    + `  const z0 = Math.floor(gz);\n`
    + `  const x1 = Math.min(x0 + 1, HEIGHTMAP_SIZE - 1);\n`
    + `  const z1 = Math.min(z0 + 1, HEIGHTMAP_SIZE - 1);\n`
    + `  const tx = gx - x0;\n`
    + `  const tz = gz - z0;\n`
    + `  const h00 = heightAtIndex(x0, z0);\n`
    + `  const h10 = heightAtIndex(x1, z0);\n`
    + `  const h01 = heightAtIndex(x0, z1);\n`
    + `  const h11 = heightAtIndex(x1, z1);\n`
    + `  const h0 = THREE.MathUtils.lerp(h00, h10, tx);\n`
    + `  const h1 = THREE.MathUtils.lerp(h01, h11, tx);\n`
    + `  return THREE.MathUtils.lerp(h0, h1, tz);\n`
    + `}\n\n`
    + `export function isTerrainWalkableAt(x: number, z: number): boolean {\n`
    + `  const u = THREE.MathUtils.clamp((x - HEIGHTMAP_MIN_X) / (HEIGHTMAP_MAX_X - HEIGHTMAP_MIN_X), 0, 1);\n`
    + `  const v = THREE.MathUtils.clamp((z - HEIGHTMAP_MIN_Z) / (HEIGHTMAP_MAX_Z - HEIGHTMAP_MIN_Z), 0, 1);\n`
    + `  const gridX = Math.round(u * (HEIGHTMAP_SIZE - 1));\n`
    + `  const gridZ = Math.round(v * (HEIGHTMAP_SIZE - 1));\n`
    + `  return WALKABLE_MASK.charCodeAt(gridZ * HEIGHTMAP_SIZE + gridX) === 49 && terrainSlopeAt(x, z) <= TERRAIN_MAX_WALKABLE_SLOPE;\n`
    + `}\n\n`
    + `export function terrainSlopeAt(x: number, z: number): number {\n`
    + `  const cellX = (HEIGHTMAP_MAX_X - HEIGHTMAP_MIN_X) / (HEIGHTMAP_SIZE - 1);\n`
    + `  const cellZ = (HEIGHTMAP_MAX_Z - HEIGHTMAP_MIN_Z) / (HEIGHTMAP_SIZE - 1);\n`
    + `  const left = sampleHeight(x - cellX, z);\n`
    + `  const right = sampleHeight(x + cellX, z);\n`
    + `  const down = sampleHeight(x, z - cellZ);\n`
    + `  const up = sampleHeight(x, z + cellZ);\n`
    + `  const dhdx = (right - left) / (cellX * 2);\n`
    + `  const dhdz = (up - down) / (cellZ * 2);\n`
    + `  return Math.hypot(dhdx, dhdz);\n`
    + `}\n\n`
    + `function heightAtIndex(x: number, z: number): number {\n`
    + `  return HEIGHTS[z * HEIGHTMAP_SIZE + x];\n`
    + `}\n`;

  fs.writeFileSync(CLIENT_OUT, content);
}

function writeServer({ heights, walkable, bounds }) {
  const content = `use crate::common::Vector3;\n\n`
    + `pub const HEIGHTMAP_SIZE: usize = ${HEIGHTMAP_SIZE};\n`
    + `pub const HEIGHTMAP_MIN_X: f32 = ${formatNumber(bounds.minX)};\n`
    + `pub const HEIGHTMAP_MAX_X: f32 = ${formatNumber(bounds.maxX)};\n`
    + `pub const HEIGHTMAP_MIN_Z: f32 = ${formatNumber(bounds.minZ)};\n`
    + `pub const HEIGHTMAP_MAX_Z: f32 = ${formatNumber(bounds.maxZ)};\n`
    + `pub const TERRAIN_MAX_WALKABLE_SLOPE_DEGREES: f32 = ${MAX_WALKABLE_SLOPE_DEGREES}.0;\n\n`
    + `const TERRAIN_MAX_WALKABLE_SLOPE: f32 = ${MAX_WALKABLE_SLOPE.toFixed(8)}; // tan(${MAX_WALKABLE_SLOPE_DEGREES} degrees)\n\n`
    + `// Baked simplified static terrain collision surface from dark-fantasy-map-2.glb.\n`
    + `const HEIGHTS: [f32; HEIGHTMAP_SIZE * HEIGHTMAP_SIZE] = [\n${formatArray(heights, '    ')}\n];\n\n`
    + `const WALKABLE_MASK: &str = ${formatRustMask(walkable, '    ')};\n\n`
    + `pub fn terrain_height_at(position: &Vector3) -> f32 {\n`
    + `    sample_height(position.x, position.z)\n`
    + `}\n\n`
    + `pub fn sample_height(x: f32, z: f32) -> f32 {\n`
    + `    let u = ((x - HEIGHTMAP_MIN_X) / (HEIGHTMAP_MAX_X - HEIGHTMAP_MIN_X)).clamp(0.0, 1.0);\n`
    + `    let v = ((z - HEIGHTMAP_MIN_Z) / (HEIGHTMAP_MAX_Z - HEIGHTMAP_MIN_Z)).clamp(0.0, 1.0);\n`
    + `    let gx = u * (HEIGHTMAP_SIZE as f32 - 1.0);\n`
    + `    let gz = v * (HEIGHTMAP_SIZE as f32 - 1.0);\n`
    + `    let x0 = gx.floor() as usize;\n`
    + `    let z0 = gz.floor() as usize;\n`
    + `    let x1 = (x0 + 1).min(HEIGHTMAP_SIZE - 1);\n`
    + `    let z1 = (z0 + 1).min(HEIGHTMAP_SIZE - 1);\n`
    + `    let tx = gx - x0 as f32;\n`
    + `    let tz = gz - z0 as f32;\n`
    + `    let h00 = height_at_index(x0, z0);\n`
    + `    let h10 = height_at_index(x1, z0);\n`
    + `    let h01 = height_at_index(x0, z1);\n`
    + `    let h11 = height_at_index(x1, z1);\n`
    + `    let h0 = h00 + (h10 - h00) * tx;\n`
    + `    let h1 = h01 + (h11 - h01) * tx;\n`
    + `    h0 + (h1 - h0) * tz\n`
    + `}\n\n`
    + `pub fn is_terrain_walkable_at(x: f32, z: f32) -> bool {\n`
    + `    let u = ((x - HEIGHTMAP_MIN_X) / (HEIGHTMAP_MAX_X - HEIGHTMAP_MIN_X)).clamp(0.0, 1.0);\n`
    + `    let v = ((z - HEIGHTMAP_MIN_Z) / (HEIGHTMAP_MAX_Z - HEIGHTMAP_MIN_Z)).clamp(0.0, 1.0);\n`
    + `    let grid_x = (u * (HEIGHTMAP_SIZE as f32 - 1.0)).round() as usize;\n`
    + `    let grid_z = (v * (HEIGHTMAP_SIZE as f32 - 1.0)).round() as usize;\n`
    + `    let index = grid_z * HEIGHTMAP_SIZE + grid_x;\n`
    + `    WALKABLE_MASK.as_bytes()[index] == b'1' && terrain_slope_at(x, z) <= TERRAIN_MAX_WALKABLE_SLOPE\n`
    + `}\n\n`
    + `pub fn terrain_slope_at(x: f32, z: f32) -> f32 {\n`
    + `    let cell_x = (HEIGHTMAP_MAX_X - HEIGHTMAP_MIN_X) / (HEIGHTMAP_SIZE as f32 - 1.0);\n`
    + `    let cell_z = (HEIGHTMAP_MAX_Z - HEIGHTMAP_MIN_Z) / (HEIGHTMAP_SIZE as f32 - 1.0);\n`
    + `    let left = sample_height(x - cell_x, z);\n`
    + `    let right = sample_height(x + cell_x, z);\n`
    + `    let down = sample_height(x, z - cell_z);\n`
    + `    let up = sample_height(x, z + cell_z);\n`
    + `    let dhdx = (right - left) / (cell_x * 2.0);\n`
    + `    let dhdz = (up - down) / (cell_z * 2.0);\n`
    + `    (dhdx * dhdx + dhdz * dhdz).sqrt()\n`
    + `}\n\n`
    + `fn height_at_index(x: usize, z: usize) -> f32 {\n`
    + `    HEIGHTS[z * HEIGHTMAP_SIZE + x]\n`
    + `}\n\n`
    + `#[cfg(test)]\n`
    + `mod tests {\n`
    + `    use super::*;\n\n`
    + `    #[test]\n`
    + `    fn samples_inside_generated_range() {\n`
    + `        let h = sample_height(0.0, 0.0);\n`
    + `        assert!(h >= 0.0);\n`
    + `    }\n`
    + `}\n`;

  fs.writeFileSync(SERVER_OUT, content);
}

const result = buildHeightmap();
writeClient(result);
writeServer(result);
console.log(JSON.stringify(result.stats, null, 2));
