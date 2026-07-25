/**
 * Vendor the upstream animation libraries into something we own.
 *
 * Three jobs, and they are the same job. The packs are copied into a gitignored
 * folder under `public/` so the sandbox can audition every clip without ~15 MB
 * of animation living in the repo. Clips whose names describe the wrong thing
 * are RENAMED — in the file, not in a lookup table. And clips this game will
 * never use are DROPPED, along with the keyframe data behind them.
 *
 * The rename rule is the important one. A clip's name is the key everything
 * resolves by: the extractor finds it with `getName() === clipName`, the
 * catalog reads it from `gltf.animations[]`, the binding table stores it. A
 * nicer name that exists only in our UI is a translation layer, and every
 * translation layer on this branch has turned out to be a bug waiting for the
 * combination nobody tested. So it happens once, here, at the boundary where
 * their files become our files, and downstream there is only one name.
 *
 *   node tools/stage-dev-assets.mjs --source "C:/Users/you/Assets/quaternius"
 *   QUATERNIUS_ROOT=/path/to/packs node tools/stage-dev-assets.mjs
 *
 * The packs are free from quaternius.com. The originals are never modified, so
 * every decision here is reversible by editing a table and re-running.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '..', 'client', 'public', 'anim-lib');

/**
 * What we want, by source basename. Root-motion (`_RM`) twins are deliberately
 * NOT staged: they are the same 43 clips with movement baked into the root, so
 * they would double the browse list to no purpose. They matter later, for
 * measuring real move speed off a walk cycle — a different job than auditioning.
 */
const WANTED = [
  { match: 'UAL1_Standard.glb', as: 'ual1.glb', kind: 'library', label: 'Universal Animation Library' },
  { match: 'UAL2_Standard.glb', as: 'ual2.glb', kind: 'library', label: 'Universal Animation Library 2' },
  { match: 'Mannequin_F.glb', as: 'mannequin-f.glb', kind: 'body', label: 'Female mannequin' },
];

/**
 * Clips the packs named for an intent rather than a gesture.
 *
 * `Melee_Hook` is a punch; it is only called melee because it shipped in the
 * pack where UAL1's jabs and crosses did not, and "melee" would be wrong anyway
 * since sword work is melee too.
 *
 * The rest are emotes — expressive gestures a player performs at somebody,
 * carrying no mechanics. Prefixing them puts the four in one family instead of
 * scattering them as single-clip categories, and the prefix does that by being
 * the name rather than by being aliased into place.
 *
 * Each new name says what the body does, checked with `tools/what-moves.mjs`
 * against what the clip actually drives rather than the name it arrived with:
 *
 *   Interact      the left index finger extends and the arm rises   -> a point
 *   Yes           the left thumb curls up over a raised forearm     -> a thumbs up
 *   Dance_Loop    calves, thighs and feet lead                      -> footwork
 *   Idle_No_Loop  head travels 143 degrees while never getting more
 *                 than 19 from where it started                     -> a shake
 *
 * That last one is why it is `HeadShake` and not `No`. `Emote_No_Loop` reads as
 * "an emote that does not loop", which is the opposite of true, and describes a
 * meaning rather than a movement — the same failure as calling a clip Interact.
 *
 * A rename that matches nothing is reported, not ignored — an entry here that
 * silently applies to no clip is a typo that looks like a working config.
 */
const CLIP_RENAMES = {
  Melee_Hook: 'Punch_Hook',
  Melee_Hook_Rec: 'Punch_Hook_Rec',
  Interact: 'Emote_Point',
  Yes: 'Emote_ThumbsUp',
  Dance_Loop: 'Emote_Dance_Loop',
  Idle_No_Loop: 'Emote_HeadShake_Loop',
};

/**
 * Clips this game will never use, dropped from the binary.
 *
 * A firearms vocabulary and a driving pose are not near-misses for a fantasy
 * game — no amount of reinterpretation turns a pistol reload into a spell. They
 * are removed rather than merely left unbound so they stop costing bytes and
 * stop appearing in every audition list.
 *
 * Everything else is kept, including the ones that look wrong at a glance. A
 * zombie walk is a cursed gait, a zombie scratch is a claw, and judging a clip
 * by its name is what this whole pipeline exists to stop.
 */
const CLIP_DROPS = ['Pistol_', 'Driving_'];

// --- GLB container ------------------------------------------------------

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function readGlb(buffer) {
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB');
  let offset = 12;
  let document = null;
  let bin = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON) document = JSON.parse(data.toString('utf8'));
    else if (type === CHUNK_BIN) bin = data;
    offset += 8 + length;
  }
  if (!document) throw new Error('GLB has no JSON chunk');
  return { document, bin };
}

