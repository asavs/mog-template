import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { encodeHeightmapBinary, writeHeightmapMeta } from './heightmap-binary-format.mjs';
import { encodeCastleCollisionBinary, writeCastleCollisionMeta } from './castle-collision-binary-format.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
/** Keep in sync with `client/src/terrainConfig.ts` (TERRAIN_GLB_RELATIVE_PATH). */
const TERRAIN_GLB_RELATIVE_PATH = 'models/terrain/dark-fantasy-map-lower-poly.glb';
const GLB_PATH = path.join(ROOT, 'client/public', TERRAIN_GLB_RELATIVE_PATH);
/** Client runtime binary (static web root). */
const CLIENT_BIN_OUT = path.join(ROOT, 'client/public/models/terrain/heightmap.bin');
/** Embedded by SpacetimeDB module via include_bytes!. */
const SERVER_BIN_OUT = path.join(ROOT, 'server/spacetimedb/src/heightmap.bin');
/** Thin TS bounds for the client loader — not the giant sample grid. */
const CLIENT_META_OUT = path.join(ROOT, 'client/src/heightmapMeta.ts');
/** Canonical static triangle asset, fetched by the client and embedded by the server. */
const CLIENT_CASTLE_COLLISION_OUT = path.join(ROOT, 'client/public/models/terrain/castle-collision.bin');
const SERVER_CASTLE_COLLISION_OUT = path.join(ROOT, 'server/spacetimedb/src/castle_collision.bin');
const CLIENT_CASTLE_COLLISION_META_OUT = path.join(ROOT, 'client/src/castleCollisionMeta.ts');

/** Keep in sync with `client/src/terrainConfig.ts` (TERRAIN_TARGET_SIZE). */
const TERRAIN_TARGET_SIZE = 3148.07;
const HEIGHTMAP_SIZE = 513;
const MAX_WALKABLE_SLOPE_DEGREES = 70;
const MAX_WALKABLE_SLOPE = Math.tan((MAX_WALKABLE_SLOPE_DEGREES * Math.PI) / 180);
const MIN_WALKABLE_NORMAL_Y = Math.cos((MAX_WALKABLE_SLOPE_DEGREES * Math.PI) / 180);
const MIN_TOP_NORMAL_Y = 0.02;
const MIN_TERRAIN_FOOTPRINT = 100;
const CASTLE_GRID_CELL_SIZE = 3;
const CASTLE_MIN_DOUBLE_AREA_SQUARED = 1e-12;

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

  return {
    json,
    bin,
    sourceHash: createHash('sha256').update(data).digest(),
  };
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
    && !/(-col|Castle|Wall|Tower|PSX|Tree|Grass|Dandelion|Lavender|Reed|Rock|Pine|Cone|Cylinder|Plane|Cube|Bush|Mushroom)/i.test(label);
}

function isStaticBlockerMesh(label) {
  return /Castle Collision/i.test(label);
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

function computeInstanceBounds(gltf, bin, instance) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

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

  return { min, max };
}

function hasTerrainFootprint(bounds) {
  const sizeX = bounds.max[0] - bounds.min[0];
  const sizeZ = bounds.max[2] - bounds.min[2];
  return Number.isFinite(sizeX)
    && Number.isFinite(sizeZ)
    && Math.max(sizeX, sizeZ) >= MIN_TERRAIN_FOOTPRINT;
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
  const { json: gltf, bin, sourceHash } = readGlb(GLB_PATH);
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
  const castleCollision = collectCastleCollision(gltf, bin, instances, scale, offset, sourceHash);

  const heights = new Float64Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
  const normalYs = new Float64Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
  const hitCounts = new Uint32Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
  heights.fill(NaN);

  let triangles = 0;
  let rasterHits = 0;
  let skippedSmallTerrainCandidates = 0;
  for (const instance of instances) {
    if (!isTerrainMesh(instance.label)) continue;
    if (!hasTerrainFootprint(computeInstanceBounds(gltf, bin, instance))) {
      skippedSmallTerrainCandidates += 1;
      continue;
    }

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
    castleCollision,
    stats: {
      scale,
      triangles,
      rasterHits,
      skippedSmallTerrainCandidates,
      missingBeforeFill,
      filled,
      minHeight,
      maxHeight,
      centerHeight: sampleHeight(heights, bounds, 0, 0),
      walkableCells: walkable.split('').filter((value) => value === '1').length,
    },
  };
}

