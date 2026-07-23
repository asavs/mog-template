/**
 * Alias for regenerating HM01 heightmap binaries from the terrain GLB.
 *
 * Prefer: `node scripts/bake-terrain-collision.mjs`
 *
 * This entry point exists so older docs/commands keep working. It no longer
 * parses deleted source arrays — the bake pipeline is the single writer.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const bake = path.resolve(import.meta.dirname, 'bake-terrain-collision.mjs');
const result = spawnSync(process.execPath, [bake], { stdio: 'inherit' });
process.exit(result.status ?? 1);
