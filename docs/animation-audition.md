# Animation Audition

Every clip in the two staged Quaternius libraries, what it actually does, and what it could
become. Seventy-nine clips: thirty-six in `ual1`, forty-three in `ual2`.

Companion to `docs/motion-vocabulary.md`, which defines the naming rules this proposes new
keys under, and to `client/src/content/clipBindings.json`, which is the output.

## How these were judged

By measurement, not by filename — `tools/what-moves.mjs` for per-bone swing and travel, plus
two derived readings that decide how a clip can be *used*:

- **Loop closure.** Angle between the first and last keyframe, meaned over every bone. Under
  5° the clip cycles; above it, it is a one-shot whatever its name says.
- **Held pose.** Mean rotation per bone across the clip, compared against `Idle_Loop`. Travel
  says nothing about a stance — a raised guard barely moves, and its entire content is the
  standing offset. This is the number that decides whether a clip is an upper-band overlay
  that plays over a walk, or a whole-body mode that owns the legs.

Measurement narrows the field; it does not replace watching. Anything below marked **needs
eyes** is a judgement the numbers cannot make.

---

## 1. The shape this library keeps handing us

Eleven clips arrive as **enter → hold → exit** triads:

| Triad | Enter | Hold | Exit |
|---|---|---|---|
| Jump | `Jump_Start` | `Jump_Loop` | `Jump_Land` |
| Ninja jump | `NinjaJump_Start` | `NinjaJump_Idle_Loop` | `NinjaJump_Land` |
| Slide | `Slide_Start` | `Slide_Loop` | `Slide_Exit` |
| Sit | `Sitting_Enter` | `Sitting_Idle_Loop` | `Sitting_Exit` |
| Channelled cast | `Spell_Simple_Enter` | `Spell_Simple_Idle_Loop` | `Spell_Simple_Shoot` / `Spell_Simple_Exit` |

The vocabulary has exactly one instance of this pattern, and it is hardcoded: `air_jump`,
`air_fall`, `air_land`. Everything else that wants the shape has nowhere to go.

Generalising it — a **phased action**: an entry clip, a loop held as long as the input is
held, and one of several exits — binds eleven clips at once and costs one mechanism. It also
describes things not in this pack at all: drawing a bow, priming a grenade, winding a heavy
attack, holding a block. `keys.ts` already argues that these are the same problem for a
skeleton; this is the pack agreeing.

The channelled cast is the strongest case. It has *two* exits — `Shoot` fires, `Exit` cancels
— which is the whole design of a hold-to-charge ability, sitting complete and unbound.

The second recurring shape is the **chain**: an ordered run of attacks where continuing the
input advances to the next link and releasing drops into a recovery.

| Chain | A | B | C | Recoveries |
|---|---|---|---|---|
| Sword | `Sword_Regular_A` | `Sword_Regular_B` | `Sword_Regular_C` | `..._A_Rec`, `..._B_Rec` |
| Unarmed | `Punch_Jab` | `Punch_Cross` | `Punch_Hook` | `Punch_Hook_Rec` |

The `_Rec` clips are the punish window — the thing that makes a combo a decision rather than a
button. Two chains, one mechanism.

**Neither shape is a new key. Both are new structure over keys that mostly already exist.**

---

## 2. Three bindings the measurements contradict

### `act_slam_2h` → `Sword_Heavy_Combo` is not a slam

`keys.ts` defines `slam2h` as "overhead raise and downward slam, both arms committed."
The bound clip is 4.33 s long, rotates the pelvis through 1277° of accumulated travel with a
175° peak, and **translates the pelvis 4.74 units at 1.09 u/s**. It is a multi-hit travelling
spin combo. Nothing about it is a slam, and at four and a third seconds it is not a single
action at all.

The travel is the sharper problem. That motion is on `pelvis`, not `root`, so the root-motion
check in `what-moves.mjs` does not flag it — but `pelvis` is the top animated node here, so
the body genuinely crosses nearly five units of floor while the server believes the character
is standing still. `Sword_Regular_Combo` has the same defect at 2.28 units.

**There is no overhead slam in either library** — that key had no honest source.

