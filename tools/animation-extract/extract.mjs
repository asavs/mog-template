/**
 * Carve the clips we actually bind out of the Quaternius libraries.
 *
 * One GLB per motion key, named after the key, so installing them is a file
 * copy into dropin/ and nothing else. The alternative — one shared library plus
 * manifest pins — saves a little size but trades the drag-and-drop story for
 * config, and the skeleton hierarchy is only JSON.
 *
 * Each output keeps the skeleton and exactly one clip, renamed to our motion id.
 * The mannequin mesh is stripped from motion files: they animate whatever body
 * is present, they are not a body.
 */

import { NodeIO } from '@gltf-transform/core';
import { prune, dedup } from '@gltf-transform/functions';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [UAL1, UAL2, OUT] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

/**
 * The binding table is NOT kept here.
 *
 * It is decided in the animation sandbox, by watching clips play on the actual
 * body — which is the only way to know that `OverhandThrow` is a throw and that
 * `Idle_Torch_Loop` is a torch. A table maintained next to the extractor is a
 * table maintained by whoever last read the clip names, and clip names lie.
 *
 * So the sandbox owns it and this tool consumes it. One file, one decision
 * point, and the thing that carved the GLBs cannot drift from the thing that
 * chose them.
 */
const TABLE_PATH = fileURLToPath(
  new URL('../../client/src/content/clipBindings.json', import.meta.url),
);
const table = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));

const LIBRARY_PATHS = { ual1: UAL1, ual2: UAL2 };

const BINDINGS = {};
for (const [key, { library, clip }] of Object.entries(table.bindings)) {
  const path = LIBRARY_PATHS[library];
  if (!path) {
    console.error(`  SKIP     ${key}: no path given for library "${library}"`);
    continue;
  }
  BINDINGS[key] = [path, clip];
}

const io = new NodeIO();
const cache = new Map();
async function source(path) {
  if (!cache.has(path)) cache.set(path, await io.read(path));
  return cache.get(path);
}

const motionId = key => key.replace(/^motion\./, '');
const kb = bytes => `${(bytes / 1024).toFixed(0)} KB`;

const rows = [];

for (const [key, [libPath, clipName]] of Object.entries(BINDINGS)) {
  // Re-read per output: disposing animations mutates the document.
  const doc = await io.read(libPath);
  const root = doc.getRoot();

  const animations = root.listAnimations();
  const wanted = animations.find(a => a.getName() === clipName);
  if (!wanted) {
    console.error(`  MISSING  ${clipName} not in ${libPath}`);
    continue;
  }
  // Disposing an Animation orphans its channels and samplers but does not
  // release the accessors they hold, so the keyframe data stays in the buffer
  // and every "one clip" file comes out the size of the whole library.
  for (const anim of animations) {
    if (anim === wanted) continue;
    for (const channel of anim.listChannels()) channel.dispose();
    for (const sampler of anim.listSamplers()) sampler.dispose();
    anim.dispose();
  }
  wanted.setName(motionId(key));

  // A motion file is not a body. Drop the mannequin; the skeleton nodes stay
  // because the animation channels target them.
  for (const mesh of root.listMeshes()) mesh.dispose();
  for (const skin of root.listSkins()) skin.dispose();
  await doc.transform(dedup(), prune());

  const out = join(OUT, `${key}.glb`);
  writeFileSync(out, await io.writeBinary(doc));
  rows.push([key, clipName, statSync(out).size]);
}

// The body: mesh and skeleton, no animation at all.
{
  const doc = await io.read(UAL1);
  for (const anim of doc.getRoot().listAnimations()) {
    for (const channel of anim.listChannels()) channel.dispose();
    for (const sampler of anim.listSamplers()) sampler.dispose();
    anim.dispose();
  }
  await doc.transform(dedup(), prune());
  const out = join(OUT, 'body.humanoid.glb');
  writeFileSync(out, await io.writeBinary(doc));
  rows.push(['body.humanoid', '(mesh + skeleton)', statSync(out).size]);
}

let total = 0;
console.log('\nkey                              source clip              size');
console.log('-'.repeat(72));
for (const [key, clip, size] of rows) {
  total += size;
  console.log(`${key.padEnd(32)} ${clip.padEnd(24)} ${kb(size).padStart(8)}`);
}
console.log('-'.repeat(72));
console.log(`${String(rows.length).padStart(2)} files`.padEnd(57) + kb(total).padStart(8));
