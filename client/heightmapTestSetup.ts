import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHeightmapFromBytes } from './src/heightmap';

const here = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(here, 'public/models/terrain/heightmap.bin');
loadHeightmapFromBytes(new Uint8Array(readFileSync(binPath)));
