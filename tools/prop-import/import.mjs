/**
 * Import props from an upstream kit into ONE GLB the seam picks from by name.
 *
 * One file, not ninety-four, because the kit's textures are trim sheets shared
 * across every prop in it. A per-prop file would embed the same 2 MB sheet in
 * each one; a combined file embeds it once and every prop that uses it comes
 * along nearly free. `resolveProp` already supports this — it takes an
 * `objectName` and pulls that node out of a loaded asset.
 *
 * ## The authoring frame
 *
 * `content/sockets.ts` expects a held prop with its origin AT THE GRIP, +Y
 * toward the business end, +Z out the front face. Kits do not author that way;
 * they author with the origin wherever the artist left it, usually the base.
 * So each held prop carries a `grip` — the point, in the source mesh's own
 * coordinates, where the fist closes — and the importer moves the mesh so that
 * point lands on the origin.
 *
 * Those numbers are MEASURED, not guessed. Slice the mesh along its long axis
 * and the parts announce themselves: a sword's handle is the narrow stretch
 * between the pommel and the flare of the crossguard, an axe's haft is the
 * narrow stretch below where the head widens. See the tools in this repo's
 * history, or measure again — the point is that nobody eyeballs it.
 *
 * The correction lands on an inner node, never on the named one: `applyGrip`
 * sets position and rotation on whatever `resolveProp` hands back, so a
 * correction stored there would be overwritten the first time a prop is held.
 *
 * ## Textures
 *
 * Normal and ORM maps are dropped, base colour kept. The normals are the
 * largest files in the kit by some margin and contribute least to a flat-shaded
 * low-poly look at gameplay distance. This is reversible in one line, and is
 * not the real optimisation — that is downscaling the 4K sheets, deliberately
 * left until there is something to judge the result against.
 *
 *   npm install && node import.mjs --source <unpacked Fantasy Props>
 */

import { Document, NodeIO } from '@gltf-transform/core';
import { dedup, mergeDocuments, prune } from '@gltf-transform/functions';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', '..', 'client', 'public', 'props', 'fantasy.glb');

/**
 * `grip` is where the fist closes, in the SOURCE mesh's coordinates. The
 * importer subtracts it, so the exported prop has its origin there.
 *
 * Scene props take no grip: the kit already puts their origin at the base,
 * which is exactly where you want it for something standing on the ground.
 */
const HELD = [
  // Handle runs -0.17..+0.03 between pommel and crossguard; centre ~ -0.07.
  { key: 'sword', file: 'Sword_Bronze', grip: [0, -0.07, 0] },
  // Grip bar sits across the back of the boss, Z -0.001..0.044; centre ~0.022.
  { key: 'shield', file: 'Shield_Wooden', grip: [0, 0, 0.022] },
  // Haft is the narrow stretch -0.38..+0.20; the head flares above it. A
  // one-handed hold sits low on the haft.
  { key: 'axe', file: 'Axe_Bronze', grip: [0, -0.25, 0] },
  // Small vessels are authored standing on their base, so the grip is up the
  // body rather than at the origin.
  { key: 'potion', file: 'Potion_2', grip: [0, 0.1, 0] },
  { key: 'mug', file: 'Mug', grip: [0, 0.07, 0] },
  // The kit has no handheld torch or lantern — both are wall fittings. A
  // chamberstick is the closest thing you can actually carry.
  { key: 'candlestick', file: 'CandleStick', grip: [0, 0.06, 0] },
];

const SCENERY = [
  'Dummy', 'Anvil', 'Anvil_Log', 'Whetstone', 'Workbench', 'WeaponStand',
  'Barrel', 'Crate_Wooden', 'Chest_Wood', 'FarmCrate_Carrot',
  'Table_Large', 'Bench', 'Stool', 'Bookcase_2', 'Cauldron', 'Pot_1',
  'Torch_Metal', 'Lantern_Wall', 'CandleStick_Triple', 'Candle_1',
  'Peg_Rack', 'Rope_1', 'Bag',
];

