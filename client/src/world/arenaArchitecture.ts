/**
 * Generated placeholder dark-fantasy arena architecture.
 *
 * Adopted verbatim (module logic untouched) from the "opus" entry of the arena
 * bake-off — see `mog-bakeoff/REPORT.md` for the six-way judging that picked
 * it: zero measured collider violations, the most ambitious silhouette, and
 * the most parameterized/DRY code of the six contestants. It is a placeholder
 * in the sense that its materials are flat MeshStandardMaterial palette colors
 * (no trim atlas applied yet) — the geometry, module structure, and collider
 * contract are meant to last.
 *
 * A procedurally built dark-fantasy dueling arena: a walled court of tall,
 * eroded gothic arcading, four buttressed pillars crowned with fire, and a
 * ring of ruined corner towers rising outside the walls to dwarf the duelists.
 *
 * Everything is authored in *modules* (wall bay, pillar, tower) that are
 * emitted through a single transform-stack `Emitter`, merged per intended
 * material, and given world-space triplanar UVs at one fixed texel density so
 * a shared trim-sheet atlas can be dropped on later without rescaling.
 *
 * Only change from the bake-off original: `three` is imported directly here
 * (matching the rest of client/src) rather than arriving as an injected
 * argument. `buildArena()` now takes no parameters; every internal module
 * still threads a `t: typeof THREE` handle exactly as the original did, it is
 * just seeded from this module's import instead of a caller-supplied one.
 */
import * as THREE from 'three';

/* ===========================================================================
 * 0. Collision contract — fixed by the brief. Visuals may never violate it.
 * ======================================================================== */

/** Ground plane covers x,z ∈ [−GROUND_HALF, GROUND_HALF]. */
const GROUND_HALF = 20;
/** Wall collider boxes are WALL_SPAN × 4 × 1, inner face at |x| or |z| = 20. */
const WALL_SPAN = 42;
/** Pillar colliders: cylinders of this radius / height at (±10, 0, ±10). */
const PILLAR_RADIUS = 0.9;
const PILLAR_HEIGHT = 6;
const PILLAR_AT: readonly (readonly [number, number])[] = [
  [10, 10],
  [-10, 10],
  [10, -10],
  [-10, -10],
];

/** Reference humanoid height — every ornament below is sized in multiples. */
const HUMAN = 2.0;

/* ===========================================================================
 * 1. Tunables. Change the arena here; nothing below hard-codes a dimension.
 * ======================================================================== */

const SEED = 0x5eed1e;

/** One UV tile per 2 world units = one tile per humanoid height. */
const UV_PER_UNIT = 1 / HUMAN;

/**
 * Wall module, authored in wall-local space:
 *   +x runs along the wall, +y is up, +z points AWAY from the arena and
 *   z = 0 is exactly the collider plane. Nothing here may emit z < 0.
 */
const WALL = {
  span: WALL_SPAN,
  bays: 7,
  /** Vertical piers between bays; the most forward element (z = 0). */
  pier: { width: 1.2, depth: 0.76, cap: 0.34, capSpread: 0.15 },
  /** Continuous base course; projects outward past the wall face. */
  plinth: { height: 1.25, depth: 1.85 },
  /** Arcade infill plate: a pierced panel set back from the collider plane. */
  panel: { front: 0.35, depth: 0.3 },
  /** Dark backing plane every recess is read against. */
  recessZ: 0.72,
  /** Front face of the solid wall core; the arena is sealed from here out. */
  coreFront: 0.76,
  bodyDepth: 1.7,
  arcadeTop: 6.4,
  cornice: { height: 0.5, projection: 0.3 },
  upper: { inset: 0.3, top: 9.3 },
  parapet: { slitY: 0.75, slitWidth: 0.34, slitHeight: 1.25 },
  merlon: { height: 1.3, width: 1.55, gap: 0.95, missing: 0.1 },
  buttress: { width: 1.3, depth: 3.5, top: 7.6, taper: 0.6, every: 2 },
  /** Blind arcade opening. */
  niche: { width: 2.8, spring: 2.55, point: 0.55 },
  /** Arrow slit opening. */
  slit: { width: 0.42, spring: 2.9, point: 0.9 },
  /** The one (sealed) gate motif. */
  gate: { width: 3.6, spring: 3.2, point: 0.6, front: 0.18, depth: 0.5, doorTop: 5.0 },
  banner: { width: 1.5, height: 3.3, chance: 0.5 },
  brazier: { chance: 0.45, y: 2.5 },
} as const;

const PILLAR = {
  plinth: { width: 2.35, height: 0.5, taper: 0.9 },
  socle: { radius: 1.14, height: 0.38 },
  shaft: { bottom: 1.02, top: 0.96, top_y: 5.2, segments: 16, erosion: 0.045 },
  neck: { radius: 0.94, height: 0.26 },
  capital: { radius: 1.34, height: 0.72 },
  abacus: { width: 2.45, height: 0.24 },
  /** Beacon drum above the collider: free to be as narrow as it likes. */
  drum: { bottom: 0.66, top: 0.56, height: 2.7 },
  band: { radius: 1.06, height: 0.16, at: [1.9, 3.7] },
  bowl: { radius: 0.92, height: 0.62, corbel: 0.24 },
  /** Index of the pillar left broken — asymmetry without touching the collider. */
  ruined: 2,
} as const;

const TOWER = {
  /** Centre distance on each axis; centre − radius must stay ≥ GROUND_HALF. */
  at: 22.9,
  radius: 2.7,
  taper: 0.82,
  segments: 14,
  erosion: 0.05,
  heights: [17, 21.5, 13.5, 15.5],
  corbel: { radius: 3.15, height: 0.55 },
  merlons: { count: 11, width: 0.95, height: 1.15, depth: 0.6 },
  spire: { radius: 3.05, height: 6.6 },
  /** Heights (fraction of shaft) of the openings; `lit` ones glow. */
  windows: [
    { at: 0.32, lit: false },
    { at: 0.55, lit: true },
    { at: 0.78, lit: false },
  ],
  /** Index of the tower whose spire has fallen. */
  ruined: 2,
} as const;

const FLOOR = {
  slabs: 9,
  variance: 0.4,
  joint: 0.07,
  /** Slabs only ever sit BELOW the collision plane, never proud of it. */
  wear: { min: 0.01, max: 0.04 },
  bed: 0.07,
  ring: { inner: 5.9, outer: 6.2, segments: 72, y: 0, ticks: 8 },
  apron: 96,
} as const;

/* ===========================================================================
 * 2. Materials — six instances, shared by every mesh of that class.
 * ======================================================================== */

type MatKey = 'stone' | 'stoneDark' | 'metal' | 'wood' | 'cloth' | 'ember';

/** Mesh-name prefix per material class (dark stone is still `stone/`). */
const MAT_PREFIX: Record<MatKey, string> = {
  stone: 'stone',
  stoneDark: 'stone',
  metal: 'metal',
  wood: 'wood',
  cloth: 'cloth',
  ember: 'ember',
};

type Materials = Record<MatKey, THREE.MeshStandardMaterial>;

