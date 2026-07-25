/**
 * What does this clip actually move?
 *
 * Animation packs name clips for what an animator had in mind, not for what the
 * body does. This branch has been bitten by that repeatedly: a clip called
 * `Interact` is a person pointing, `Yes` is a thumbs up, `Idle_No_Loop` is a
 * head shake filed under idle because it happens to repeat, and `act_hurl_1h`
 * was once bound to something that was not a hurl at all.
 *
 * Watching a clip in the sandbox is the real answer and always will be. This is
 * the cheap answer, for when you have eighty-six of them and need to know which
 * ones are worth opening: rank every bone by how far it travels, and the gesture
 * usually names itself.
 *
 * The two numbers matter separately.
 *
 *   swing   how far the bone ever gets from where it started
 *   travel  how far it moves in total, adding up every step
 *
 * A reach has both. A shake has large travel and small swing — it goes a long
 * way and ends up back home. That distinction is what identified the head shake
 * as a shake rather than a refusal, without anyone guessing.
 *
 *   node tools/what-moves.mjs                     list every staged clip
 *   node tools/what-moves.mjs Sword_Attack        rank its bones
 *   node tools/what-moves.mjs Punch --file x.glb  inspect any GLB
 *
 * Reads the staged libraries by default; run `npm run assets:stage` first.
 * Dependency-free on purpose — this should work in a fresh clone.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STAGED_DIR = fileURLToPath(new URL('../client/public/anim-lib/', import.meta.url));

const args = process.argv.slice(2);
const fileFlag = args.indexOf('--file');
const explicitFile = fileFlag !== -1 ? args[fileFlag + 1] : null;
// `fileFlag` is -1 when absent, so guard it: `i !== fileFlag + 1` would
// otherwise skip index 0, which is the query, and fall through to listing
// everything while looking like it worked.
const query =
  args.filter((arg, i) => !arg.startsWith('--') && !(fileFlag !== -1 && i === fileFlag + 1))[0]
  ?? null;

/** Parse a GLB into its JSON document and binary chunk. */
function readGlb(path) {
  const buffer = readFileSync(path);
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error(`${basename(path)} is not a GLB`);

  let offset = 12;
  let document = null;
  let bin = null;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) document = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    offset += 8 + length;
  }
  if (!document) throw new Error(`${basename(path)} has no JSON chunk`);
  return { document, bin };
}

function sources() {
  if (explicitFile) return [explicitFile];
  if (!existsSync(STAGED_DIR)) return [];
  return readdirSync(STAGED_DIR)
    .filter(name => name.toLowerCase().endsWith('.glb'))
    .map(name => join(STAGED_DIR, name));
}

const files = sources();
if (files.length === 0) {
  console.error(
    '\n  Nothing staged. Run:\n'
      + '    cd client && npm run assets:stage -- --source <packs>\n'
      + '  or point at a file with --file <path.glb>\n',
  );
  process.exit(1);
}

const libraries = files.map(path => ({ path, ...readGlb(path) }));

// --- no query: list what there is ---------------------------------------
if (!query) {
  for (const { path, document } of libraries) {
    const clips = document.animations ?? [];
    if (clips.length === 0) continue;
    console.log(`\n=== ${basename(path)} — ${clips.length} clips ===`);
    const names = clips.map(clip => clip.name ?? '(unnamed)').sort();
    for (let i = 0; i < names.length; i += 3) {
      console.log('  ' + names.slice(i, i + 3).map(n => n.padEnd(26)).join(''));
    }
  }
  console.log('\n  Pass a clip name (or part of one) to rank its bones.\n');
  process.exit(0);
}

// --- find matching clips -------------------------------------------------
const needle = query.toLowerCase();
const matches = [];
for (const library of libraries) {
  for (const clip of library.document.animations ?? []) {
    if ((clip.name ?? '').toLowerCase().includes(needle)) matches.push({ library, clip });
  }
}

