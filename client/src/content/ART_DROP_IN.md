# Avatar art drop-in (for humans & agents)

Engine contract for modular characters. **Not Mixamo-locked.**

## Rig: `mog_humanoid`

Canonical bone names live in `rig.ts` (`MOG_BONES`). Author in any DCC; retarget or rename to:

`Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`, `Head`,  
`LeftShoulder` / `LeftUpperArm` / `LeftLowerArm` / `LeftHand`,  
`RightShoulder` / `RightUpperArm` / `RightLowerArm` / `RightHand`,  
`LeftUpperLeg` / `LeftLowerLeg` / `LeftFoot`,  
`RightUpperLeg` / `RightLowerLeg` / `RightFoot`

Runtime lookup also accepts Mixamo-style aliases (`mixamorigRightHand`, …) for legacy packs only.

## Runtime format

- **GLB** only (meshopt/Draco welcome). FBX is offline intermediate.
- One body mesh per body id, skinned to `mog_humanoid`.
- Armor: skinned meshes on the **same** skeleton (slot pieces).
- Weapons: rigid (or lightly skinned) meshes parented to hand sockets.

## Catalog keys

Register assets in `catalog.ts` (later: JSON/CDN / single-source data — issue #46):

| Kind | Example id | Notes |
|---|---|---|
| Body | `body_m`, `body_f` | Underwear / nude base |
| Item | `sword_1h`, `shield`, … | `slot` + `meshKey` + grants |
| Preset | `paladin`, `wizard`, `acolyte` | Starting body + slots (character select) |
| Grant | `melee_slash`, `cast_fireball`, … | Ability tags on items / presets |
| Slot | `main_hand`, `off_hand`, … | Paper-doll `EquipSlot` strings |

New armor/weapons should be **catalog rows + files** — no engine PR if ids/slots already exist.

## Id conventions (client ↔ server)

**One authority file:** `shared/avatar-loadout.json` (issue #46).

| Layer | File |
|---|---|
| Canonical authority | `shared/avatar-loadout.json` |
| Generated (do not hand-edit) | `client/src/avatar/loadoutAuthority.generated.ts` — data **and** TS string unions (`ItemId`, `BodyId`, `AbilityId`, `LoadoutPresetId`) |
| Generated (do not hand-edit) | `server/spacetimedb/src/loadout_authority.generated.rs` |
| Client presentation (meshes, clips, sockets) | `client/src/avatar/catalog.ts` |
| Server capability helpers | `server/spacetimedb/src/loadout.rs` (reads generated authority) |

Wire/DB still carry plain strings; use `isItemId` / `isLoadoutPresetId` (etc.) at network boundaries. Prefer the generated unions inside client code.

Regenerate after editing the JSON:

```bash
node scripts/gen-avatar-loadout.mjs
# optional: node scripts/gen-avatar-loadout.mjs --check
```

### Naming

- **snake_case** only: `sword_1h`, `cast_fireball`, `body_m`
- **Presets** are join / character-select ids (`wizard`, `paladin`, `acolyte`) — not mesh-pack product names
- **Legacy class strings** map onto presets via `legacyClassToPreset` in the JSON
- **Grants** are capability tags: `melee_slash`, `block`, `cast_fireball`, `cast_lightning`, `drink_potion`
- **Paper-doll slots** (`equipSlots`): exclusive body/hand slots (`main_hand`, `off_hand`, …). At most one item per slot.
- **Utility slots** (`utilitySlots`): consumable/attach ids (`utility_potion`, …). Exclusive within their own id; do **not** compete with paper-doll (potion is never `off_hand`).
- Item `slot` must be listed in exactly one of those lists. Preset `slots` holds paper-doll only (keys ∈ `equipSlots`); `utilityEquipment` holds utility only (rows ∈ `utilitySlots`). Gen rejects crossed placement.
- Cast weapons use the **`wand`** item id (main_hand; weapons-pack mesh). Do not reintroduce `staff`.
- **Live equip** (issue #49): server reducers `equip_item(item_id)` / `unequip_slot(slot)` mutate `player_equipment`; combat grants recompute from those rows (+ `baselineGrants`).

### Where to edit

1. **Authority** (ids, equip/utility slots, grants, preset seeds, baseline grants) → **only** `shared/avatar-loadout.json`, then run the gen script
2. **Presentation** for a new item → `ITEM_PRESENTATION` (and body mesh / clips) in `catalog.ts`
3. **New preset** → JSON row + `PRESET_CLIPS` entry in `catalog.ts`

See also: recipe for adding an item end-to-end — [`docs/avatar-add-item.md`](../../../docs/avatar-add-item.md).

### Guardrail

`loadoutParity.test.ts` checks the default catalog against `LOADOUT_DERIVED` from the generated authority. If parity fails, regenerate or fix the JSON — do not hand-edit generated files.

### Baseline grants

`baselineGrants` in the JSON (currently `drink_potion`) apply on both client and server even with empty equipment.

## Suggested folder layout

```text
client/public/models/
  bodies/body_m.glb
  bodies/body_f.glb
  armor/chest_iron_m.glb
  weapons/sword_1h.glb
  animations/locomotion.glb   # shared library (Phase B)
  animations/combat.glb
```

## Capsule / scale

`PlayerAppearance.scale` and body `referenceHeight` must stay coupled to server collision height when non-default scales ship.

## What we do **not** need from art

- Per-class walk/run FBX folders  
- Full unique mesh per armor combination  
- Mixamo specifically (any retarget-to-mog pipeline is fine)

## Continuity / backlog

| | |
|---|---|
| Doctrine | Wiki `design/avatar-equipment.md` (mog `.wiki`) |
| Phase A implementation | Public PR [#38](https://github.com/asavs/mog-template/pull/38) |
| Pay transitional debt | Epic [#45](https://github.com/asavs/mog-template/issues/45) (blockers, pay order, child issues) |
| Expected looks today | Placeholder monomeshes: `body_f` ← wizard2 FBX, `body_m` ← paladin FBX; not finished class fantasy |
| Not avatar’s job | General multiplayer lag / net feel (see #74 and netcode issues) |

Cold start: read wiki doctrine → this file → epic #45 → PR #38.