function writeGlb(document, bin) {
  let json = Buffer.from(JSON.stringify(document), 'utf8');
  const jsonPad = (4 - (json.length % 4)) % 4;
  if (jsonPad) json = Buffer.concat([json, Buffer.alloc(jsonPad, 0x20)]);

  let body = bin;
  const binPad = (4 - (body.length % 4)) % 4;
  if (binPad) body = Buffer.concat([body, Buffer.alloc(binPad, 0)]);

  const total = 12 + 8 + json.length + (body.length ? 8 + body.length : 0);
  const out = Buffer.alloc(total);
  let at = 0;
  const u32 = value => {
    out.writeUInt32LE(value, at);
    at += 4;
  };
  u32(GLB_MAGIC);
  u32(2);
  u32(total);
  u32(json.length);
  u32(CHUNK_JSON);
  json.copy(out, at);
  at += json.length;
  if (body.length) {
    u32(body.length);
    u32(CHUNK_BIN);
    body.copy(out, at);
  }
  return out;
}

// --- edits --------------------------------------------------------------

function renameClips(document, renames) {
  const applied = [];
  for (const animation of document.animations ?? []) {
    const renamed = renames[animation.name];
    if (!renamed) continue;
    applied.push([animation.name, renamed]);
    animation.name = renamed;
  }
  return applied;
}

/**
 * Remove clips AND the keyframe data behind them.
 *
 * Deleting the `animations` entry alone changes nothing about file size: the
 * samplers' accessors still point into the buffer, and the buffer is still
 * whole. (That exact mistake once produced "one clip" files the size of the
 * entire library — see tools/animation-extract/README.md.) So the buffer is
 * rebuilt from the views that survive, and every accessor and bufferView index
 * in the document is remapped to match.
 *
 * Shapes we cannot rewrite correctly are refused loudly rather than silently
 * mangled. Better a staging step that stops than a GLB that loads with subtly
 * wrong geometry.
 */
function dropClips(document, bin, prefixes) {
  const all = document.animations ?? [];
  const doomed = all.filter(animation =>
    prefixes.some(prefix => (animation.name ?? '').startsWith(prefix)),
  );
  if (doomed.length === 0) return { bin, dropped: [] };

  if ((document.buffers ?? []).length > 1) throw new Error('multi-buffer glTF is not handled');
  for (const accessor of document.accessors ?? []) {
    if (accessor.sparse) throw new Error('sparse accessors are not handled');
  }
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.targets) throw new Error('morph targets are not handled');
    }
  }

  const removed = new Set(doomed);
  document.animations = all.filter(animation => !removed.has(animation));

  // Everything still pointing at an accessor.
  const keepAccessor = new Set();
  for (const animation of document.animations) {
    for (const sampler of animation.samplers) {
      keepAccessor.add(sampler.input);
      keepAccessor.add(sampler.output);
    }
  }
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      for (const index of Object.values(primitive.attributes ?? {})) keepAccessor.add(index);
      if (primitive.indices !== undefined) keepAccessor.add(primitive.indices);
    }
  }
  for (const skin of document.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined) keepAccessor.add(skin.inverseBindMatrices);
  }

  // Views behind those accessors, plus any holding an embedded image — those
  // are referenced directly and would otherwise vanish with their textures.
  const keepView = new Set();
  for (const index of keepAccessor) {
    const view = document.accessors[index].bufferView;
    if (view !== undefined) keepView.add(view);
  }
  for (const image of document.images ?? []) {
    if (image.bufferView !== undefined) keepView.add(image.bufferView);
  }

  const viewMap = new Map();
  const bufferViews = [];
  const pieces = [];
  let offset = 0;
  for (const oldIndex of [...keepView].sort((a, b) => a - b)) {
    const view = document.bufferViews[oldIndex];
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      pieces.push(Buffer.alloc(pad));
      offset += pad;
    }
    const start = view.byteOffset ?? 0;
    pieces.push(bin.subarray(start, start + view.byteLength));
    viewMap.set(oldIndex, bufferViews.length);
    bufferViews.push({ ...view, byteOffset: offset });
    offset += view.byteLength;
  }

  const accessorMap = new Map();
  const accessors = [...keepAccessor]
    .sort((a, b) => a - b)
    .map((oldIndex, newIndex) => {
      accessorMap.set(oldIndex, newIndex);
      const accessor = { ...document.accessors[oldIndex] };
      if (accessor.bufferView !== undefined) accessor.bufferView = viewMap.get(accessor.bufferView);
      return accessor;
    });

  for (const animation of document.animations) {
    for (const sampler of animation.samplers) {
      sampler.input = accessorMap.get(sampler.input);
      sampler.output = accessorMap.get(sampler.output);
    }
  }
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      for (const [name, index] of Object.entries(primitive.attributes ?? {})) {
        primitive.attributes[name] = accessorMap.get(index);
      }
      if (primitive.indices !== undefined) primitive.indices = accessorMap.get(primitive.indices);
    }
  }
  for (const skin of document.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined) {
      skin.inverseBindMatrices = accessorMap.get(skin.inverseBindMatrices);
    }
  }
  for (const image of document.images ?? []) {
    if (image.bufferView !== undefined) image.bufferView = viewMap.get(image.bufferView);
  }

  document.accessors = accessors;
  document.bufferViews = bufferViews;
  const body = Buffer.concat(pieces);
  document.buffers = [{ byteLength: body.length }];

  return { bin: body, dropped: doomed.map(animation => animation.name) };
}