It had no consumer either: outside `keys.ts` and the binding table, nothing referenced
`act_slam_2h`. It was the neutral name coined for a class animation so that gesture could
survive de-classing, and it outlived the reason it existed. **Resolved by deleting the key**,
along with the 390 KB carved GLB it was shipping to every player.

Keep the clip; it is a good clip. It stays in the library unbound, waiting to be the chain
finisher, with its pelvis translation stripped or converted into an authoritative dash.

### `stance_sword_shield` → `Idle_Shield_Loop` poses only the shield arm

Measured against `Idle_Loop`, this clip moves `upperarm_l` 74° and `lowerarm_l` 72° — the left
arm comes up. The right arm barely changes: `lowerarm_r` differs by 13°, `upperarm_r` by less.
The legs differ by under 8°.

So the reported sword-through-shield intersection is not a grip error and not pose-specific bad
luck. **The stance was authored for a shield alone.** A sword in the right hand hangs wherever
plain idle leaves it, which is tucked against the body, behind where the shield is held across
the chest. Any sword mesh will intersect any shield mesh in this pose.

Two honest fixes, and the second is more interesting:

1. Author a right-arm offset for the sword-and-board stance.
2. **Compose it** — take the left arm from `Idle_Shield_Loop` and the right arm from
   `Sword_Idle`.

**Resolved by composing.** The upper band now splits into `core` / `armL` / `armR`, a stance
is a list of poses each naming the bands it holds, and sword-and-board is built from the two
clips that each pose one arm. There is no `motion.stance_sword_shield` any more, because there
was never a clip that was one — there is `stance_shield` and `stance_sword`, and naming the arm
rather than the loadout is what stops the combinations multiplying. See §4.

### `stance_staff` → `Idle_Torch_Loop` is defensible, and its mirror is better

`Idle_Torch_Loop` raises the **left** arm (`upperarm_l` 76°, `lowerarm_l` 67°) with legs
untouched — a clean upper-band overlay, and a reasonable stand-in for a one-handed vertical
grip until a staff exists.

The find is `Idle_Lantern_Loop`: `upperarm_r` 106°, `lowerarm_r` 34°, and **every other bone
within 1°**. It is the cleanest overlay in either library, and it is the right-handed mirror of
the torch clip. Together they are a matched pair of single-arm hold stances, one per hand —
worth more as a generic `stance_hold_l` / `stance_hold_r` than as two lighting props, given
neither a torch nor a lantern can actually be carried in the prop kit.

---

## 3. The clip list

Verdict key: **bind** — slots into a key that exists or nearly does. **system** — needs a
mechanism built first. **npc** — for bodies that are not the player. **cut**.

### Locomotion (14)

| Clip | Lib | Reading | Verdict → use |
|---|---|---|---|
| `Idle_Loop` | ual1 | 2.5 s, cycles | bind ✔ `loco_idle` *(already)* |
| `Walk_Loop` | ual1 | 1.33 s, 70 % lower | bind ✔ `loco_walk_f` *(already)* |
| `Jog_Fwd_Loop` | ual1 | 0.93 s, 72 % lower | bind ✔ `loco_run_f` *(already)* |
| `Sprint_Loop` | ual1 | 0.67 s, 73 % lower | **bind** → new `loco_sprint_f`. A third gear. Walk / jog / sprint is a real speed ladder and the top rung is sitting unused. |
| `Walk_Formal_Loop` | ual1 | 85 % lower, only 13 % upper | **bind** → the *armless* walk. Almost no arm swing, so it is the gait to play under any stance that owns the arms. Also a personality walk for the creator. |
| `Walk_Carry_Loop` | ual2 | 85 % lower; both forearms raised 59–65°, thumbs gripping | **bind twice** → lower band is an ordinary walk, upper band is a two-handed carry stance. One clip, two keys, no new art. |
| `Crouch_Idle_Loop` | ual1 | legs 120° from idle | **system** → `loco_crouch_idle`. Whole-body mode, not an overlay. |
| `Crouch_Fwd_Loop` | ual1 | legs 105° from idle | **system** → `loco_crouch_f`. With the above, a complete sneak mode. |
| `Push_Loop` | ual1 | 78 % lower, legs braced 37° from rest | **system** → pushing. Pairs with `prop.crate_wooden`, `prop.barrel`. |
| `Swim_Fwd_Loop` | ual1 | 1.33 s, arms 130° swing | **conditional** → only worth anything if the castle zone gets water. Cheap if it does. |
| `Swim_Idle_Loop` | ual1 | 3.33 s tread | **conditional** → same. |
| `Zombie_Walk_Fwd_Loop` | ual2 | 61 % lower, hunched | **npc** → `loco_walk_f` on a non-player motion set. |
| `Zombie_Idle_Loop` | ual2 | legs 49° from idle, fingers curled 90° | **npc** → `loco_idle`, same. |
| `A_TPose` ×2 | both | 2.5 s of nothing | **cut** — a bind reference, not a clip. `restPose.ts` already covers it. |