/* ===========================================================================
 * 2b. Trim sheets — Fantasy Props kit, staged into public/props/trim/.
 *
 * Each sheet is a hand-modeling trim atlas (a grid of DISTINCT edge/molding
 * pieces — a barrel lid here, a hinge there), not a seamless material meant to
 * tile as a whole. Feeding the full 2048² atlas through `projectTrimUVs`'s
 * world-space tiling would cycle through every prop icon it contains, which
 * is the "smeared noise" failure mode this whole module exists to avoid.
 *
 * So each material class instead samples ONE hand-picked, confirmed-tileable
 * rectangle inside its sheet — verified by rendering it 4×4 and checking for
 * seams before it went in this table — and `remapUVsToRegion` bakes the
 * repeat into the vertex UVs themselves rather than relying on the texture's
 * own (non-repeating) layout. Coordinates are pixel rects over the staged
 * 2048×2048 PNGs, converted to 0..1 by `region()`.
 * ======================================================================== */

const TRIM_SIZE = 2048;

/** `region()` takes pixel rects so the numbers below match what was judged
 * on-screen (a crop tool tiled at that rect) rather than pre-divided fractions. */
function region(x: number, y: number, w: number, h: number): TrimRegion {
  return { u0: x / TRIM_SIZE, v0: y / TRIM_SIZE, uw: w / TRIM_SIZE, vh: h / TRIM_SIZE };
}

type TrimRegion = { u0: number; v0: number; uw: number; vh: number };
type TrimSheet = 'props' | 'metal' | 'cloth';

const TRIM_SHEET_FILES: Record<TrimSheet, string> = {
  props: 'T_Trim_Props',
  metal: 'T_Trim_Metal',
  cloth: 'T_Trim_Cloth',
};

type TrimClassAssignment = {
  sheet: TrimSheet;
  region: TrimRegion;
  /**
   * Replaces the palette's flat `color` once a map is attached. The picked
   * rectangles read as pale, low-contrast plaster/metal on their own sheet —
   * multiplying by the ORIGINAL (much darker) palette color under this
   * scene's dim, warm, ember-dominated lighting crushed that contrast back
   * out to near-flat. A lighter tint here lets the map's own variation
   * survive that multiply instead of fighting it.
   */
  tint: number;
  /** Exaggerates the bump response so surface relief still reads under low,
   * warm point-light-only illumination, where base-color contrast alone
   * mostly disappears. */
  normalScale: number;
};

/**
 * Which sheet and which rectangle of it each material class samples.
 * `stoneDark` and `ember` are deliberately absent — they stay flat palette
 * colors, same as before. Wood samples the Props sheet: a bamboo/plank strip
 * along its top edge read better than anything in the Metal sheet for a
 * charred-timber read (judged on screen, see the commit message).
 */
const TRIM_ASSIGNMENT: Partial<Record<MatKey, TrimClassAssignment>> = {
  stone: { sheet: 'props', region: region(20, 910, 600, 400), tint: 0x8d9099, normalScale: 1.8 },
  wood: { sheet: 'props', region: region(50, 10, 400, 160), tint: 0x6a5738, normalScale: 1.6 },
  metal: { sheet: 'metal', region: region(100, 60, 500, 350), tint: 0x84827a, normalScale: 1.8 },
  cloth: { sheet: 'cloth', region: region(1300, 560, 500, 320), tint: 0x6b1f26, normalScale: 1 },
};

type TrimTextures = { map: THREE.Texture; normalMap: THREE.Texture; orm: THREE.Texture };

function trimAssetUrl(sheet: TrimSheet, suffix: 'BaseColor' | 'Normal' | 'ORM'): string {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
  return `${base}/props/trim/${TRIM_SHEET_FILES[sheet]}_${suffix}.png`;
}

/**
 * Load the three sheets used by `TRIM_ASSIGNMENT`. `flipY = false` on every
 * one of them so a UV computed directly from top-left pixel coordinates (as
 * `region()` above does) lands on the pixels it was judged against, instead
 * of three.js's default bottom-up flip silently mirroring the pick.
 *
 * Uses `document`/`Image` under the hood (`THREE.TextureLoader`), so this —
 * and everything downstream of it — must never be reached from `buildArena()`
 * itself. `arena.test.ts` builds the architecture in plain Node specifically
 * to keep the geometry contract checkable without a DOM, and that has to stay
 * true after this file grew textures.
 */
/**
 * `applyArenaTrim` has exactly one live caller today (`Arena`'s own
 * `useMemo`, which only ever runs once per mount) plus one dormant one
 * (`buildArenaScene`, exported but not yet called from anywhere) — so this
 * cache is not fixing an observed leak, it is closing off the one a second
 * caller (or a future remount) would otherwise hit for free: three.js
 * textures are not garbage-collected, and nothing here ever calls
 * `.dispose()`, so a second `loadTrimSheets` would double the VRAM these
 * three sheets hold rather than share it. Module-level rather than a `Map`
 * keyed by `t` — every real caller passes the same `THREE` module.
 */
let cachedTrimSheets: Record<TrimSheet, TrimTextures> | null = null;

function loadTrimSheets(t: typeof THREE): Record<TrimSheet, TrimTextures> {
  if (cachedTrimSheets) return cachedTrimSheets;
  const loader = new t.TextureLoader();
  const sheets = {} as Record<TrimSheet, TrimTextures>;
  for (const sheet of Object.keys(TRIM_SHEET_FILES) as TrimSheet[]) {
    const map = loader.load(trimAssetUrl(sheet, 'BaseColor'));
    const normalMap = loader.load(trimAssetUrl(sheet, 'Normal'));
    const orm = loader.load(trimAssetUrl(sheet, 'ORM'));
    map.colorSpace = t.SRGBColorSpace; // BaseColor is authored color; Normal/ORM stay linear (default).
    for (const tex of [map, normalMap, orm]) {
      tex.flipY = false;
      tex.wrapS = tex.wrapT = t.RepeatWrapping;
      tex.anisotropy = 8;
    }
    sheets[sheet] = { map, normalMap, orm };
  }
  cachedTrimSheets = sheets;
  return sheets;
}

/**
 * Bake a rectangle of a trim sheet into a geometry's existing UVs by
 * fractioning the world-space tiling coordinate `projectTrimUVs` already
 * produced, then remapping that 0..1 fraction into the rectangle. This is
 * what turns "one world unit = one step through the WHOLE atlas" into "one
 * world unit = one step through the CHOSEN tileable patch of it" — three.js's
 * hardware texture wrap can only repeat the full [0,1] texture, not an
 * arbitrary sub-rect, so the repeat has to be baked into the data instead.
 *
 * Pure arithmetic on an attribute array, same as `projectTrimUVs` — no DOM,
 * safe to run unconditionally inside `Emitter.finish()`.
 */
function frac(x: number): number {
  return x - Math.floor(x);
}

function remapUVsToRegion(geo: THREE.BufferGeometry, r: TrimRegion): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, r.u0 + frac(uv.getX(i)) * r.uw, r.v0 + frac(uv.getY(i)) * r.vh);
  }
  uv.needsUpdate = true;
}

