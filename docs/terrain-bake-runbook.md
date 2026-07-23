# Terrain mesh swap + heightmap bake runbook

How to replace the playable ground mesh and keep client/server collision aligned.

## Pieces

| Piece | Role |
|---|---|
| `client/src/terrainConfig.ts` | Active GLB relative path + world fit size |
| `client/public/<path from terrainConfig>` | Runtime mesh (Git LFS) |
| `scripts/bake-terrain-collision.mjs` | Rasterizes GLB → HM01 binary (must use same path/size as `terrainConfig`) |
| `client/public/models/terrain/heightmap.bin` | Client collision samples |
| `server/spacetimedb/src/heightmap.bin` | Server embed (`include_bytes!`) |
| `client/src/heightmapMeta.ts` | Generated client bounds (from bake) |
| `server/.../heightmap.rs` | Thin loader; **bounds come from the binary header** |

## Swap steps

1. Place the new GLB under `client/public/models/terrain/` (clean name, no spaces).
2. Track it in Git LFS (`.gitattributes`) if large.
3. Update **both**:
   - `client/src/terrainConfig.ts` (`TERRAIN_GLB_RELATIVE_PATH`, and `TERRAIN_TARGET_SIZE` if the playable scale should change)
   - `scripts/bake-terrain-collision.mjs` (`TERRAIN_GLB_RELATIVE_PATH` / `TERRAIN_TARGET_SIZE` — keep lockstep with terrainConfig)
4. Update env preflight probe path in `tools/env-requirements/requirements.json` if the filename changed; regenerate docs:
   ```bash
   node tools/env-requirements/preflight.mjs --docs > docs/environment-requirements.md
   node tools/env-requirements/preflight.mjs --matrix > docs/environment-matrix.md
   ```
   (Write UTF-8; avoid PowerShell `>` which can emit UTF-16.)
5. Bake:
   ```bash
   node scripts/bake-terrain-collision.mjs
   ```
6. Smoke:
   ```bash
   cd client && npm run test -- src/heightmap.load.test.ts src/movement.test.ts
   ```
7. Commit mesh (LFS) + both `heightmap.bin` files + `heightmapMeta.ts` + path/config changes together.
8. Prefer **one** active terrain in LFS; remove the previous map from the tree.

## Do not

- Ship a new GLB without re-baking the heightmap.
- Hand-edit `heightmapMeta.ts` (bake owns it).
- Keep multiple full world maps in LFS “for later” — host large maps outside git (see `docs/asset-storage.md`).
- Weld interactable trees/buildings into the ground mesh if they will be gameplay entities later (see environment artist brief).

## Related

- Artist export rules: `docs/art/environment-export.md`
- Asset hosting direction: `docs/asset-storage.md`