**No strafe and no backpedal exist in either library.** `loco_walk_l/r`, `loco_run_l/r` and
both `_b` keys have no source and never will from these packs. That is controller work — a
reversed walk and a yaw offset with the lower band masked — not an asset gap.

### Air and mobility (10)

| Clip | Lib | Reading | Verdict → use |
|---|---|---|---|
| `Jump_Start` | ual1 | 1.33 s, pelvis +0.35 | bind ✔ `air_jump` *(already)* |
| `Jump_Loop` | ual1 | 2.5 s, cycles | bind ✔ `air_fall` *(already)* |
| `Jump_Land` | ual1 | 1.27 s | bind ✔ `air_land` *(already)* |
| `NinjaJump_Start` | ual2 | legs coil 44° from rest vs 30° for `Jump_Start` | **bind** → the **second** jump of a double jump. A deeper coil reads as effort, and two visibly different jumps read as skill rather than repetition. |
| `NinjaJump_Idle_Loop` | ual2 | calves tucked 134–138° from idle | **bind** → its airborne loop. A hard tuck; unmistakably not the first jump. |
| `NinjaJump_Land` | ual2 | 1.27 s, harder impact | **bind** → its landing. |
| `Roll` | ual1 | 1.47 s, net 0.37, calf travel 631° | **system** → `act_dodge_roll`. A core action verb with i-frames, entirely absent from the vocabulary. |
| `ClimbUp_1m` | ual2 | 0.67 s, thigh swing 171° | **system** → mantle. The filename hands you the authored ledge height, which is a gift: build the probe at 1 m and the clip is honest. |
| `Slide_Start` / `Slide_Loop` / `Slide_Exit` | ual2 | net 0.78 in and out; loop leans pelvis back 71° | **system** → sprint-into-slide. A phased action (§1) and the natural partner to `Sprint_Loop`. |

### Melee (14)

| Clip | Lib | Reading | Verdict → use |
|---|---|---|---|
| `Sword_Attack` | ual1 | 1.53 s, no travel | bind ✔ `act_swing_1h` *(already)* — and the only travel-free sword swing in either pack. Keep it as the safe default. |
| `Sword_Regular_A` | ual2 | 0.43 s, net 0.30 | **system** → chain link 1. |
| `Sword_Regular_B` | ual2 | 0.53 s, net 0.04 | **system** → chain link 2. |
| `Sword_Regular_C` | ual2 | 2.0 s, net 0.31, pelvis swing 174° | **system** → chain finisher, spinning. |
| `Sword_Regular_A_Rec` | ual2 | 0.97 s | **system** → recovery after link 1. |
| `Sword_Regular_B_Rec` | ual2 | 1.03 s | **system** → recovery after link 2. |
| `Sword_Regular_Combo` | ual2 | 3.0 s, pelvis travels 2.28 u | **cut, or keep as reference** — A+B+C pre-concatenated. Redundant once the parts are chained, and it carries baked travel. Possibly useful for an NPC that always commits to the full string. |
| `Sword_Heavy_Combo` | ual2 | 4.33 s, pelvis travels 4.74 u | **system** — see §2. Unbound; a committed heavy or chain finisher once the chain exists. |
| `Sword_Dash` | ual2 | 1.57 s, upperarm swing 178° | **system** → gap closer. |
| `Sword_Block` | ual2 | 1.23 s, cycles | bind ✔ `act_guard_hold` *(already)* |
| `Sword_Idle` | ual1 | legs 49° from idle — bladed stance; right forearm 35°, hand 21° | bind ✔ `stance_sword` — the right arm of sword-and-board, and the whole stance for a sword alone. |
| `Idle_Shield_Loop` | ual2 | left arm 74°/72°, right within 13° of idle, legs untouched | bind ✔ `stance_shield` — the left arm of sword-and-board, and it carries `core` because it is the more committed pose. |
| `Shield_OneShot` | ual2 | 0.83 s, 76 % upper, no travel | **bind** → shield bash. Upper-only, so it overlays a walk cleanly. |
| `Shield_Dash` | ual2 | 1.10 s, net 0.40, 62 % lower | **system** → shield charge. |
| `Idle_Shield_Break` | ual2 | left arm thrown open 75°, legs 19° | **bind** → new `react_guard_break`. The exact left arm `Idle_Shield_Loop` raises gets knocked aside — a verified pair, and the feedback that makes blocking a real exchange. |