/** Reverse of `MAT_PREFIX`+material `name`, for finding a class's material on a built group. */
const MATERIAL_NAME_TO_KEY: Record<string, MatKey> = {
  stone: 'stone',
  'stone.dark': 'stoneDark',
  'metal.oxidised': 'metal',
  'wood.charred': 'wood',
  'cloth.oxblood': 'cloth',
  ember: 'ember',
};

/**
 * Attach the trim sheets to an already-built arena's materials. Split out
 * from `buildArena()`/`createMaterials()` for the same DOM reason as
 * `loadTrimSheets` above — call this from the browser (or a headless page
 * that has `document`, e.g. `buildArenaScene`), never from `arena.test.ts`'s
 * plain-Node build.
 *
 * Finds each material by the name `createMaterials` already gives it rather
 * than threading a `Materials` handle through `buildArena`'s return value —
 * `buildArena()` returns a bare `THREE.Group` on purpose (see its own doc),
 * and every mesh already carries a name that says what it is.
 */
export function applyArenaTrim(architecture: THREE.Group, t: typeof THREE = THREE): void {
  const sheets = loadTrimSheets(t);
  const seen = new Set<THREE.Material>();
  architecture.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (!material || seen.has(material)) return;
    seen.add(material);

    const key = MATERIAL_NAME_TO_KEY[material.name];
    const assignment = key ? TRIM_ASSIGNMENT[key] : undefined;
    if (!assignment) return;

    const sheet = sheets[assignment.sheet];
    material.map = sheet.map;
    material.normalMap = sheet.normalMap;
    material.normalScale.set(assignment.normalScale, assignment.normalScale);
    material.color.setHex(assignment.tint);
    // Packed OcclusionRoughnessMetallic: three.js's shaders already know to
    // read R for AO, G for roughness, B for metalness off one texture — see
    // the aomap/roughnessmap/metalnessmap shader chunks. The scalar roughness
    // / metalness the palette already set become pure multipliers once a map
    // is attached, so they are left as authored rather than reset to 1: the
    // map modulates the palette's own read instead of replacing it outright.
    material.aoMap = sheet.orm;
    material.roughnessMap = sheet.orm;
    material.metalnessMap = sheet.orm;
    material.needsUpdate = true;
  });
}

function createMaterials(t: typeof THREE): Materials {
  return {
    stone: new t.MeshStandardMaterial({
      name: 'stone',
      color: 0x62666d,
      roughness: 0.95,
      metalness: 0,
    }),
    stoneDark: new t.MeshStandardMaterial({
      name: 'stone.dark',
      color: 0x30333a,
      roughness: 1,
      metalness: 0,
    }),
    metal: new t.MeshStandardMaterial({
      name: 'metal.oxidised',
      color: 0x4c4a42,
      roughness: 0.55,
      metalness: 0.85,
    }),
    wood: new t.MeshStandardMaterial({
      name: 'wood.charred',
      color: 0x342a20,
      roughness: 0.92,
      metalness: 0,
    }),
    cloth: new t.MeshStandardMaterial({
      name: 'cloth.oxblood',
      color: 0x4a1519,
      roughness: 0.95,
      metalness: 0,
      side: t.DoubleSide,
    }),
    ember: new t.MeshStandardMaterial({
      name: 'ember',
      color: 0xff6a22,
      roughness: 0.6,
      metalness: 0,
      emissive: 0xff4d12,
      emissiveIntensity: 2.4,
    }),
  };
}

/* ===========================================================================
 * 3. Determinism helpers — no Math.random anywhere in this file.
 * ======================================================================== */

type Rng = () => number;

/** mulberry32. */
function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const spread = (rng: Rng, a: number, b: number) => lerp(a, b, rng());

/**
 * Position-keyed hash. Used for erosion so that duplicated seam vertices of a
 * cylinder (which share a position) receive the *same* offset and no crack
 * opens up. Quantised, so 2π-vs-0 float dust cannot change the result.
 */
function hashPos(x: number, y: number, z: number, seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const v of [x, y, z]) {
    h = Math.imul(h ^ (Math.round(v * 512) | 0), 0x27d4eb2d) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
  }
  return h / 4294967296;
}

/** Split `total` into `count` irregular spans that still sum exactly. */
function partition(from: number, total: number, count: number, rng: Rng, variance: number): number[] {
  const weights: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const w = 1 + (rng() * 2 - 1) * variance;
    weights.push(w);
    sum += w;
  }
  const edges = [from];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    acc += weights[i];
    edges.push(i === count - 1 ? from + total : from + (acc / sum) * total);
  }
  return edges;
}

/* ===========================================================================
 * 4. Geometry helpers.
 * ======================================================================== */

type V3 = readonly [number, number, number];

/**
 * Truncated square pyramid standing on y = 0. Used for buttresses, plinths,
 * merlon caps and spires — one primitive, four silhouettes.
 * `taper` is the top/bottom size ratio (0 gives a pyramid).
 */
function frustum(t: typeof THREE, width: number, depth: number, height: number, taper: number): THREE.BufferGeometry {
  const g = new t.CylinderGeometry(Math.SQRT1_2 * taper, Math.SQRT1_2, height, 4, 1);
  g.rotateY(Math.PI / 4); // put the flats on the axes: face-to-face width = 1
  g.scale(width, 1, depth);
  g.translate(0, height / 2, 0);
  return g;
}

/** Cone standing on y = 0 (tower spires). */
function cone(t: typeof THREE, radius: number, height: number, segments: number): THREE.BufferGeometry {
  const g = new t.CylinderGeometry(0, radius, height, segments, 1);
  g.translate(0, height / 2, 0);
  return g;
}

/** Flat quad in the XY plane facing −z (recess backings, banners, windows). */
function backPlate(t: typeof THREE, width: number, height: number): THREE.BufferGeometry {
  const g = new t.PlaneGeometry(width, height);
  g.rotateY(Math.PI);
  return g;
}

/**
 * Two-centred (gothic) arch outline, wound clockwise so it can be used as an
 * ExtrudeGeometry hole. `point` 0 → semicircular head, 1 → equilateral point.
 * Returned in panel-local space: springing from y = 0 on the panel's base.
 */
function archOutline(t: typeof THREE, width: number, spring: number, point: number, segments: number): THREE.Vector2[] {
  const half = width / 2;
  const k = half * point; // how far the two arc centres are pushed apart
  const r = half + k;
  const end = Math.acos(-k / r); // angle at which the left arc reaches x = 0
  const left: THREE.Vector2[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = lerp(Math.PI, end, i / segments);
    left.push(new t.Vector2(k + r * Math.cos(a), spring + r * Math.sin(a)));
  }
  const pts: THREE.Vector2[] = [new t.Vector2(-half, 0), ...left];
  for (let i = segments - 1; i >= 0; i--) pts.push(new t.Vector2(-left[i].x, left[i].y));
  pts.push(new t.Vector2(half, 0));
  return pts;
}

