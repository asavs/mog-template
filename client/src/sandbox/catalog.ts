/**
 * Everything the sandbox can play, from every source, in one flat list.
 *
 * The old sandbox could only show you clips someone had already chosen: its
 * dropdowns were built from the motion-key vocabulary, so the eighty-odd clips
 * nobody had bound yet were invisible. That makes "which of these do we
 * actually need?" an unanswerable question, and it is why clips kept getting
 * picked by name — a name was the only evidence available.
 *
 * So the catalog reads the LIBRARIES, not the vocabulary. Every clip in every
 * staged pack shows up whether or not it is spoken for, next to the procedural
 * placeholders it might replace, and binding becomes an output of watching
 * rather than an input to it.
 *
 * Procedural entries are always present, even with no packs staged at all.
 * They are the floor: neither library ships a strafe, so `loco_walk_l` and its
 * siblings are procedural permanently or the character moonwalks.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ALL_MOTION_KEYS, bindingFor, proceduralMotion } from '../content';
import clipBindings from '../content/clipBindings.json';

export type ClipOrigin = 'library' | 'procedural';

export type CatalogEntry = {
  /** Stable and unique across libraries — both packs ship an `A_TPose`. */
  id: string;
  name: string;
  /** Leading token of the name, for grouping: `Sword_Attack` -> `Sword`. */
  family: string;
  origin: ClipOrigin;
  /** Library id (`ual1`), or null for procedural. */
  library: string | null;
  duration: number;
  clip: THREE.AnimationClip;
  /** The motion key this clip serves, if any. */
  motionKey: string | null;
  /** Whether this is what the game plays for that key TODAY. */
  active: boolean;
};

export type LibraryStatus = {
  id: string;
  label: string;
  file: string;
  state: 'loaded' | 'error';
  clipCount: number;
  detail?: string;
};

export type Catalog = {
  entries: readonly CatalogEntry[];
  libraries: readonly LibraryStatus[];
  /** False when no pack is staged — a legitimate state, not a broken one. */
  staged: boolean;
};

const BASE = import.meta.env.BASE_URL || '/';
const assetUrl = (path: string) => `${BASE.replace(/\/+$/, '')}/${path}`;

/** `ual1/Idle_Loop` -> `motion.loco_idle`, so a clip knows what it backs. */
const KEY_BY_CLIP = new Map<string, string>(
  Object.entries(clipBindings.bindings).map(([key, binding]) => [
    `${binding.library}/${binding.clip}`,
    key,
  ]),
);

/**
 * What we call a family, where the packs called it something unhelpful.
 *
 * Two different problems, one fix. The packs disagree with EACH OTHER — UAL1
 * files its jabs and crosses under `Punch_*` while UAL2 files its hooks under
 * `Melee_*`, so the same gesture vocabulary lands in two groups and you never
 * notice you are choosing between five clips rather than two and three.
 *
 * And some names describe nothing. `Interact` is a person pointing at
 * something; `Yes` is a thumbs up. Both are named for the intent an animator
 * imagined rather than the gesture the body performs, which is the same reason
 * our own motion ids are forbidden from naming spells or classes.
 *
 * This renames the GROUP only. Each clip still shows its true upstream name,
 * because that is the string `clipBindings.json` and the extractor look it up
 * by — a friendly label that hides the real id would reintroduce exactly the
 * confusion it is meant to clear up.
 */
const FAMILY_ALIASES: Record<string, string> = {
  Punch: 'Melee',
  Interact: 'Point',
  Yes: 'ThumbsUp',
};

const familyOf = (name: string) => {
  const head = name.split(/[_\s]/)[0] || name;
  return FAMILY_ALIASES[head] ?? head;
};

type IndexEntry = { file: string; label: string };

/**
 * What has been staged, if anything. A missing index is the normal state on a
 * fresh clone — `tools/stage-dev-assets.mjs` has simply not been run — so it
 * resolves to "no libraries" rather than throwing.
 */
async function loadLibraryIndex(): Promise<IndexEntry[]> {
  try {
    const response = await fetch(assetUrl('anim-lib/index.json'));
    if (!response.ok) return [];
    const data: unknown = await response.json();
    const libraries = (data as { libraries?: unknown }).libraries;
    return Array.isArray(libraries) ? (libraries as IndexEntry[]) : [];
  } catch {
    return [];
  }
}

function proceduralEntries(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const key of ALL_MOTION_KEYS) {
    const clip = proceduralMotion(key);
    if (!clip) continue;
    const id = key.replace(/^motion\./, '');
    entries.push({
      id: `procedural/${id}`,
      name: id,
      family: id.split('_')[0],
      origin: 'procedural',
      library: null,
      duration: clip.duration,
      clip,
      motionKey: key,
      // Procedural wins only where nothing has replaced it.
      active: bindingFor(key).origin === 'procedural',
    });
  }
  return entries;
}

export async function buildCatalog(): Promise<Catalog> {
  const index = await loadLibraryIndex();
  const loader = new GLTFLoader();

  const libraries: LibraryStatus[] = [];
  const libraryEntries: CatalogEntry[] = [];

  await Promise.all(
    index.map(async ({ file, label }) => {
      const id = file.replace(/\.glb$/i, '');
      try {
        // Packs carry a mannequin as well as the clips; the body comes from the
        // content seam, so only the animations are taken.
        const gltf = await loader.loadAsync(assetUrl(`anim-lib/${file}`));
        for (const clip of gltf.animations) {
          const motionKey = KEY_BY_CLIP.get(`${id}/${clip.name}`) ?? null;
          libraryEntries.push({
            id: `${id}/${clip.name}`,
            name: clip.name,
            family: familyOf(clip.name),
            origin: 'library',
            library: id,
            duration: clip.duration,
            clip,
            motionKey,
            // Bound in the table AND actually carved into dropin/ — a table row
            // on its own moves nothing.
            active: motionKey ? bindingFor(motionKey).origin === 'dropin' : false,
          });
        }
        libraries.push({ id, label, file, state: 'loaded', clipCount: gltf.animations.length });
      } catch (error) {
        libraries.push({
          id,
          label,
          file,
          state: 'error',
          clipCount: 0,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  libraryEntries.sort((a, b) => a.id.localeCompare(b.id));
  libraries.sort((a, b) => a.id.localeCompare(b.id));

  return {
    entries: [...libraryEntries, ...proceduralEntries()],
    libraries,
    staged: libraries.some(library => library.state === 'loaded'),
  };
}