### Unarmed (4)

| Clip | Lib | Reading | Verdict → use |
|---|---|---|---|
| `Punch_Jab` | ual1 | 0.87 s, left `lowerarm_l` 120° swing | **system** → chain link 1. |
| `Punch_Cross` | ual1 | 1.0 s, right `lowerarm_r` 126° swing | **system** → chain link 2. |
| `Punch_Hook` | ual2 | 0.47 s, drops 0.29 and steps 0.21 | **system** → chain finisher; ducks under. |
| `Punch_Hook_Rec` | ual2 | 0.60 s, rises 0.33 | **system** → its recovery, standing back up. |

Worth stating for its own sake: under a design where equipment grants actions, **the empty
hand is a loadout**, and this is its moveset. Unarmed getting the same three-link chain as the
sword is the architecture proving itself rather than a special case.

### Ranged and channelled (5)

| Clip | Lib | Reading | Verdict → use |
|---|---|---|---|
| `OverhandThrow` | ual2 | 1.33 s, 76 % upper | bind ✔ `act_hurl_1h` *(already)* |
| `Spell_Simple_Enter` | ual1 | 0.53 s, left fingers curl 116° | **system** → channel entry. |
| `Spell_Simple_Idle_Loop` | ual1 | 2.1 s, cycles, both hands posed | **system** → channel hold. |
| `Spell_Simple_Shoot` | ual1 | 0.50 s, **left arm only** | **system** → channel release. |
| `Spell_Simple_Exit` | ual1 | 0.43 s | **system** → channel cancel. |

`Spell_Simple_Shoot` moves `hand_l`, `lowerarm_l`, `upperarm_l` and the left fingers; the
largest thing outside that arm is `spine_03` at 9.6°. It is a purely left-handed cast — while
every sword clip and `OverhandThrow` are right-handed. See §4.

### Reactions (5)

| Clip | Lib | Reading | Verdict → use |
|---|---|---|---|
| `Hit_Chest` | ual1 | 0.33 s, 96 % upper | bind ✔ `react_hit` *(already)* |
| `Hit_Head` | ual1 | 0.43 s, 97 % upper | **bind** → new `react_hit_head`. With the above, hit reactions become *directional* instead of one flinch for everything. |
| `Hit_Knockback` | ual2 | 0.83 s, net 0.55 | **bind** → new `react_knockback`. Third tier: light / head / heavy, selected by damage magnitude. Data picking a row, not three call sites. |
| `Death01` | ual1 | 2.4 s, net 0.81, ends prone | bind ✔ `react_death` *(already)* |
| `LayToIdle` | ual2 | 1.53 s, net 0.83, starts prone | **bind** → new `react_revive`. `Death01` puts you on the floor and this stands you up. Together they are a complete down-and-revive cycle, which is a system nobody had to author. |

### World interaction (10) — the sleeper

