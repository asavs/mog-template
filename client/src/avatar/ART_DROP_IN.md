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
| Preset | `paladin`, `wizard` | Starting body + slots (character select) |
| Grant | `melee_slash`, `cast_fireball`, … | Ability tags on items / presets |
| Slot | `main_hand`, `off_hand`, … | Paper-doll `EquipSlot` strings |

New armor/weapons should be **catalog rows + files** — no engine PR if ids/slots already exist.

## Id conventions (client ↔ server)

Phase A keeps **two hand-aligned copies** of loadout ids:

| Side | File |
|---|---|
| Client presentation | `client/src/avatar/catalog.ts` |
| Server authority | `server/spacetimedb/src/loadout.rs` |

**Do not invent server-only or client-only ids** for bodies, items, grants, presets, or equip slots. If one side needs a new string, update both in the same PR (or land #46 first).

### Naming

- **snake_case** only: `sword_1h`, `cast_fireball`, `body_m`
- **Presets** are join / character-select ids (`wizard`, `paladin`) — not mesh-pack product names
- **Legacy class strings** map onto presets: `wizard2` → `wizard`, `pally` → `paladin` (see `presetIdFromLegacyClass` / `normalize_preset_id`)
- **Grants** are capability tags, not animation names: `melee_slash`, `block`, `cast_fireball`, `cast_lightning`, `drink_potion`
- **Slots** match `EquipSlot` / server seed slots. Non-slot attaches (Phase A) may use names like `utility_potion` until #50/#51 retire that hack

### Where to edit

1. Add/change an **item** → `ITEMS` in `catalog.ts` **and** `items` + `preset_equipment` / grant mapping in `loadout.rs`
2. Add/change a **grant** → item `grants` / `extraGrants` on the client **and** `grants` module + `preset_grants` / `capabilities_from_grants` on the server
3. Add/change a **preset** → `PRESETS` + utility lists on the client **and** `preset_appearance` / `preset_equipment` / `preset_grants` on the server
4. Add/change a **body** → `BODIES` on the client **and** `bodies` + appearance seeds on the server

### Guardrail

`client/src/avatar/loadoutParity.test.ts` compares the default catalog to the Phase A id sets mirrored from `loadout.rs`. If you change ids on either side, update the fixture in that test (and the other language file) so CI stays green.

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