/**
 * Bake the collision node separately from the outdoor heightmap. Its grid only
 * accelerates broad-phase lookup; every final contact is against these exact
 * transformed source triangles.
 */
function collectCastleCollision(gltf, bin, instances, scale, offset, sourceHash) {
  const matching = instances.filter(instance => isStaticBlockerMesh(instance.label));
  if (matching.length !== 1) {
    throw new Error(`Expected exactly one Castle Collision mesh, found ${matching.length}`);
  }

  const [instance] = matching;
  const vertices = [];
  const indices = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const primitive of instance.mesh.primitives ?? []) {
    if (primitive.mode !== undefined && primitive.mode !== 4) continue;
    const positionAccessor = primitive.attributes?.POSITION;
    if (positionAccessor === undefined) continue;
    const positions = getAccessorReader(gltf, bin, positionAccessor);
    const vertexBase = vertices.length / 3;
    for (let index = 0; index < positions.count; index += 1) {
      const point = finalTransform(transformPoint(instance.matrix, positions.read(index)), scale, offset);
      if (!point.every(Number.isFinite)) {
        throw new Error(`Castle Collision has a non-finite transformed vertex at ${index}`);
      }
      vertices.push(point[0], point[1], point[2]);
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }
    }

    const sourceIndices = primitive.indices === undefined
      ? null
      : getAccessorReader(gltf, bin, primitive.indices);
    const indexCount = sourceIndices ? sourceIndices.count : positions.count;
    for (let index = 0; index + 2 < indexCount; index += 3) {
      const sourceTriangle = [
        sourceIndices ? sourceIndices.read(index) : index,
        sourceIndices ? sourceIndices.read(index + 1) : index + 1,
        sourceIndices ? sourceIndices.read(index + 2) : index + 2,
      ];
      if (sourceTriangle.some(sourceIndex => !Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= positions.count)) {
        throw new Error(`Castle Collision has an out-of-range triangle index at ${index}`);
      }
      const triangle = sourceTriangle.map(sourceIndex => vertexBase + sourceIndex);
      const a = vertices.slice(triangle[0] * 3, triangle[0] * 3 + 3);
      const b = vertices.slice(triangle[1] * 3, triangle[1] * 3 + 3);
      const c = vertices.slice(triangle[2] * 3, triangle[2] * 3 + 3);
      const area = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
      if (area[0] ** 2 + area[1] ** 2 + area[2] ** 2 <= CASTLE_MIN_DOUBLE_AREA_SQUARED) continue;
      indices.push(...triangle);
    }
  }

  if (!Number.isFinite(min[0]) || indices.length === 0) {
    throw new Error('Castle Collision mesh has no triangle primitives');
  }
  const grid = buildCastleGrid(vertices, indices, min, max);
  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    grid,
    min,
    max,
    terrainScale: scale,
    terrainOffset: offset,
    sourceNodeMatrix: instance.matrix,
    sourceHash,
    sourceNodeName: instance.label.split('/').filter(Boolean)[0] ?? instance.label,
  };
}