if (matches.length === 0) {
  console.error(`\n  No clip matching "${query}". Run with no arguments to list them.\n`);
  process.exit(1);
}

const angleBetween = (a, b) => {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
};

function accessorRows({ document, bin }, index) {
  const accessor = document.accessors[index];
  const view = document.bufferViews[accessor.bufferView];
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[accessor.type] ?? 1;
  const rows = [];
  for (let i = 0; i < accessor.count; i++) {
    const row = [];
    for (let c = 0; c < width; c++) row.push(bin.readFloatLE(base + (i * width + c) * 4));
    rows.push(row);
  }
  return rows;
}

for (const { library, clip } of matches) {
  const { document } = library;
  const rotations = [];
  const translations = [];

  for (const channel of clip.channels) {
    const node = document.nodes[channel.target.node];
    const name = node?.name ?? `node${channel.target.node}`;
    const keys = accessorRows(library, clip.samplers[channel.sampler].output);
    if (keys.length < 2) continue;

    if (channel.target.path === 'rotation') {
      let swing = 0;
      let travel = 0;
      for (let i = 1; i < keys.length; i++) {
        swing = Math.max(swing, angleBetween(keys[0], keys[i]));
        travel += angleBetween(keys[i - 1], keys[i]);
      }
      rotations.push({ name, swing, travel });
    } else if (channel.target.path === 'translation') {
      let travel = 0;
      for (let i = 1; i < keys.length; i++) {
        travel += Math.hypot(
          keys[i][0] - keys[i - 1][0],
          keys[i][1] - keys[i - 1][1],
          keys[i][2] - keys[i - 1][2],
        );
      }
      if (travel > 0.001) translations.push({ name, travel });
    }
  }

  rotations.sort((a, b) => b.travel - a.travel);
  const duration = Math.max(
    0,
    ...clip.samplers.map(sampler => document.accessors[sampler.input]?.max?.[0] ?? 0),
  );

  console.log(
    `\n=== ${clip.name}  (${basename(library.path)}, ${duration.toFixed(2)}s, `
      + `${clip.channels.length} channels) ===\n`,
  );
  console.log('  bone                    swing     travel');
  console.log('  ' + '-'.repeat(48));
  const scale = rotations[0]?.travel || 1;
  for (const row of rotations.slice(0, 12)) {
    const bar = '#'.repeat(Math.max(1, Math.round((row.travel / scale) * 26)));
    console.log(
      `  ${row.name.padEnd(22)} ${row.swing.toFixed(1).padStart(6)}° `
        + `${row.travel.toFixed(1).padStart(8)}°  ${bar}`,
    );
  }
  if (rotations.length > 12) {
    const rest = rotations.slice(12).reduce((sum, row) => sum + row.travel, 0);
    console.log(`  ${`… ${rotations.length - 12} more`.padEnd(22)} ${''.padStart(6)}  ${rest.toFixed(1).padStart(8)}°`);
  }

  // Which NODE translates, named — not "is there root motion", which is a
  // conclusion. A translating pelvis is an ordinary lunge or weight shift; a
  // translating root is movement baked into the clip, which fights a game that
  // moves the character itself. Only the node name tells them apart.
  if (translations.length > 0) {
    translations.sort((a, b) => b.travel - a.travel);
    console.log('\n  translates:');
    for (const row of translations.slice(0, 3)) {
      const rate = duration > 0 ? `  ${(row.travel / duration).toFixed(2)} u/s` : '';
      console.log(`    ${row.name.padEnd(22)} ${row.travel.toFixed(2)} units${rate}`);
    }
    if (translations.some(row => /^(root|armature)$/i.test(row.name))) {
      console.log('    ^ root motion: the clip moves the character, and so does the game');
    }
  }
}

if (matches.length > 1) {
  console.log(`\n  ${matches.length} clips matched "${query}".`);
}
console.log('');
