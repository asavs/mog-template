/**
 * Key -> source bindings, and the rule that decides which source wins.
 *
 * ## Swapping content
 *
 * Drop a file named after the key into `dropin/` and it replaces whatever that
 * key resolved to before — no code change, no rebuild config:
 *
 *     dropin/motion/motion.action.magic_cast.glb   replaces the procedural cast
 *     dropin/prop/prop.staff.glb                   replaces the placeholder stick
 *
 * Delete the file and the previous source returns. This is the whole seam: one
 * naming convention, checked ahead of every other binding.
 *
 * ## Resolution order
 *
 * 1. `dropin/` file whose basename matches the key  (an artist's override wins)
 * 2. an explicit entry in `CONTENT_MANIFEST`        (a deliberate pin)
 * 3. a procedural generator registered under the key
 * 4. nothing — the key is unbound, and callers degrade gracefully
 *
 * Nothing here may name a character class. See `keys.ts`.
 */

import { ALL_MOTION_KEYS, ALL_PROP_KEYS, BODY_KEYS } from './keys';
import { getBodyGenerator, getMotionGenerator, getPropGenerator } from './registry';
import type { ContentBinding, ContentKey, ContentSource } from './types';

/**
 * Files dropped in by an artist. Vite resolves these at build time, so adding a
 * file is picked up on the next dev-server reload.
 */
const DROPIN_MODULES = import.meta.glob('./dropin/**/*.{glb,gltf,fbx}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** `./dropin/motion/motion.action.magic_cast.glb` -> `motion.action.magic_cast` */
function keyFromDropinPath(path: string): ContentKey {
  const basename = path.split('/').pop() ?? path;
  return basename.replace(/\.(glb|gltf|fbx)$/i, '');
}

const DROPIN_URLS: ReadonlyMap<ContentKey, string> = new Map(
  Object.entries(DROPIN_MODULES).map(([path, url]) => [keyFromDropinPath(path), url]),
);

/**
 * Explicit bindings. Empty by default: every key falls through to the
 * procedural generator registered under the same id. Add an entry here to pin a
 * key to a specific asset that does not follow the drop-in naming convention
 * (e.g. one clip inside a multi-take export).
 */
export const CONTENT_MANIFEST: Readonly<Record<ContentKey, ContentSource>> = {};

/** Which source a key resolves to right now, and why. */
export function bindingFor(key: ContentKey): ContentBinding {
  const dropinUrl = DROPIN_URLS.get(key);
  if (dropinUrl) {
    return { key, source: { kind: 'file', url: dropinUrl }, origin: 'dropin' };
  }

  const pinned = CONTENT_MANIFEST[key];
  if (pinned) {
    return { key, source: pinned, origin: pinned.kind === 'file' ? 'manifest' : 'procedural' };
  }

  // Convention: a generator registered under the key itself is its default.
  if (getMotionGenerator(key) || getBodyGenerator(key) || getPropGenerator(key)) {
    return { key, source: { kind: 'procedural', generator: key }, origin: 'procedural' };
  }

  return { key, source: null, origin: 'unbound' };
}

/**
 * Every known key with its current binding. Drives the sandbox's seam panel so
 * it is obvious at a glance which content is still placeholder.
 */
export function contentSeamReport(): readonly ContentBinding[] {
  const keys: ContentKey[] = [...ALL_MOTION_KEYS, ...ALL_PROP_KEYS, BODY_KEYS.humanoid];
  return keys.map(bindingFor);
}
