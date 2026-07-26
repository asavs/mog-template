/**
 * Generate typed Rust and TypeScript arena data from shared/arena.json.
 *
 * Usage: node tools/gen-arena/gen.mjs
 *        node tools/gen-arena/gen.mjs --check   # exit 1 if generated files are stale
 *
 * This generator intentionally has zero npm dependencies so it can run before
 * package installation. JSON array and object order is preserved as authored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const JSON_PATH = path.join(ROOT, 'shared', 'arena.json');
const RUST_OUT = path.join(ROOT, 'server', 'spacetimedb', 'src', 'arena.generated.rs');
const TS_OUT = path.join(ROOT, 'client', 'src', 'sim', 'arena.generated.ts');

function readAuthority() {
  return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateKnownFields(value, allowedFields, label, errors) {
  if (!isRecord(value)) return;
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${label} field "${field}" is not allowed`);
  }
}

function validateVector3(value, label, errors) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteNumber)) {
    errors.push(`${label} must be a 3-element array of finite numbers`);
  }
}

function colliderLabel(collider, index) {
  return typeof collider?.id === 'string'
    ? `collider "${collider.id}"`
    : `collider "<missing:${index}>"`;
}

function validateSpawn(spawn, index, errors) {
  const label = `spawn at index ${index}`;
  if (!isRecord(spawn)) {
    errors.push(`${label} must be an object`);
    return;
  }
  validateKnownFields(spawn, ['position', 'yaw'], label, errors);
  validateVector3(spawn.position, `${label} field "position"`, errors);
  if (!isFiniteNumber(spawn.yaw)) {
    errors.push(`${label} field "yaw" must be a finite number`);
  }
}

function validateCollider(collider, index, errors) {
  const label = colliderLabel(collider, index);
  if (!isRecord(collider)) {
    errors.push(`${label} must be an object`);
    return;
  }

  if (typeof collider.id !== 'string' || collider.id.length === 0) {
    errors.push(`${label} field "id" must be a non-empty string`);
  }
  if (collider.shape !== 'box' && collider.shape !== 'cylinder') {
    errors.push(`${label} field "shape" must be exactly "box" or "cylinder"`);
    return;
  }
  validateVector3(collider.center, `${label} field "center"`, errors);

  if (collider.shape === 'box') {
    validateKnownFields(collider, ['id', 'shape', 'center', 'size', 'yaw'], label, errors);
    validateVector3(collider.size, `${label} field "size"`, errors);
    if (
      Array.isArray(collider.size)
      && collider.size.length === 3
      && collider.size.every(isFiniteNumber)
      && collider.size.some((component) => component <= 0)
    ) {
      errors.push(`${label} field "size" components must all be greater than 0`);
    }
    if (collider.yaw !== undefined && !isFiniteNumber(collider.yaw)) {
      errors.push(`${label} field "yaw" must be a finite number when present`);
    }
  } else {
    validateKnownFields(collider, ['id', 'shape', 'center', 'radius', 'height'], label, errors);
    if (!isFiniteNumber(collider.radius) || collider.radius <= 0) {
      errors.push(`${label} field "radius" must be a finite number greater than 0`);
    }
    if (!isFiniteNumber(collider.height) || collider.height <= 0) {
      errors.push(`${label} field "height" must be a finite number greater than 0`);
    }
  }
}

function validateAuthority(data) {
  const errors = [];
  if (!isRecord(data)) {
    throw new Error('[gen-arena] authority validation failed:\n- top-level value must be an object');
  }
  validateKnownFields(
    data,
    ['version', 'groundY', 'bounds', 'spawns', 'colliders'],
    'top-level',
    errors,
  );

  if (!Number.isInteger(data.version) || data.version <= 0) {
    errors.push('top-level field "version" must be a positive integer');
  }
  if (!isFiniteNumber(data.groundY)) {
    errors.push('top-level field "groundY" must be a finite number');
  }

  if (!isRecord(data.bounds)) {
    errors.push('top-level field "bounds" must be an object');
  } else {
    validateKnownFields(
      data.bounds,
      ['minX', 'maxX', 'minZ', 'maxZ'],
      'top-level bounds',
      errors,
    );
    for (const field of ['minX', 'maxX', 'minZ', 'maxZ']) {
      if (!isFiniteNumber(data.bounds[field])) {
        errors.push(`top-level field "bounds.${field}" must be a finite number`);
      }
    }
    if (
      isFiniteNumber(data.bounds.minX)
      && isFiniteNumber(data.bounds.maxX)
      && data.bounds.minX >= data.bounds.maxX
    ) {
      errors.push('top-level field "bounds.minX" must be less than "bounds.maxX"');
    }
    if (
      isFiniteNumber(data.bounds.minZ)
      && isFiniteNumber(data.bounds.maxZ)
      && data.bounds.minZ >= data.bounds.maxZ
    ) {
      errors.push('top-level field "bounds.minZ" must be less than "bounds.maxZ"');
    }
  }

  if (!Array.isArray(data.spawns)) {
    errors.push('top-level field "spawns" must be an array');
  } else {
    data.spawns.forEach((spawn, index) => validateSpawn(spawn, index, errors));
  }

  const colliderIds = new Set();
  const firstColliderIndex = new Map();
  if (!Array.isArray(data.colliders)) {
    errors.push('top-level field "colliders" must be an array');
  } else {
    data.colliders.forEach((collider, index) => {
      validateCollider(collider, index, errors);
      if (typeof collider?.id !== 'string') return;
      if (colliderIds.has(collider.id)) {
        errors.push(
          `${colliderLabel(collider, index)} field "id" duplicates colliders[${firstColliderIndex.get(collider.id)}].id`,
        );
      } else {
        colliderIds.add(collider.id);
        firstColliderIndex.set(collider.id, index);
      }
    });
  }

  if (errors.length) {
    throw new Error(`[gen-arena] authority validation failed:\n- ${errors.join('\n- ')}`);
  }
}

function normalizeAuthority(data) {
  return {
    version: data.version,
    groundY: data.groundY,
    bounds: { ...data.bounds },
    spawns: data.spawns.map((spawn) => ({
      position: [...spawn.position],
      yaw: spawn.yaw,
    })),
    colliders: data.colliders.map((collider) => {
      if (collider.shape === 'box') {
        return {
          id: collider.id,
          shape: collider.shape,
          center: [...collider.center],
          halfExtents: collider.size.map((component) => component / 2),
          yaw: collider.yaw ?? 0,
        };
      }
      return {
        id: collider.id,
        shape: collider.shape,
        center: [...collider.center],
        radius: collider.radius,
        height: collider.height,
      };
    }),
  };
}

function rustString(value) {
  return JSON.stringify(value);
}

function rustFloat(value) {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function rustVector3(value) {
  return `[${value.map(rustFloat).join(', ')}]`;
}

function tsNumber(value) {
  return JSON.stringify(value);
}

function tsVector3(value) {
  return `[${value.map(tsNumber).join(', ')}]`;
}

function generateRust(data) {
  const lines = [
    '// GENERATED FILE — edit shared/arena.json and run npm run gen:arena',
    '// Source: shared/arena.json',
    '// Included directly into collision.rs via `include!("arena.generated.rs")` — no `mod` needed.',
    '// NOTE: this file is spliced into collision.rs by `include!`, not compiled as its own',
    '// module, so it cannot use inner (`#![...]`) attributes — only outer (`#[...]`) ones.',
    '',
    '#[allow(dead_code)]',
    `pub const GROUND_Y: f32 = ${rustFloat(data.groundY)};`,
    '',
    '#[allow(dead_code)]',
    'pub struct ArenaBounds {',
    '    pub min_x: f32,',
    '    pub max_x: f32,',
    '    pub min_z: f32,',
    '    pub max_z: f32,',
    '}',
    '',
    `pub const ARENA_BOUNDS: ArenaBounds = ArenaBounds { min_x: ${rustFloat(data.bounds.minX)}, max_x: ${rustFloat(data.bounds.maxX)}, min_z: ${rustFloat(data.bounds.minZ)}, max_z: ${rustFloat(data.bounds.maxZ)} };`,
    '',
    '#[allow(dead_code)]',
    'pub struct ArenaSpawn {',
    '    pub position: [f32; 3],',
    '    pub yaw: f32,',
    '}',
    '',
    '#[allow(dead_code)]',
    'pub const ARENA_SPAWNS: &[ArenaSpawn] = &[',
  ];
  for (const spawn of data.spawns) {
    lines.push(
      `    ArenaSpawn { position: ${rustVector3(spawn.position)}, yaw: ${rustFloat(spawn.yaw)} },`,
    );
  }
  lines.push(
    '];',
    '',
    'pub enum ColliderShape {',
    '    Box { half_extents: [f32; 3], yaw: f32 },',
    '    Cylinder { radius: f32 },',
    '}',
    '',
    'pub struct ArenaCollider {',
    "    #[allow(dead_code)]",
    "    pub id: &'static str,",
    '    pub center: [f32; 3],',
    '    pub shape: ColliderShape,',
    '}',
    '',
    'pub const ARENA_COLLIDERS: &[ArenaCollider] = &[',
  );
  for (const collider of data.colliders) {
    const shape = collider.shape === 'box'
      ? `ColliderShape::Box { half_extents: ${rustVector3(collider.halfExtents)}, yaw: ${rustFloat(collider.yaw)} }`
      : `ColliderShape::Cylinder { radius: ${rustFloat(collider.radius)} }`;
    lines.push(
      `    ArenaCollider { id: ${rustString(collider.id)}, center: ${rustVector3(collider.center)}, shape: ${shape} },`,
    );
  }
  lines.push('];', '');
  return `${lines.join('\n')}\n`;
}

function generateTs(data) {
  const lines = [
    '// GENERATED FILE — edit shared/arena.json and run npm run gen:arena',
    '// Source: shared/arena.json',
    '',
    `export const GROUND_Y: number = ${tsNumber(data.groundY)};`,
    '',
    'export interface ArenaBounds {',
    '  minX: number;',
    '  maxX: number;',
    '  minZ: number;',
    '  maxZ: number;',
    '}',
    '',
    `export const ARENA_BOUNDS: ArenaBounds = { minX: ${tsNumber(data.bounds.minX)}, maxX: ${tsNumber(data.bounds.maxX)}, minZ: ${tsNumber(data.bounds.minZ)}, maxZ: ${tsNumber(data.bounds.maxZ)} };`,
    '',
    'export interface ArenaSpawn {',
    '  position: readonly [number, number, number];',
    '  yaw: number;',
    '}',
    '',
    'export const ARENA_SPAWNS: readonly ArenaSpawn[] = [',
  ];
  for (const spawn of data.spawns) {
    lines.push(
      `  { position: ${tsVector3(spawn.position)}, yaw: ${tsNumber(spawn.yaw)} },`,
    );
  }
  lines.push(
    '];',
    '',
    'export type ColliderShape =',
    "  | { kind: 'box'; halfExtents: readonly [number, number, number]; yaw: number }",
    "  | { kind: 'cylinder'; radius: number; height: number };",
    '',
    'export interface ArenaCollider {',
    '  id: string;',
    '  center: readonly [number, number, number];',
    '  shape: ColliderShape;',
    '}',
    '',
    'export const ARENA_COLLIDERS: readonly ArenaCollider[] = [',
  );
  for (const collider of data.colliders) {
    const shape = collider.shape === 'box'
      ? `{ kind: 'box', halfExtents: ${tsVector3(collider.halfExtents)}, yaw: ${tsNumber(collider.yaw)} }`
      : `{ kind: 'cylinder', radius: ${tsNumber(collider.radius)}, height: ${tsNumber(collider.height)} }`;
    lines.push(
      `  { id: ${JSON.stringify(collider.id).replaceAll('"', "'")}, center: ${tsVector3(collider.center)}, shape: ${shape} },`,
    );
  }
  lines.push('];', '');
  return `${lines.join('\n')}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const authority = readAuthority();
  validateAuthority(authority);
  const data = normalizeAuthority(authority);
  const rust = generateRust(data);
  const ts = generateTs(data);

  if (check) {
    const existingRust = fs.existsSync(RUST_OUT) ? fs.readFileSync(RUST_OUT, 'utf8') : '';
    const existingTs = fs.existsSync(TS_OUT) ? fs.readFileSync(TS_OUT, 'utf8') : '';
    if (existingRust !== rust || existingTs !== ts) {
      console.error(
        '[gen-arena] generated files are stale. Run: node tools/gen-arena/gen.mjs',
      );
      process.exit(1);
    }
    console.log('[gen-arena] generated files up to date');
    return;
  }

  fs.mkdirSync(path.dirname(RUST_OUT), { recursive: true });
  fs.mkdirSync(path.dirname(TS_OUT), { recursive: true });
  fs.writeFileSync(RUST_OUT, rust);
  fs.writeFileSync(TS_OUT, ts);
  console.log(`[gen-arena] wrote ${path.relative(ROOT, RUST_OUT)}`);
  console.log(`[gen-arena] wrote ${path.relative(ROOT, TS_OUT)}`);
}

main();