/** Height of the crown of such an arch above its base. */
function archHeight(width: number, spring: number, point: number): number {
  const k = (width / 2) * point;
  const r = width / 2 + k;
  return spring + Math.sqrt(r * r - k * k);
}

/** A rectangular plate, optionally pierced, extruded along +z from z = 0. */
function piercedPanel(
  t: typeof THREE,
  width: number,
  height: number,
  depth: number,
  hole: THREE.Vector2[] | null,
): THREE.BufferGeometry {
  const shape = new t.Shape();
  shape.moveTo(-width / 2, 0); // wound CCW; holes are wound CW
  shape.lineTo(width / 2, 0);
  shape.lineTo(width / 2, height);
  shape.lineTo(-width / 2, height);
  shape.closePath();
  if (hole) {
    const path = new t.Path();
    path.setFromPoints(hole);
    shape.holes.push(path);
  }
  return new t.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
}

/**
 * Push vertices radially OUTWARD by up to `amount`. Outward-only is what keeps
 * eroded shafts legal: the collider radius can never be undercut.
 */
function erodeRadially(geo: THREE.BufferGeometry, amount: number, seed: number): void {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-4) continue;
    const k = 1 + hashPos(x, y, z, seed) * amount;
    p.setX(i, x * k);
    p.setZ(i, z * k);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
}

/**
 * Concatenate geometries into one non-indexed buffer.
 * Non-indexed on purpose: it removes all index bookkeeping AND guarantees that
 * no vertex is shared between differently-facing triangles, which is exactly
 * the precondition the per-vertex UV projection below needs.
 */
function mergeGeometries(t: typeof THREE, geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = geos.map((g) => {
    if (!g.attributes.normal) g.computeVertexNormals();
    return g.index ? g.toNonIndexed() : g;
  });
  let count = 0;
  for (const g of flat) count += g.attributes.position.count;

  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  let offset = 0;
  for (const g of flat) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    position.set(p.array as Float32Array, offset * 3);
    normal.set(n.array as Float32Array, offset * 3);
    offset += p.count;
  }

  const merged = new t.BufferGeometry();
  merged.setAttribute('position', new t.BufferAttribute(position, 3));
  merged.setAttribute('normal', new t.BufferAttribute(normal, 3));
  return merged;
}

/**
 * World-space triplanar UVs at a single texel density: every surface in the
 * arena gets the same units-per-tile, and vertical faces get v = height, which
 * is what a trim sheet wants. No stretching, no per-mesh scale drift.
 *
 * The projection axis is chosen per TRIANGLE from its geometric normal (not
 * per vertex from a shaded normal), which is what keeps a triangle's three UVs
 * on one plane. Requires the non-indexed layout `mergeGeometries` produces, so
 * texel density is bounded to [cos(54.7°), 1] × scale² — no seam blowouts.
 */
function projectTrimUVs(t: typeof THREE, geo: THREE.BufferGeometry, scale: number): void {
  const p = geo.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i += 3) {
    const ax = p.getX(i);
    const ay = p.getY(i);
    const az = p.getZ(i);
    const ex = p.getX(i + 1) - ax;
    const ey = p.getY(i + 1) - ay;
    const ez = p.getZ(i + 1) - az;
    const fx = p.getX(i + 2) - ax;
    const fy = p.getY(i + 2) - ay;
    const fz = p.getZ(i + 2) - az;
    const nx = Math.abs(ey * fz - ez * fy);
    const ny = Math.abs(ez * fx - ex * fz);
    const nz = Math.abs(ex * fy - ey * fx);
    // 0 = horizontal (uv = x,z), 1 = facing ±x (uv = z,y), 2 = facing ±z (uv = x,y)
    const axis = ny >= nx && ny >= nz ? 0 : nx >= nz ? 1 : 2;
    for (let k = 0; k < 3; k++) {
      const x = p.getX(i + k);
      const y = p.getY(i + k);
      const z = p.getZ(i + k);
      uv[(i + k) * 2] = (axis === 1 ? z : x) * scale;
      uv[(i + k) * 2 + 1] = (axis === 0 ? z : y) * scale;
    }
  }
  geo.setAttribute('uv', new t.BufferAttribute(uv, 2));
}

/* ===========================================================================
 * 5. Emitter — a transform stack that buckets geometry by (group, material).
 * ======================================================================== */

interface Bucket {
  group: string;
  mat: MatKey;
  geos: THREE.BufferGeometry[];
}

class Emitter {
  private readonly t: typeof THREE;
  private readonly buckets: Map<string, Bucket>;
  private readonly matrix: THREE.Matrix4;

  private constructor(t: typeof THREE, buckets: Map<string, Bucket>, matrix: THREE.Matrix4) {
    this.t = t;
    this.buckets = buckets;
    this.matrix = matrix;
  }

  static root(t: typeof THREE): Emitter {
    return new Emitter(t, new Map(), new t.Matrix4());
  }

  /** Child frame: rotate about y, then translate. */
  at(x: number, y: number, z: number, ry = 0): Emitter {
    return this.xform(new this.t.Matrix4().makeRotationY(ry).setPosition(x, y, z));
  }

  /** Child frame from an arbitrary matrix (voussoirs, tilted rubble, …). */
  xform(m: THREE.Matrix4): Emitter {
    return new Emitter(this.t, this.buckets, this.matrix.clone().multiply(m));
  }

