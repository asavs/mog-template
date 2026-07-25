/**
 * Put the upstream animation libraries where the sandbox can load them.
 *
 * The sandbox auditions EVERY clip in both Quaternius libraries — that is its
 * whole job, and it is how the binding table gets decided instead of guessed.
 * But the libraries are ~15 MB of clips we mostly will not ship, so committing
 * them would put permanent weight in the repo to serve a dev tool.
 *
 * So they are staged instead: copied into a gitignored folder under `public/`,
 * served as plain URLs, and absent on a fresh clone until someone runs this.
 * The sandbox degrades to procedural-only when they are missing, which is a
 * legitimate state rather than a broken one.
 *
 *   node tools/stage-dev-assets.mjs --source "C:/Users/you/Assets/quaternius"
 *   QUATERNIUS_ROOT=/path/to/packs node tools/stage-dev-assets.mjs
 *
 * The packs are free from quaternius.com; see docs for which ones.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
    '\nNo asset source given.\n\n' +
      '  node tools/stage-dev-assets.mjs --source <path to unpacked Quaternius packs>\n' +
      '  QUATERNIUS_ROOT=<path> node tools/stage-dev-assets.mjs\n\n' +
      'The sandbox runs without this — it falls back to procedural motion only.\n',
  );
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const available = findFiles(root);
const staged = [];
const missing = [];

for (const want of WANTED) {
  const hit = available.find(path => basename(path) === want.match);
  if (!hit) {
    missing.push(want.match);
    continue;
  }
  const dest = join(OUT_DIR, want.as);
  copyFileSync(hit, dest);
  staged.push({ ...want, bytes: statSync(dest).size });
}

// An index so the client discovers what is staged instead of hard-coding names.
// Nothing above the seam should have to know a pack's filename.
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
console.log(`\nStaged into client/public/anim-lib/ (gitignored):\n`);
for (const s of staged) console.log(`  ${s.as.padEnd(18)} ${mb(s.bytes).padStart(9)}  ${s.label}`);
if (missing.length) {
  console.log(`\n  not found under ${root}:`);
  for (const m of missing) console.log(`    ${m}`);
}
console.log('');
