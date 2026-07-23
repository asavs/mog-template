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

Register assets in `catalog.ts` (later: JSON/CDN):

| Kind | Example id | Notes |
|---|---|---|
| Body | `body_m`, `body_f` | Underwear / nude base |
| Item | `sword_1h`, `shield`, … | `slot` + `meshKey` + grants |
| Preset | `paladin`, `wizard` | Starting body + slots (character select) |

New armor/weapons should be **catalog rows + files** — no engine PR if ids/slots already exist.

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