function buildCastleGrid(vertices, indices, min, max) {
  const dimensions = [0, 1, 2].map(axis => Math.max(1, Math.ceil((max[axis] - min[axis]) / CASTLE_GRID_CELL_SIZE)));
  const [gridX, gridY, gridZ] = dimensions;
  const cells = Array.from({ length: gridX * gridY * gridZ }, () => new Set());
  const cellIndex = (x, y, z) => (z * gridY + y) * gridX + x;
  const gridCoordinate = (value, axis) => Math.min(
    dimensions[axis] - 1,
    Math.max(0, Math.floor(((value - min[axis]) / (max[axis] - min[axis])) * dimensions[axis])),
  );

  for (let triangleId = 0; triangleId < indices.length / 3; triangleId += 1) {
    const triangleMin = [Infinity, Infinity, Infinity];
    const triangleMax = [-Infinity, -Infinity, -Infinity];
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indices[triangleId * 3 + corner] * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        const value = vertices[vertex + axis];
        triangleMin[axis] = Math.min(triangleMin[axis], value);
        triangleMax[axis] = Math.max(triangleMax[axis], value);
      }
    }
    const start = triangleMin.map(gridCoordinate);
    const end = triangleMax.map(gridCoordinate);
    for (let z = start[2]; z <= end[2]; z += 1) {
      for (let y = start[1]; y <= end[1]; y += 1) {
        for (let x = start[0]; x <= end[0]; x += 1) {
          cells[cellIndex(x, y, z)].add(triangleId);
        }
      }
    }
  }

  const offsets = new Uint32Array(cells.length + 1);
  const triangleIds = [];
  for (let index = 0; index < cells.length; index += 1) {
    offsets[index] = triangleIds.length;
    triangleIds.push(...[...cells[index]].sort((a, b) => a - b));
  }
  offsets[cells.length] = triangleIds.length;
  return {
    x: gridX,
    y: gridY,
    z: gridZ,
    offsets,
    triangleIds: new Uint32Array(triangleIds),
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
  return Number(value.toFixed(2));
}

/**
 * Write HM01 bins + client meta. Does **not** touch heightmap.ts / heightmap.rs
 * loaders — those stay as hand-maintained thin wrappers around the binary.
 */
function writeBinaryOutputs({ heights, walkable, bounds, stats }) {
  const data = {
    size: HEIGHTMAP_SIZE,
    minX: formatNumber(bounds.minX),
    maxX: formatNumber(bounds.maxX),
    minZ: formatNumber(bounds.minZ),
    maxZ: formatNumber(bounds.maxZ),
    minH: formatNumber(stats.minHeight),
    maxH: formatNumber(stats.maxHeight),
    heights,
    mask: walkable,
  };
  const bin = encodeHeightmapBinary(data);
  fs.mkdirSync(path.dirname(CLIENT_BIN_OUT), { recursive: true });
  fs.writeFileSync(CLIENT_BIN_OUT, bin);
  fs.writeFileSync(SERVER_BIN_OUT, bin);
  writeHeightmapMeta(CLIENT_META_OUT, data, MAX_WALKABLE_SLOPE_DEGREES);
  return { bytes: bin.length, clientBin: CLIENT_BIN_OUT, serverBin: SERVER_BIN_OUT, meta: CLIENT_META_OUT };
}

function writeCastleCollisionOutputs(collision) {
  const bin = encodeCastleCollisionBinary(collision);
  fs.writeFileSync(CLIENT_CASTLE_COLLISION_OUT, bin);
  fs.writeFileSync(SERVER_CASTLE_COLLISION_OUT, bin);
  writeCastleCollisionMeta(CLIENT_CASTLE_COLLISION_META_OUT, collision);
  return {
    castleCollisionBytes: bin.length,
    clientCastleCollision: CLIENT_CASTLE_COLLISION_OUT,
    serverCastleCollision: SERVER_CASTLE_COLLISION_OUT,
    castleCollisionMeta: CLIENT_CASTLE_COLLISION_META_OUT,
  };
}

const result = buildHeightmap();
const written = writeBinaryOutputs(result);
const collisionWritten = writeCastleCollisionOutputs(result.castleCollision);
console.log(JSON.stringify({ ...result.stats, ...written, ...collisionWritten }, null, 2));
