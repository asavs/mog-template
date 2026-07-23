# Environment art export brief

**Audience:** environment / world artists delivering playable terrain and props.  
**Engine notes:** browser multiplayer (Three.js + SpacetimeDB). Players walk on a **baked heightfield**, not raw mesh collision.

---

## Two different products

| Deliverable | What it is | What it is not |
|---|---|---|
| **Terrain** | Walkable ground + major landforms (hills, cliffs, rivers, paths) | A dump of every tree, bush, and furniture piece |
| **Props** | Trees, castle shells, rocks, debris, decor — **separate GLB files** | Geometry fused into the terrain mesh if it might move or be interacted with |

**Why:** collision is a heightmap bake from the terrain mesh. Gameplay objects (chop trees, doors, loot) need **server entities** and shared meshes, not a single megamesh re-export every time a bush moves.

---

## Terrain (ground) rules

1. **Y-up**, real-world-ish meters. We auto-fit longest XZ extent to a fixed world size (~3148 m unless engineering changes `TERRAIN_TARGET_SIZE`).
2. Prefer a **single continuous ground** surface. Large holes/overhangs confuse the heightfield.
3. **Runtime budget (targets):**
   - **~100k–400k triangles** for the whole ground mesh  
   - **~5–15 MB** after Draco/meshopt GLB  
   - One or few materials; prefer compressed textures (KTX2/WebP), not multi‑hundred‑MB packages  
4. Detail that is only visible up close → **normal/roughness maps** or separate props, not denser base mesh.
5. Delivery name: `terrain_<name>.glb` under the path engineering tracks (see `client/src/terrainConfig.ts`).
6. **One active playable terrain** at a time for the live game. Do not ask to keep five full maps in Git LFS.

After any ground shape change, engineering re-runs the collision bake (`docs/terrain-bake-runbook.md`).

---

## Props (trees, castle, rocks)

1. Export **one GLB per prefab** (e.g. `prop_tree_oak.glb`, `prop_castle_keep.glb`).
2. **Instances** of the same tree = same file, many placements (engineering/data), not duplicated meshes in the terrain file.
3. **Interactive** (chop, open, loot): flag for engineering — needs entity IDs and stages, not only visuals.
4. **Decorative only:** still better as props/instances than welded into terrain (download + iteration).
5. Castle: visual mesh + engineering will add **simple collider volumes** (boxes) for walk/block; do not rely on every stair poly for fairness.

---

## Coordinates & origin

- Origin near the **center of the playable area**.
- Avoid exotic scale (e.g. centimeters × 10000) unless documented; we re-center and uniform-scale to the world fit size.
- Consistent up-axis (Y).

---

## Collision model (read this)

| System | Owns |
|---|---|
| Heightmap (baked from terrain GLB) | Standing, walking, jump ground, slope walkability |
| Server kinematic volumes (later) | Buildings, barriers, large props |
| Prop meshes | Looks only unless marked collidable |

Steep faces above the walkable slope limit become non-walkable. Sculpt with that in mind.

---

## Delivery

- Prefer dropping art to a shared folder / object storage over committing multi‑hundred‑MB files into LFS forever.
- When committing is required for a pipeline test: one active terrain + LFS, paired with heightmap bake in the same PR.
- Medium-term hosting: GCS or VM static assets (`docs/asset-storage.md`) so clones stay thin.

---

## Checklist before handoff

- [ ] Terrain is ground-focused (props split out if interactive or repeated)
- [ ] Tris / file size near web budget (or explicitly marked “source art, not final runtime”)
- [ ] Y-up, sensible origin
- [ ] Named clearly (`terrain_*` / `prop_*`)
- [ ] Interactive objects listed for engineering
- [ ] If replacing live terrain: expect bake + heightmap commit, not mesh alone