// --- run ----------------------------------------------------------------

function sourceRoot() {
  const flag = process.argv.indexOf('--source');
  if (flag !== -1 && process.argv[flag + 1]) return resolve(process.argv[flag + 1]);
  if (process.env.QUATERNIUS_ROOT) return resolve(process.env.QUATERNIUS_ROOT);
  return null;
}

function findFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findFiles(full, out);
    else if (entry.name.toLowerCase().endsWith('.glb')) out.push(full);
  }
  return out;
}

const root = sourceRoot();
if (!root || !existsSync(root)) {
  console.error(
    '\nNo asset source given.\n\n'
      + '  node tools/stage-dev-assets.mjs --source <path to unpacked Quaternius packs>\n'
      + '  QUATERNIUS_ROOT=<path> node tools/stage-dev-assets.mjs\n\n'
      + 'The sandbox runs without this — it shows whatever else is bound.\n',
  );
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const available = findFiles(root);
const staged = [];
const missing = [];
const renamed = [];
const dropped = [];

for (const want of WANTED) {
  const hit = available.find(path => basename(path) === want.match);
  if (!hit) {
    missing.push(want.match);
    continue;
  }
  const dest = join(OUT_DIR, want.as);

  if (want.kind === 'library') {
    const source = readFileSync(hit);
    const { document, bin } = readGlb(source);
    const cut = dropClips(document, bin, CLIP_DROPS);
    for (const name of cut.dropped) dropped.push([want.as, name]);
    for (const [from, to] of renameClips(document, CLIP_RENAMES)) {
      renamed.push([want.as, from, to]);
    }
    writeFileSync(dest, writeGlb(document, cut.bin));
    staged.push({ ...want, bytes: statSync(dest).size, was: source.length, clips: (document.animations ?? []).length });
  } else {
    copyFileSync(hit, dest);
    staged.push({ ...want, bytes: statSync(dest).size, was: statSync(hit).size, clips: null });
  }
}

writeFileSync(
  join(OUT_DIR, 'index.json'),
  `${JSON.stringify(
    {
      libraries: staged.filter(s => s.kind === 'library').map(({ as, label }) => ({ file: as, label })),
      bodies: staged.filter(s => s.kind === 'body').map(({ as, label }) => ({ file: as, label })),
    },
    null,
    2,
  )}\n`,
);

const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log('\nStaged into client/public/anim-lib/ (gitignored):\n');
for (const s of staged) {
  const saved = s.was > s.bytes ? `  (was ${mb(s.was)})` : '';
  const clips = s.clips === null ? '' : `  ${s.clips} clips`;
  console.log(`  ${s.as.padEnd(18)} ${mb(s.bytes).padStart(9)}${clips.padEnd(11)}${saved}`);
}

if (dropped.length) {
  console.log(`\nDropped ${dropped.length} clips:`);
  for (const [file, name] of dropped) console.log(`  ${file.padEnd(10)} ${name}`);
}

if (renamed.length) {
  console.log('\nRenamed in place:');
  for (const [file, from, to] of renamed) console.log(`  ${file.padEnd(10)} ${from} -> ${to}`);
}

// A rule that matched nothing is a typo wearing a working config's clothes.
const landedRenames = new Set(renamed.map(([, from]) => from));
const inertRenames = Object.keys(CLIP_RENAMES).filter(from => !landedRenames.has(from));
if (inertRenames.length) {
  console.log(`\n  WARNING: ${inertRenames.length} rename(s) matched no clip: ${inertRenames.join(', ')}`);
}
const inertDrops = CLIP_DROPS.filter(prefix => !dropped.some(([, name]) => name.startsWith(prefix)));
if (inertDrops.length) {
  console.log(`  WARNING: ${inertDrops.length} drop rule(s) matched no clip: ${inertDrops.join(', ')}`);
}

if (missing.length) {
  console.log(`\n  not found under ${root}:`);
  for (const m of missing) console.log(`    ${m}`);
}
console.log('');
