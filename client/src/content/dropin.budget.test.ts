/**
 * A size budget for `dropin/`, enforced in CI.
 *
 * Drop-in assets are committed to the repo on purpose — it keeps clone-and-run
 * working, and `import.meta.glob` needs the files on disk at build time anyway.
 * The cost of that choice is that the repo grows by whatever anyone drops in,
 * and binaries are effectively permanent: removing one from history later means
 * rewriting it for everybody.
 *
 * So the budget exists as a test rather than a note in a README. Blowing it
 * should be a conversation — raise the numbers deliberately, move to LFS, or
 * fetch assets at build time — not something discovered months later when the
 * clone takes five minutes.
 *
 * These numbers are a starting point, not a law. Raise them on purpose.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DROPIN_DIR = fileURLToPath(new URL('./dropin', import.meta.url));

const MB = 1024 * 1024;
/** Everything in dropin/ combined. */
const TOTAL_BUDGET_BYTES = 25 * MB;
/** Any single asset. A character or an animation library, not a whole pack. */
const PER_FILE_BUDGET_BYTES = 5 * MB;

type Asset = { path: string; bytes: number };

function assetsIn(dir: string): Asset[] {
  const out: Asset[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...assetsIn(full));
      continue;
    }
    // Documentation is not an asset.
    if (/\.(md|txt)$/i.test(entry.name)) continue;
    out.push({ path: full.slice(DROPIN_DIR.length + 1), bytes: statSync(full).size });
  }
  return out;
}

const mb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;

describe('dropin asset budget', () => {
  const assets = assetsIn(DROPIN_DIR);

  it('keeps any single asset under the per-file budget', () => {
    const oversized = assets
      .filter(asset => asset.bytes > PER_FILE_BUDGET_BYTES)
      .map(asset => `${asset.path} (${mb(asset.bytes)})`);

    expect(
      oversized,
      `Over the ${mb(PER_FILE_BUDGET_BYTES)} per-file budget. Export a smaller `
      + 'variant, or raise PER_FILE_BUDGET_BYTES deliberately.',
    ).toEqual([]);
  });

  it('keeps dropin/ as a whole under the total budget', () => {
    const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);

    expect(
      total,
      `dropin/ is ${mb(total)} across ${assets.length} asset(s), over the `
      + `${mb(TOTAL_BUDGET_BYTES)} budget. Commit only the clips actually bound to `
      + 'keys, or move to LFS / a build-time fetch.',
    ).toBeLessThanOrEqual(TOTAL_BUDGET_BYTES);
  });

  it('accepts only formats the seam can load', () => {
    const unloadable = assets
      .filter(asset => !/\.(glb|gltf|fbx|bin)$/i.test(asset.path))
      .map(asset => asset.path);

    expect(
      unloadable,
      'Only glb/gltf/fbx are discovered by the dropin glob. A committed .zip or '
      + '.blend is pure repo weight that nothing loads.',
    ).toEqual([]);
  });
});