| Clip | Lib | Reading | Verdict → use |
|---|---|---|---|
| `PickUp_Table` | ual1 | 0.83 s, 86 % upper | **system** → pick up at waist height. Feeds `Walk_Carry_Loop`. |
| `Chest_Open` | ual2 | 1.37 s, both hands, 82 % upper | **system** → open a lid. `prop.chest_wood` already exists. |
| `Consume` | ual2 | 1.33 s, 94 % upper, **left arm** | bind ✔ `act_drink` *(already)*. Worth noting it is upper-only, so it can overlay a walk — drinking on the move is available for free, and is a balance decision rather than an art one. |
| `Fixing_Kneeling` | ual1 | **5.2 s** — the longest clip in either pack | **system** → kneel and work. Crafting, repair, lockpicking. `prop.anvil`, `prop.whetstone`, `prop.workbench` all already exist. |
| `TreeChopping_Loop` | ual2 | 0.97 s, cycles, 80 % upper | **system** → woodcutting. `prop.axe` already exists. |
| `Farm_PlantSeed` | ual2 | 2.77 s | **system** → planting. |
| `Farm_Harvest` | ual2 | 2.5 s | **system** → gathering. |
| `Farm_Watering` | ual2 | 3.8 s | **system** → tending. `prop.farm_crate_carrot` already exists. |
| `Sitting_Enter` / `Sitting_Idle_Loop` / `Sitting_Exit` | ual1 | phased; legs 96° from idle | **system** → sitting. `prop.stool`, `prop.bench`, `prop.table_large` already exist, and the tavern scene already has a stool under the body. |
| `Sitting_Talking_Loop` | ual1 | seated, hands gesticulating | **npc** → seated conversation. |

This is the largest single finding in the pack. **The library contains a complete gathering and
crafting verb set, and the prop kit imported alongside it contains the matching stations.**
Chop / plant / harvest / water / repair / open / carry / push, against axe / farm crate /
anvil / whetstone / workbench / chest / crate / barrel.

Under the design where equipment grants actions, none of this needs a new content type: **the
tool is the ability.** An axe grants chop the same way a sword grants swing. That is the
existing seam carrying a whole economy without being widened.

### Stances, emotes and social (10)

| Clip | Lib | Reading | Verdict → use |
|---|---|---|---|
| `Idle_Torch_Loop` | ual1 | **left** arm raised 76°, legs untouched | bind ✔ `stance_staff` *(already)* — see §2. Better read as a generic one-handed hold, left. |
| `Idle_Lantern_Loop` | ual2 | **right** arm raised 106°, every other bone within 1° | **bind** → the right-handed mirror of the above, and the cleanest overlay in either library. Together, a matched pair of single-arm hold stances. |
| `Emote_Dance_Loop` | ual1 | 1.0 s, cycles, 56 % lower | **bind** → `emote_dance`. Whole-body, so it cannot overlay a walk — which is correct for a dance. |
| `Emote_Point` | ual1 | 2.0 s, 92 % upper, left index leads | **bind** → `emote_point`. Also a tutorial pointer for an NPC. |
| `Emote_ThumbsUp` | ual2 | 2.5 s, left arm 116° | **bind** → `emote_yes`. |
| `Emote_HeadShake_Loop` | ual2 | head 143° travel, 19° swing | **bind** → `emote_no`. Large travel, small swing — a shake, which is how it was correctly identified as a movement rather than a refusal. |
| `Idle_Rail_Call` | ual2 | **right arm only**, 73–78° swing, legs untouched | **bind, rename** → `emote_wave`. The rail is fiction; the motion is a raised-arm hail. Renaming it at the vendoring boundary is the same move already applied to the head shake. |
| `Idle_Rail_Loop` | ual2 | legs 48° from idle, weight shifted | **npc** → leaning idle. Not an overlay; a whole-body ambient pose for someone stationed somewhere. |
| `Idle_FoldArms_Loop` | ual2 | both arms 88–94°, legs untouched | **bind** → `stance_arms_folded`. Clean overlay; a waiting/impatient idle. |
| `Idle_Talking_Loop` | ual1 | fingers gesticulate, legs untouched | **npc** → conversation overlay. |

### Genre rejects and duplicates (2)

| Clip | Lib | Verdict |
|---|---|---|
| `Idle_TalkingPhone_Loop` | ual2 | **cut** — right hand to ear. Wrong era, and its finger animation is identical to `Idle_Talking_Loop`, which already covers conversation. |
| `A_TPose` (ual2) | ual2 | **cut** — duplicate of ual1's. |

### Enemies (3)

`Zombie_Idle_Loop`, `Zombie_Walk_Fwd_Loop`, `Zombie_Scratch` (1.8 s, `upperarm_r` 120° swing).

A minimal complete enemy — idle, walk, attack — and the reactions are already shared:
`Hit_Chest`, `Hit_Knockback`, `Death01` are body-agnostic.