/** `Crate_Wooden` -> `crate_wooden`, so keys read like the rest of the seam. */
const keyFor = file => file.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

function sourceRoot() {
  const flag = process.argv.indexOf('--source');
  if (flag !== -1 && process.argv[flag + 1]) return resolve(process.argv[flag + 1]);
  if (process.env.FANTASY_PROPS_ROOT) return resolve(process.env.FANTASY_PROPS_ROOT);
  return null;
}

const root = sourceRoot();
if (!root || !existsSync(root)) {
  console.error(
    '\n  node import.mjs --source <path to Fantasy Props Exports/glTF>\n'
      + '  FANTASY_PROPS_ROOT=<path> node import.mjs\n',
  );
  process.exit(1);
}

const io = new NodeIO();
const target = new Document();
const scene = target.createScene('props');

const imported = [];
const missing = [];

async function add(file, key, grip) {
  const path = join(root, `${file}.gltf`);
  if (!existsSync(path)) {
    missing.push(file);
    return;
  }

  const source = await io.read(path);
  const before = new Set(target.getRoot().listScenes());
  mergeDocuments(target, source);
  const merged = target.getRoot().listScenes().find(candidate => !before.has(candidate));

  // Underscore, not dot. three.js `GLTFLoader` runs node names through
  // `PropertyBinding.sanitizeNodeName`, which replaces dots — so a node called
  // `prop.sword` arrives in the scene as `prop_sword` and a lookup by the
  // content key finds nothing, with every individual piece looking correct.
  //
  // The named node must also keep a free transform: `applyGrip` writes position
  // and rotation onto whatever `resolveProp` returns, so any correction stored
  // here would be overwritten the first time the prop is held. It goes on the
  // child instead.
  const named = target.createNode(`prop_${key}`);
  const authored = target.createNode(`${key}__authored`);
  if (grip) authored.setTranslation([-grip[0], -grip[1], -grip[2]]);

  for (const child of merged?.listChildren() ?? []) {
    merged.removeChild(child);
    authored.addChild(child);
  }
  merged?.dispose();

  named.addChild(authored);
  scene.addChild(named);
  imported.push({ key, file, held: Boolean(grip) });
}

for (const entry of HELD) await add(entry.file, entry.key, entry.grip);
for (const file of SCENERY) await add(file, keyFor(file), null);

// Keep base colour; drop the maps that cost the most and show the least here.
let stripped = 0;
for (const material of target.getRoot().listMaterials()) {
  for (const drop of ['NormalTexture', 'OcclusionTexture', 'MetallicRoughnessTexture']) {
    if (material[`get${drop}`]()) {
      material[`set${drop}`](null);
      stripped += 1;
    }
  }
}

// Every merged document arrives with its own buffer, and a GLB may only have
// one. Point every accessor at the first and drop the rest.
const buffers = target.getRoot().listBuffers();
const buffer = buffers[0] ?? target.createBuffer();
for (const accessor of target.getRoot().listAccessors()) accessor.setBuffer(buffer);
for (const spare of buffers.slice(1)) spare.dispose();

await target.transform(dedup(), prune());

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, await io.writeBinary(target));

const kb = bytes => `${(bytes / 1024).toFixed(0)} KB`;
console.log(`\n  ${imported.length} props -> ${OUT.replace(/.*client/, 'client')}  ${kb(statSync(OUT).size)}\n`);
console.log(`  held:    ${imported.filter(p => p.held).map(p => p.key).join(', ')}`);
console.log(`  scenery: ${imported.filter(p => !p.held).map(p => p.key).join(', ')}`);
console.log(`\n  ${stripped} normal/ORM maps dropped, ${target.getRoot().listTextures().length} textures kept`);
if (missing.length) console.log(`\n  NOT FOUND: ${missing.join(', ')}`);
console.log('');