  /** Adopt `geo` (it is transformed in place) into `group` with `mat`. */
  add(group: string, mat: MatKey, geo: THREE.BufferGeometry): this {
    geo.applyMatrix4(this.matrix);
    const key = `${group}|${mat}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { group, mat, geos: [] };
      this.buckets.set(key, bucket);
    }
    bucket.geos.push(geo);
    return this;
  }

  /** Axis-aligned mass given by its local extents — how masonry is thought about. */
  box(group: string, mat: MatKey, min: V3, max: V3): this {
    const g = new this.t.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    g.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    return this.add(group, mat, g);
  }

  /** Local point → world, for registering light positions. */
  worldPoint(p: V3): THREE.Vector3 {
    return new this.t.Vector3(p[0], p[1], p[2]).applyMatrix4(this.matrix);
  }

  finish(materials: Materials): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const bucket of this.buckets.values()) {
      const geo = mergeGeometries(this.t, bucket.geos);
      projectTrimUVs(this.t, geo, UV_PER_UNIT);
      const trim = TRIM_ASSIGNMENT[bucket.mat];
      if (trim) remapUVsToRegion(geo, trim.region);
      geo.computeBoundingSphere();
      const mesh = new this.t.Mesh(geo, materials[bucket.mat]);
      mesh.name = `${MAT_PREFIX[bucket.mat]}/${bucket.group}`;
      mesh.castShadow = bucket.mat !== 'ember';
      mesh.receiveShadow = bucket.mat !== 'ember';
      meshes.push(mesh);
    }
    return meshes;
  }
}

/** Mesh group ids (mesh name = `<material class>/<group>`). */
const G = {
  floor: 'floor',
  floorBase: 'floor_base',
  ring: 'duel_ring',
  pillars: 'pillars',
  towers: 'towers',
  towersRecess: 'towers_recess',
  spires: 'tower_spires',
  fixtures: 'fixtures',
  embers: 'embers',
  banners: 'banners',
  doors: 'gate_doors',
  wall: (side: string) => `wall_${side}`,
  wallRecess: (side: string) => `wall_${side}_recess`,
} as const;

/** Shared build context: the emitter plus the ember-light registry. */
class Arena {
  readonly root: Emitter;
  readonly embers: THREE.Vector3[] = [];
  readonly t: typeof THREE;

  constructor(t: typeof THREE) {
    this.t = t;
    this.root = Emitter.root(t);
  }

  /** A glowing coal cluster; also registers a light anchor for the sandbox. */
  ember(f: Emitter, at: V3, radius: number, register = true): void {
    const g = new this.t.IcosahedronGeometry(radius, 0);
    g.scale(1, 1.45, 1);
    g.translate(at[0], at[1], at[2]);
    f.add(G.embers, 'ember', g);
    if (register) this.embers.push(f.worldPoint([at[0], at[1] + radius, at[2]]));
  }
}

/* ===========================================================================
 * 6. Ground.
 * ======================================================================== */

function buildGround(a: Arena): void {
  const t = a.t;
  const f = a.root;
  const rng = makeRng(SEED ^ 0x101);
  const size = GROUND_HALF * 2;

  // Irregular flagstones. Every slab sits at or below y = 0 so the walkable
  // plane is never breached; the joints show the dark bed underneath.
  const xs = partition(-GROUND_HALF, size, FLOOR.slabs, rng, FLOOR.variance);
  const zs = partition(-GROUND_HALF, size, FLOOR.slabs, rng, FLOOR.variance);
  const j = FLOOR.joint / 2;
  for (let i = 0; i < FLOOR.slabs; i++) {
    for (let k = 0; k < FLOOR.slabs; k++) {
      const w = xs[i + 1] - xs[i] - FLOOR.joint;
      const d = zs[k + 1] - zs[k] - FLOOR.joint;
      const g = new t.PlaneGeometry(w, d);
      g.rotateX(-Math.PI / 2);
      g.translate(xs[i] + j + w / 2, -spread(rng, FLOOR.wear.min, FLOOR.wear.max), zs[k] + j + d / 2);
      f.add(G.floor, 'stone', g);
    }
  }

  // Bed under the joints, plus an apron so the towers outside the walls are
  // not standing on the void when the arena is read from an ortho view.
  for (const [span, y] of [
    [size, -FLOOR.bed],
    [FLOOR.apron, -0.5],
  ] as const) {
    const g = new t.PlaneGeometry(span, span);
    g.rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    f.add(G.floorBase, 'stoneDark', g);
  }

  // Duelling circle: a bronze inlay, the one piece of "decoration" that tells
  // the player where the fight is meant to happen.
  const ring = new t.RingGeometry(FLOOR.ring.inner, FLOOR.ring.outer, FLOOR.ring.segments);
  ring.rotateX(-Math.PI / 2);
  ring.translate(0, FLOOR.ring.y, 0);
  f.add(G.ring, 'metal', ring);
  for (let i = 0; i < FLOOR.ring.ticks; i++) {
    const angle = (i / FLOOR.ring.ticks) * Math.PI * 2;
    const r = FLOOR.ring.outer + 0.35;
    f.at(Math.sin(angle) * r, 0, Math.cos(angle) * r, angle).box(
      G.ring,
      'metal',
      [-0.09, FLOOR.ring.y - 0.01, -0.4],
      [0.09, FLOOR.ring.y, 0.4],
    );
  }
}

/* ===========================================================================
 * 7. Wall module.
 * ======================================================================== */

type BayKind = 'arch' | 'slit' | 'blocked' | 'gate';

interface BayCtx {
  a: Arena;
  /** Frame at the bay centre on the collider plane (wall-local axes). */
  f: Emitter;
  stone: string;
  dark: string;
  /** Clear width between the flanking piers. */
  width: number;
  rng: Rng;
}

/** Everything shared by a pierced bay: panel plate + dark backing. */
function bayPanel(c: BayCtx, hole: THREE.Vector2[] | null, base: number, top: number): void {
  const height = top - base;
  const panel = piercedPanel(c.a.t, c.width, height, WALL.panel.depth, hole);
  panel.translate(0, base, WALL.panel.front);
  c.f.add(c.stone, 'stone', panel);
  const plate = backPlate(c.a.t, c.width, height);
  plate.translate(0, base + height / 2, WALL.recessZ);
  c.f.add(c.dark, 'stoneDark', plate);
}

/** Base course under a bay, optionally interrupted for a doorway. */
function bayPlinth(c: BayCtx, gap = 0): void {
  const half = c.width / 2;
  const spans: (readonly [number, number])[] = gap
    ? [
        [-half, -gap / 2],
        [gap / 2, half],
      ]
    : [[-half, half]];
  for (const [x0, x1] of spans) {
    c.f.box(c.stone, 'stone', [x0, 0, 0], [x1, WALL.plinth.height, WALL.plinth.depth]);
  }
}

/** Blind arcade bay: the default. May hold a banner or a wall brazier. */
function buildArchBay(c: BayCtx): void {
  const { width, spring, point } = WALL.niche;
  bayPlinth(c);
  bayPanel(c, archOutline(c.a.t, width, spring, point, 9), WALL.plinth.height, WALL.arcadeTop);

  const openingTop = WALL.plinth.height + archHeight(width, spring, point);
  if (c.rng() < WALL.banner.chance) {
    const top = openingTop - 0.45;
    const banner = bannerGeometry(c.a.t, WALL.banner.width, WALL.banner.height, c.rng);
    banner.translate(0, top - WALL.banner.height / 2, WALL.recessZ - 0.04);
    c.f.add(G.banners, 'cloth', banner);
    c.f.box(G.fixtures, 'metal', [-WALL.banner.width * 0.6, top, WALL.recessZ - 0.12], [
      WALL.banner.width * 0.6,
      top + 0.1,
      WALL.recessZ - 0.02,
    ]);
  } else if (c.rng() < WALL.brazier.chance) {
    const y = WALL.brazier.y;
    const z = WALL.recessZ - 0.24;
    c.f.box(G.fixtures, 'metal', [-0.42, y, z - 0.1], [0.42, y + 0.3, WALL.recessZ - 0.02]);
    c.f.box(G.fixtures, 'metal', [-0.1, y - 0.5, WALL.recessZ - 0.12], [0.1, y, WALL.recessZ - 0.02]);
    c.a.ember(c.f, [0, y + 0.28, z + 0.05], 0.24);
  }
}

/** Arrow slit: a hairline of dark in a blank panel. */
function buildSlitBay(c: BayCtx): void {
  const { width, spring, point } = WALL.slit;
  bayPlinth(c);
  bayPanel(c, archOutline(c.a.t, width, spring, point, 4), WALL.plinth.height, WALL.arcadeTop);
}

/** A bay whose arcade was bricked up when the arena was last besieged. */
function buildBlockedBay(c: BayCtx): void {
  const { width, spring, point } = WALL.niche;
  bayPlinth(c);
  bayPanel(c, archOutline(c.a.t, width, spring, point, 9), WALL.plinth.height, WALL.arcadeTop);

  const top = WALL.plinth.height + archHeight(width, spring, point);
  let y = WALL.plinth.height;
  let course = 0;
  while (y < top - 0.5) {
    const h = spread(c.rng, 0.32, 0.52);
    const inset = 0.08 * (course % 2);
    const w = width / 2 - inset - 0.02;
    c.f.box(c.dark, 'stoneDark', [-w, y, WALL.recessZ - 0.16], [w, Math.min(y + h, top - 0.5), WALL.recessZ - 0.02]);
    y += h;
    course++;
  }
}

/** The sealed gate: pointed arch, voussoir surround, portcullis, barred doors. */
function buildGateBay(c: BayCtx): void {
  const t = c.a.t;
  const { width, spring, point, front, depth, doorTop } = WALL.gate;
  bayPlinth(c, width);

  // Full-height pierced plate, proud of the arcade panels.
  const height = WALL.arcadeTop;
  const panel = piercedPanel(t, c.width, height, depth, archOutline(t, width, spring, point, 12));
  panel.translate(0, 0, front);
  c.f.add(c.stone, 'stone', panel);
  const plate = backPlate(t, c.width, height);
  plate.translate(0, height / 2, WALL.recessZ);
  c.f.add(c.dark, 'stoneDark', plate);

  // Voussoirs: individual wedge blocks stepping around the arch head.
  const half = width / 2;
  const k = half * point;
  const r = half + k;
  const end = Math.acos(-k / r);
  const steps = 9;
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i <= steps; i++) {
      const angle = lerp(Math.PI, end, i / steps);
      const cx = side * (k + (r + 0.28) * Math.cos(angle));
      const cy = spring + (r + 0.28) * Math.sin(angle);
      const m = new t.Matrix4().makeRotationZ(side * (angle - Math.PI / 2)).setPosition(cx, cy, front);
      c.f.xform(m).box(c.stone, 'stone', [-0.3, -0.26, -0.1], [0.3, 0.26, 0.16]);
    }
  }

  // Double doors, plank by plank, strapped with iron.
  const leaf = width / 2 - 0.06;
  const planks = 5;
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < planks; i++) {
      const w = leaf / planks;
      const x0 = side > 0 ? 0.05 + i * w : -0.05 - (i + 1) * w;
      const z = 0.5 + spread(c.rng, 0, 0.03);
      c.f.box(G.doors, 'wood', [x0 + 0.01, 0, z], [x0 + w - 0.01, doorTop, z + 0.16]);
    }
    for (const y of [1.0, 3.4]) {
      c.f.box(G.fixtures, 'metal', [side > 0 ? 0.05 : -half, y, 0.63], [side > 0 ? half : -0.05, y + 0.22, 0.7]);
    }
  }

  // Portcullis, dropped and rusted into place.
  const bars = 7;
  for (let i = 0; i < bars; i++) {
    const x = lerp(-half + 0.2, half - 0.2, i / (bars - 1));
    c.f.box(G.fixtures, 'metal', [x - 0.06, 0, 0.22], [x + 0.06, doorTop + 0.7, 0.32]);
  }
  for (const y of [0.6, 2.6, 4.6]) {
    c.f.box(G.fixtures, 'metal', [-half + 0.14, y, 0.23], [half - 0.14, y + 0.12, 0.31]);
  }
}

const BAY_BUILDERS: Record<BayKind, (c: BayCtx) => void> = {
  arch: buildArchBay,
  slit: buildSlitBay,
  blocked: buildBlockedBay,
  gate: buildGateBay,
};

/** Hanging banner with a little slack and a swallow tail. */
function bannerGeometry(t: typeof THREE, width: number, height: number, rng: Rng): THREE.BufferGeometry {
  const rows = 8;
  const g = new t.PlaneGeometry(width, height, 2, rows);
  const p = g.attributes.position;
  const phase = rng() * Math.PI * 2;
  const amp = spread(rng, 0.05, 0.12);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const drop = (height / 2 - y) / height; // 0 at the rod, 1 at the hem
    p.setZ(i, Math.sin(phase + drop * 4.2) * amp * drop * height * 0.4);
    p.setX(i, x * (1 - 0.1 * drop));
    if (Math.abs(y + height / 2) < 1e-6 && Math.abs(x) < 1e-6) p.setY(i, y + height * 0.14);
  }
  g.rotateY(Math.PI); // face the arena
  g.computeVertexNormals();
  return g;
}

function bayKinds(rng: Rng, bays: number, decay: number, gateBay: number): BayKind[] {
  const kinds: BayKind[] = [];
  for (let i = 0; i < bays; i++) {
    if (i === gateBay) {
      kinds.push('gate');
      continue;
    }
    const r = rng();
    kinds.push(r < 0.1 + decay * 0.22 ? 'blocked' : r < 0.42 ? 'slit' : 'arch');
  }
  return kinds;
}

interface WallSide {
  id: string;
  x: number;
  z: number;
  ry: number;
}

/** n = −z, s = +z, e = +x, w = −x. Local +z always points away from the arena. */
const SIDES: readonly WallSide[] = [
  { id: 'n', x: 0, z: -GROUND_HALF, ry: Math.PI },
  { id: 's', x: 0, z: GROUND_HALF, ry: 0 },
  { id: 'e', x: GROUND_HALF, z: 0, ry: Math.PI / 2 },
  { id: 'w', x: -GROUND_HALF, z: 0, ry: -Math.PI / 2 },
];

function buildWall(a: Arena, side: WallSide, index: number, gateBay: number): void {
  const f = a.root.at(side.x, 0, side.z, side.ry);
  const rng = makeRng(SEED + 1013 * (index + 1));
  const decay = rng();
  const stone = G.wall(side.id);
  const dark = G.wallRecess(side.id);
  const half = WALL.span / 2;
  const bayWidth = WALL.span / WALL.bays;

  // Piers first: they set out where the bays can be.
  const piers: { x0: number; x1: number }[] = [];
  for (let i = 0; i <= WALL.bays; i++) {
    let cx = -half + i * bayWidth;
    if (i === 0) cx += WALL.pier.width / 2; // keep the end piers flush with the span
    if (i === WALL.bays) cx -= WALL.pier.width / 2;
    const { x0, x1 } = { x0: cx - WALL.pier.width / 2, x1: cx + WALL.pier.width / 2 };
    piers.push({ x0, x1 });
    const capBase = WALL.arcadeTop - WALL.pier.cap;
    f.box(stone, 'stone', [x0, WALL.plinth.height, 0], [x1, capBase, WALL.pier.depth]);
    // Capital: corbels sideways over the arcade, never toward the arena.
    const s = WALL.pier.capSpread;
    f.box(stone, 'stone', [x0 - s, capBase, 0], [x1 + s, WALL.arcadeTop, WALL.pier.depth + s * 0.6]);
  }

  // Solid core behind the arcade — this is what actually seals the arena.
  f.box(stone, 'stone', [-half, 0, WALL.coreFront], [half, WALL.arcadeTop, WALL.bodyDepth]);
  // Cornice, then the set-back upper wall and its crenellations.
  const corniceTop = WALL.arcadeTop + WALL.cornice.height;
  f.box(stone, 'stone', [-half, WALL.arcadeTop, 0], [half, corniceTop, WALL.bodyDepth + WALL.cornice.projection]);
  f.box(stone, 'stone', [-half, corniceTop, WALL.upper.inset], [half, WALL.upper.top, WALL.bodyDepth]);

  // One slit per bay through the parapet, with a stone sill under it: it gives
  // the otherwise blank upper wall a rhythm that matches the arcade below.
  const slitBase = corniceTop + WALL.parapet.slitY;
  for (let i = 0; i < WALL.bays; i++) {
    const cx = -half + (i + 0.5) * bayWidth;
    const w = WALL.parapet.slitWidth / 2;
    f.box(dark, 'stoneDark', [cx - w, slitBase, WALL.upper.inset - 0.05], [cx + w, slitBase + WALL.parapet.slitHeight, WALL.upper.inset]);
    f.box(stone, 'stone', [cx - w - 0.22, slitBase - 0.16, WALL.upper.inset - 0.11], [cx + w + 0.22, slitBase, WALL.upper.inset]);
  }

  const period = WALL.merlon.width + WALL.merlon.gap;
  const count = Math.floor(WALL.span / period);
  const start = -half + (WALL.span - count * period + WALL.merlon.gap) / 2;
  for (let i = 0; i < count; i++) {
    if (rng() < WALL.merlon.missing + decay * 0.16) continue;
    const h = WALL.merlon.height * spread(rng, 0.55, 1.1);
    const x0 = start + i * period;
    f.box(stone, 'stone', [x0, WALL.upper.top - 0.06, WALL.upper.inset], [
      x0 + WALL.merlon.width,
      WALL.upper.top + h,
      WALL.bodyDepth,
    ]);
  }

  // Outer face relief, strictly outboard of the wall mass: battered buttresses
  // on every other bay joint, shallow pilaster strips on the rest.
  for (let i = 1; i < WALL.bays; i++) {
    const cx = -half + i * bayWidth;
    if (i % WALL.buttress.every === 0) {
      const top = WALL.buttress.top * spread(rng, 0.88, 1.05);
      const g = frustum(a.t, WALL.buttress.width, WALL.buttress.depth - WALL.bodyDepth + 0.2, top, WALL.buttress.taper);
      g.translate(cx, 0, WALL.bodyDepth + (WALL.buttress.depth - WALL.bodyDepth - 0.2) / 2);
      f.add(stone, 'stone', g);
    } else {
      f.box(stone, 'stone', [cx - 0.55, 0, WALL.bodyDepth - 0.1], [cx + 0.55, WALL.arcadeTop, WALL.bodyDepth + 0.22]);
    }
  }

  // Bays.
  const kinds = bayKinds(rng, WALL.bays, decay, gateBay);
  for (let i = 0; i < WALL.bays; i++) {
    const x0 = piers[i].x1;
    const x1 = piers[i + 1].x0;
    const ctx: BayCtx = {
      a,
      f: f.at((x0 + x1) / 2, 0, 0),
      stone,
      dark,
      width: x1 - x0,
      rng,
    };
    BAY_BUILDERS[kinds[i]](ctx);
  }
}

/* ===========================================================================
 * 8. Pillar module. Ornament may only grow outward or upward.
 * ======================================================================== */

function buildPillar(a: Arena, index: number, x: number, z: number): void {
  const t = a.t;
  const rng = makeRng(SEED + 7717 * (index + 1));
  const f = a.root.at(x, 0, z, rng() * Math.PI * 2);
  const ruined = index === PILLAR.ruined;

  const plinth = frustum(t, PILLAR.plinth.width, PILLAR.plinth.width, PILLAR.plinth.height, PILLAR.plinth.taper);
  f.add(G.pillars, 'stone', plinth);

  let y = PILLAR.plinth.height;
  const socle = new t.CylinderGeometry(PILLAR.socle.radius, PILLAR.socle.radius + 0.04, PILLAR.socle.height, PILLAR.shaft.segments);
  socle.translate(0, y + PILLAR.socle.height / 2, 0);
  f.add(G.pillars, 'stone', socle);
  y += PILLAR.socle.height;

  // Shaft. A 16-gon of circumradius r has inradius r·cos(π/16) = 0.98·r, so
  // the narrowest point (0.96 → 0.94) still clears the 0.9 collider radius,
  // and erosion only ever pushes vertices outward.
  const shaftTop = PILLAR.shaft.top_y;
  const shaft = new t.CylinderGeometry(PILLAR.shaft.top, PILLAR.shaft.bottom, shaftTop - y, PILLAR.shaft.segments, 3, true);
  shaft.translate(0, (y + shaftTop) / 2, 0);
  erodeRadially(shaft, PILLAR.shaft.erosion, SEED + index);
  f.add(G.pillars, 'stone', shaft);

  for (const bandY of PILLAR.band.at) {
    const band = new t.CylinderGeometry(PILLAR.band.radius, PILLAR.band.radius, PILLAR.band.height, PILLAR.shaft.segments, 1, true);
    band.translate(0, bandY, 0);
    f.add(G.fixtures, 'metal', band);
  }

  const neck = new t.CylinderGeometry(PILLAR.neck.radius, PILLAR.neck.radius, PILLAR.neck.height, PILLAR.shaft.segments, 1, true);
  neck.translate(0, shaftTop + PILLAR.neck.height / 2, 0);
  f.add(G.pillars, 'stone', neck);

  // Capital flares outward-and-up, then an abacus caps the collider height.
  const capitalY = shaftTop + PILLAR.neck.height;
  const capital = new t.CylinderGeometry(PILLAR.capital.radius, PILLAR.neck.radius, PILLAR.capital.height, PILLAR.shaft.segments);
  capital.translate(0, capitalY + PILLAR.capital.height / 2, 0);
  f.add(G.pillars, 'stone', capital);
  const abacusY = capitalY + PILLAR.capital.height;
  f.box(G.pillars, 'stone', [-PILLAR.abacus.width / 2, abacusY - 0.04, -PILLAR.abacus.width / 2], [
    PILLAR.abacus.width / 2,
    abacusY + PILLAR.abacus.height,
    PILLAR.abacus.width / 2,
  ]);

  // Everything from here up is above the collider, so the beacon drum is free
  // to be as narrow as the silhouette wants: the pillars read tall, not squat.
  // It is also the only place a ruin may be carved — the shaft below has to go
  // on covering its collider all the way to PILLAR_HEIGHT.
  const drumY = abacusY + PILLAR.abacus.height;
  if (ruined) {
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + 0.3;
      const r = spread(rng, 0.2, 0.42);
      const m = new t.Matrix4()
        .makeRotationY(angle)
        .setPosition(Math.sin(angle) * r, drumY - 0.05, Math.cos(angle) * r);
      m.multiply(new t.Matrix4().makeRotationX(spread(rng, -0.3, 0.3)));
      f.xform(m).add(G.pillars, 'stone', frustum(t, spread(rng, 0.32, 0.5), 0.42, spread(rng, 0.3, 0.95), 0.7));
    }
    return;
  }

  const drum = new t.CylinderGeometry(PILLAR.drum.top, PILLAR.drum.bottom, PILLAR.drum.height, PILLAR.shaft.segments, 2, true);
  drum.translate(0, drumY + PILLAR.drum.height / 2, 0);
  erodeRadially(drum, PILLAR.shaft.erosion, SEED + 31 * index);
  f.add(G.pillars, 'stone', drum);

  const corbelY = drumY + PILLAR.drum.height;
  const corbel = new t.CylinderGeometry(PILLAR.bowl.radius, PILLAR.drum.top, PILLAR.bowl.corbel, PILLAR.shaft.segments);
  corbel.translate(0, corbelY + PILLAR.bowl.corbel / 2, 0);
  f.add(G.pillars, 'stone', corbel);

  // Fire bowl — a lathe profile, seated far above the collider so nothing that
  // burns is ever inside a volume the player can walk into.
  const bowlY = corbelY + PILLAR.bowl.corbel;
  const profile = [
    [0.16, 0],
    [0.26, 0.08],
    [0.3, 0.18],
    [0.68, 0.42],
    [PILLAR.bowl.radius, 0.56],
    [PILLAR.bowl.radius - 0.13, PILLAR.bowl.height],
  ].map(([r, h]) => new t.Vector2(r, h));
  const bowl = new t.LatheGeometry(profile, PILLAR.shaft.segments);
  bowl.translate(0, bowlY, 0);
  f.add(G.fixtures, 'metal', bowl);
  a.ember(f, [0, bowlY + PILLAR.bowl.height - 0.16, 0], 0.46);
}

/* ===========================================================================
 * 9. Corner towers — outside the walls, purely for silhouette.
 * ======================================================================== */

function buildTower(a: Arena, index: number, sx: number, sz: number): void {
  const t = a.t;
  const rng = makeRng(SEED + 3301 * (index + 1));
  const f = a.root.at(sx * TOWER.at, 0, sz * TOWER.at, rng() * Math.PI * 2);
  const height = TOWER.heights[index % TOWER.heights.length];
  const ruined = index === TOWER.ruined;

  const shaft = new t.CylinderGeometry(TOWER.radius * TOWER.taper, TOWER.radius, height, TOWER.segments, 4, true);
  shaft.translate(0, height / 2, 0);
  erodeRadially(shaft, TOWER.erosion, SEED + 91 * index);
  f.add(G.towers, 'stone', shaft);

  // Openings, a couple of them lit from within.
  const rAt = (u: number) => lerp(TOWER.radius, TOWER.radius * TOWER.taper, u);
  for (const win of TOWER.windows) {
    const y = height * win.at;
    const r = rAt(win.at);
    // Face the arena: the tower sits on the (sx, sz) diagonal.
    const angle = Math.atan2(-sx, -sz) + spread(rng, -0.5, 0.5);
    const wf = f.at(Math.sin(angle) * r, y, Math.cos(angle) * r, angle);
    wf.box(G.towersRecess, 'stoneDark', [-0.34, 0, -0.16], [0.34, 1.5, 0.06]);
    const lit = win.lit && !ruined;
    // Lit windows are pure emissive and are deliberately NOT registered as
    // light anchors — they are skyline, not local illumination.
    wf.box(lit ? G.embers : G.towersRecess, lit ? 'ember' : 'stoneDark', [-0.22, 0.12, 0.02], [0.22, 1.34, 0.06]);
  }

  // String courses: two thin bands that break the shaft's height at a scale a
  // 2.0-unit humanoid can read from the arena floor.
  for (const u of [0.34, 0.68]) {
    const cr = lerp(TOWER.radius, TOWER.radius * TOWER.taper, u) + 0.14;
    const course = new t.CylinderGeometry(cr, cr, 0.3, TOWER.segments, 1, true);
    course.translate(0, height * u, 0);
    f.add(G.towers, 'stone', course);
  }

  const corbel = new t.CylinderGeometry(TOWER.corbel.radius, TOWER.radius * TOWER.taper + 0.08, TOWER.corbel.height, TOWER.segments);
  corbel.translate(0, height + TOWER.corbel.height / 2, 0);
  f.add(G.towers, 'stone', corbel);

  const capY = height + TOWER.corbel.height;
  const mr = TOWER.corbel.radius - TOWER.merlons.depth / 2;
  for (let i = 0; i < TOWER.merlons.count; i++) {
    if (rng() < (ruined ? 0.35 : 0.12)) continue;
    const angle = (i / TOWER.merlons.count) * Math.PI * 2;
    const h = TOWER.merlons.height * spread(rng, 0.6, 1.05);
    f.at(Math.sin(angle) * mr, capY - 0.06, Math.cos(angle) * mr, angle).box(G.towers, 'stone', [
      -TOWER.merlons.width / 2,
      0,
      -TOWER.merlons.depth / 2,
    ], [TOWER.merlons.width / 2, h, TOWER.merlons.depth / 2]);
  }

  if (ruined) return;
  const spire = cone(t, TOWER.spire.radius, TOWER.spire.height, TOWER.segments);
  spire.translate(0, capY, 0);
  f.add(G.spires, 'wood', spire);
}

/* ===========================================================================
 * 10. Assembly.
 * ======================================================================== */

export function buildArena(): THREE.Group {
  const arena = new Arena(THREE);
  const materials = createMaterials(THREE);

  buildGround(arena);
  const gateBay = (WALL.bays - 1) / 2;
  SIDES.forEach((side, i) => buildWall(arena, side, i, side.id === 'n' ? gateBay : -1));
  PILLAR_AT.forEach(([x, z], i) => buildPillar(arena, i, x, z));
  [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ].forEach(([sx, sz], i) => buildTower(arena, i, sx, sz));

  const group = new THREE.Group();
  group.name = 'arena';
  const meshes = arena.root.finish(materials);
  let triangles = 0;
  for (const mesh of meshes) {
    triangles += mesh.geometry.attributes.position.count / 3;
    group.add(mesh);
  }
  group.userData = {
    /** Budget bookkeeping — the brief's limits are 50000 / 40 / 6. */
    stats: { triangles, meshes: meshes.length, materials: Object.keys(materials).length },
    /** Anchors for the sandbox to hang warm point lights on. */
    emberPoints: arena.embers.map((v) => ({ x: v.x, y: v.y, z: v.z })),
    /** Restated so a consumer can assert the visuals against the colliders. */
    contract: { groundHalf: GROUND_HALF, wallSpan: WALL_SPAN, pillarRadius: PILLAR_RADIUS, pillarHeight: PILLAR_HEIGHT },
  };
  return group;
}
