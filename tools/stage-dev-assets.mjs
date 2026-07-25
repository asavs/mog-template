/**
 * Vendor the upstream animation libraries into something we own.
 *
 * Two jobs, and they are the same job. The packs are copied into a gitignored
 * folder under `public/` so the sandbox can audition every clip in them without
 * ~15 MB of mostly-unshipped animation living in the repo. And while copying,
 * clips whose names describe the wrong thing are RENAMED — in the file, not in
 * a lookup table.
 *
 * That distinction is the whole point. A clip's name is the key everything
 * resolves by: the extractor finds it with `getName() === clipName`, the
 * catalog reads it out of `gltf.animations[]`, the binding table stores it. A
 * nicer name that exists only in our UI is a translation layer, and every
 * translation layer on this branch has turned out to be a bug waiting for the
 * combination nobody tested. So the rename happens once, here, at the boundary
 * where their files become our files, and downstream there is only one name.
 *
 *   node tools/stage-dev-assets.mjs --source "C:/Users/you/Assets/quaternius"
 *   QUATERNIUS_ROOT=/path/to/packs node tools/stage-dev-assets.mjs
 *
 * The packs are free from quaternius.com. The originals are never modified.
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
 * carrying no mechanics. `Interact` is a person pointing. `Yes` is a thumbs up.
 * `Idle_No_Loop` is a head shake, which is only filed under idle because it
 * happens to loop. Prefixing them puts the four in one family instead of
 * scattering them as single-clip categories, and the prefix does that by being
 * the name rather than by being aliased into place.
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
  Idle_No_Loop: 'Emote_No_Loop',
};

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

/**
 * Rewrite animation names inside a GLB.
 *
 * A GLB is a 12-byte header (magic, version, total length) followed by chunks,
 * each an 8-byte header then data. The first chunk is the glTF JSON, padded to
 * a 4-byte boundary with spaces; the rest is binary, padded with zeroes. Only
 * the JSON changes here, so the binary chunk is carried through untouched and
 * two lengths are rewritten.
 */
function renameClips(buffer, renames) {
  const jsonLength = buffer.readUInt32LE(12);
  const jsonType = buffer.readUInt32LE(16);
  const document = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  const trailing = buffer.subarray(20 + jsonLength);

  const applied = [];
  for (const animation of document.animations ?? []) {
    const renamed = renames[animation.name];
    if (!renamed) continue;
    applied.push([animation.name, renamed]);
    animation.name = renamed;
  }
  if (applied.length === 0) return { buffer, applied };

  let json = Buffer.from(JSON.stringify(document), 'utf8');
  const padding = (4 - (json.length % 4)) % 4;
  if (padding) json = Buffer.concat([json, Buffer.alloc(padding, 0x20)]);

  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + trailing.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(jsonType, 16);

  return { buffer: Buffer.concat([header, json, trailing]), applied };
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

for (const want of WANTED) {
  const hit = available.find(path => basename(path) === want.match);
  if (!hit) {
    missing.push(want.match);
    continue;
  }
  const dest = join(OUT_DIR, want.as);

  if (want.kind === 'library') {
    const result = renameClips(readFileSync(hit), CLIP_RENAMES);
    writeFileSync(dest, result.buffer);
    for (const [from, to] of result.applied) renamed.push([want.as, from, to]);
  } else {
    copyFileSync(hit, dest);
  }

  staged.push({ ...want, bytes: statSync(dest).size });
}

// An index so the client discovers what is staged instead of hard-coding names.
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
for (const s of staged) console.log(`  ${s.as.padEnd(18)} ${mb(s.bytes).padStart(9)}  ${s.label}`);

if (renamed.length) {
  console.log('\nRenamed in place:');
  for (const [file, from, to] of renamed) console.log(`  ${file.padEnd(10)} ${from} -> ${to}`);
}

// A rename that matched nothing is a typo wearing a working config's clothes.
const landed = new Set(renamed.map(([, from]) => from));
const inert = Object.keys(CLIP_RENAMES).filter(from => !landed.has(from));
if (inert.length) {
  console.log(`\n  WARNING: ${inert.length} rename(s) matched no clip: ${inert.join(', ')}`);
}

if (missing.length) {
  console.log(`\n  not found under ${root}:`);
  for (const m of missing) console.log(`    ${m}`);
}
console.log('');
