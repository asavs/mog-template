# Recipe: add an item

End-to-end checklist for a new weapon, armor piece, or consumable under the **single-source loadout** architecture (issue #46). Ids, slots, and grants are authoritative in JSON; presentation stays client-only.

Related: [`shared/README.md`](../shared/README.md), [`client/src/avatar/ART_DROP_IN.md`](../client/src/avatar/ART_DROP_IN.md).

---

## When to use

Use this recipe when you need a **new item id** (or starter-gear seed) that reuses existing equip slots and combat capability flags — no new bone sockets, no new server tick path, no dual client/server hand catalogs.

If you need a brand-new grant that combat reducers must enforce, or a new paper-doll slot kind, this recipe is only the data half; map the grant (or slot) in server code as well.

---

## 1. Authority edit

**File:** `shared/avatar-loadout.json` only.

Add a row under `items`:

```json
"dagger": {
  "slot": "main_hand",
  "grants": ["melee_slash"]
}
```

| Field | Meaning |
|---|---|
| **key** (`dagger`) | Stable `snake_case` item id (wire/DB string). |
| `slot` | Equip slot string. Today authority seeds use `main_hand` / `off_hand` (`equipSlots`). Utility attaches (e.g. `utility_potion`) appear only on presets via `utilityEquipment`. |
| `grants` | Ability tags while equipped (e.g. `melee_slash`, `block`, `cast_fireball`, `drink_potion`). |

Optional — seed the item as starter gear on a preset:

- Paper-doll slot: under that preset’s `slots`, e.g. `"main_hand": "dagger"`.
- Non-slot attach: under `utilityEquipment`, e.g. `{ "slot": "utility_potion", "itemId": "potion" }`.
- Always-on abilities not tied to gear: `extraGrants` on the preset, or global `baselineGrants`.

Do not invent a second item list on the client or server.

---

## 2. Regenerate

From the repo root:

```bash
node scripts/gen-avatar-loadout.mjs
# CI / local staleness check:
node scripts/gen-avatar-loadout.mjs --check
```

(`cd client && npm run gen:loadout` is equivalent.)

**Writes (do not hand-edit):**

| Output | Role |
|---|---|
| `client/src/avatar/loadoutAuthority.generated.ts` | `LOADOUT_AUTHORITY`, `LOADOUT_DERIVED`, TS unions (`ItemId`, `AbilityId`, …), `isItemId` guards |
| `server/spacetimedb/src/loadout_authority.generated.rs` | `ITEM_IDS`, `item_grants`, `item_slot`, preset equipment tables, … |

`--check` exits non-zero if either generated file is stale relative to the JSON.

---

## 3. Presentation

**File:** `client/src/avatar/catalog.ts` → `ITEM_PRESENTATION`.

Authority supplies `id`, `slot`, and `grants`. You supply mesh and attach:

```ts
dagger: {
  meshKey: 'models/weapons/dagger.glb',
  attach: 'socket',
  socketId: 'right_hand',
  // optional: scale, position, rotation, objectNames, normalizeHeight
},
```

| Field | Notes |
|---|---|
| `meshKey` | Path under `client/public/` (see asset drop). |
| `attach` | Usually `'socket'` for held gear. |
| `socketId` | e.g. `right_hand` / `left_hand` (canonical sockets in the avatar package). |
| `grantsOnly: true` | OK placeholder: no mesh fetch/attach until art exists. |
| `objectNames` | Submesh names inside a multi-mesh pack GLB (transitional). |

`buildItemsFromAuthority()` throws if an authority item lacks an `ITEM_PRESENTATION` row. Missing body presentation is the same pattern on `BODY_PRESENTATION`.

---

## 4. Asset drop

Place runtime files under `client/public/models/` so `meshKey` resolves via the public asset path. Align with [`ART_DROP_IN.md`](../client/src/avatar/ART_DROP_IN.md):

```text
client/public/models/
  weapons/dagger.glb      # held items
  items/….glb             # consumables / small props
  armor/….glb             # skinned armor (same skeleton as body)
  bodies/….glb            # body bases (not this recipe)
```

Prefer **GLB**. Runtime format and `mog_humanoid` bone contract are documented in ART_DROP_IN; placeholder meshes and `grantsOnly` are fine until art lands.

---

## 5. Parity / tests

- `client/src/avatar/loadoutParity.test.ts` — default catalog ids/grants/equipment must match `LOADOUT_DERIVED` from the generated TS authority.
- `client/src/avatar/catalog.test.ts` — presentation and resolve behavior for known presets.
- Server unit tests in `server/spacetimedb/src/loadout.rs` exercise grant → capability mapping for existing grants.

If parity fails: fix JSON or `ITEM_PRESENTATION`, regenerate — **never** patch `*.generated.ts` / `*.generated.rs` by hand.

---

## 6. Server impact

Item grants flow through generated `item_grants` into capability helpers in `server/spacetimedb/src/loadout.rs` (`capabilities_from_grants`, `capabilities_for_equipment_item_ids`). Combat reducers gate on those capability booleans (`melee`, `block`, `cast`, `drink_potion`).

| Situation | Effect |
|---|---|
| New item reuses an existing grant (`melee_slash`, …) | Data-only: equipment and reducers already understand it. |
| New grant string that nothing maps | Data is stored and listed in generated `GRANT_IDS`, but `capabilities_from_grants` ignores unknown strings (`_ => {}`). Combat will not change until you map the grant (and likely extend `Capabilities` / reducers). |
| Optional hand aliases | `loadout.rs` `items::` / `grants::` constants are call-site convenience; they are **not** codegen’d. Add only if server code will reference the id by name. |

---

## 7. Do not

- Maintain a second hand-synced item catalog on client and server.
- Edit `loadoutAuthority.generated.ts` or `loadout_authority.generated.rs` by hand.
- Open SpacetimeDB port 3000 publicly (Nginx only; bind stays `127.0.0.1:3000`).
- Put secrets in `VITE_*` env vars (they ship to the browser).
- Store runtime CDN URLs on server tick / equipment rows — catalog maps `meshKey` → URL on the client only.

---

## Worked micro-example: add a training dagger

Hypothetical only — do not commit this item unless you intend to ship it.

1. **JSON** — in `shared/avatar-loadout.json`:

   ```json
   "items": {
     "sword_1h": { "slot": "main_hand", "grants": ["melee_slash"] },
     "dagger": { "slot": "main_hand", "grants": ["melee_slash"] }
   }
   ```

   Optional starter: set a preset’s `"main_hand": "dagger"` (replacing `sword_1h` or `wand` for that preset).

2. **Gen:** `node scripts/gen-avatar-loadout.mjs` then `node scripts/gen-avatar-loadout.mjs --check`.

3. **Presentation** — in `ITEM_PRESENTATION`:

   ```ts
   dagger: {
     meshKey: 'models/weapons/dagger.glb',
     attach: 'socket',
     socketId: 'right_hand',
     scale: 1.0,
   },
   // or until art exists:
   // dagger: { meshKey: 'models/weapons/dagger.glb', attach: 'socket', socketId: 'right_hand', grantsOnly: true },
   ```

4. **Asset:** drop `client/public/models/weapons/dagger.glb` (or keep `grantsOnly` until then).

5. **Verify:** run client loadout/catalog tests; confirm the item appears in generated `ITEM_IDS` and, if seeded on a preset, in that preset’s equipment via `resolvePreset`.

Because `melee_slash` already maps to `Capabilities.melee`, no server combat change is required for this sketch.