The architectural point matters more than the three clips. Motion keys are named for the
gesture, never for the character, so **a zombie is a body plus a motion set** — `Zombie_Walk`
resolves `loco_walk_f` for that set exactly as `Walk_Loop` resolves it for the player. No new
machinery, no NPC animation vocabulary, no second controller. The vocabulary rule that was
written to stop paladins inheriting slams turns out to hand over enemy animation for free.

---

## 4. One capability, wanted twice

Two independent findings ask for the same missing thing:

- `Idle_Shield_Loop` poses the left arm and leaves the right at idle, so a sword in the right
  hand intersects the shield.
- `Spell_Simple_*`, `Consume` and `Idle_Torch_Loop` are entirely left-handed, while the sword
  work, `OverhandThrow`, `Idle_Lantern_Loop` and `Idle_Rail_Call` are entirely right-handed.

The bands used to split the rig by height alone: `lower`, `mid`, `upper`. A **left/right split
within the upper band** resolves both — compose a sword-and-board stance from two clips' arms,
and play a left-hand cast over a right-hand weapon stance. Neither is a feature anybody set out
to build; both fall out of the asset measurements.

**Done, for the stance half.** `upper` is now `core` / `armL` / `armR`, the disjointness
invariant survives because `core` — spine2, neck, head — belongs to exactly one claimant rather
than to both arms, and the fallback heuristic reads sidedness from every spelling we import
(`thumb_03_l`, `LeftForeArm`, `mixamorig:RightHandIndex1`) while never mistaking `calf_l` for
an arm.

**Not done: single-arm overlays.** A left-hand cast over a right-hand stance additionally needs
`armLeft` / `armRight` overlay widths and locomotion split per band. The bands make it small;
it waits for a motion that requests it, because a claim nobody has watched resolve is not worth
shipping.

---

## 5. What is genuinely absent

- **Strafe and backpedal.** Four locomotion keys with no source in either pack. Controller
  work: reverse `Walk_Loop`, offset the pelvis yaw with the lower band masked.
- **Any two-handed committed action.** No clip in either library is an overhead slam, and the
  key that claimed to be one has been deleted rather than left pointing at something else.
- **A staff.** Not in the prop kit; `prop.staff` stays procedural. `Idle_Torch_Loop` covers the
  stance.
- **A carryable torch or lantern.** Both kit items are wall fittings. `prop.candlestick` is the
  only light that can be held.
- **A dizzy or stagger loop.** Nothing in either pack spins or reels. `Emote_Dance_Loop` is the
  nearest thing and it is not close.

---

## 6. Suggested order

Nothing here is blocked by anything above it; this is ordered by payoff per unit of work.

1. **Fix the two wrong bindings.** Both done: `act_slam_2h` deleted, and sword-and-board
   composed per arm off the split in §4.
2. **Bind the free wins.** `Sprint_Loop`, `Hit_Head`, `Hit_Knockback`, `LayToIdle`,
   `Idle_Shield_Break`, `Sword_Idle`, `Idle_FoldArms_Loop`, `Walk_Formal_Loop`, the
   `Walk_Carry_Loop` double-bind, the NinjaJump triad, and the five emotes. Roughly twenty
   clips into keys that exist or are one line away.
3. **Generalise the phased action.** Unlocks the channelled cast, slide, and sitting — and
   retires the hardcoded jump triad into the same mechanism.
4. **Build the chain.** Sword and unarmed, one mechanism, eleven clips.
5. **Pick the systems you actually want.** Crouch, dodge, mantle, gathering, farming, swimming,
   enemies. Each is a clean unit of work with its clips and props already in hand. Cutting one
   cuts its clips with it — which is the honest way to shrink this list, rather than rejecting
   clips one at a time.

## 7. Tally

| | Clips |
|---|---|
| Already bound | 15 — two of them wrongly, see §2 |
| Bind now, key exists or is one line away | 19 |
| Wait on a mechanism | 33 |
| For non-player bodies | 6 |
| Conditional on water existing | 2 |
| Cut | 4 |
| **Total** | **79** |

The keep rate is high, and that is not generosity. The firearms and driving clips were already
pruned from the binary, so what remains is genre-matched by construction. The real question is
not which clips to reject but **which systems to build** — the clips are downstream of that,
and cutting a system is what cuts clips.
