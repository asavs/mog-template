# Character Pipeline

The road from "we own some animation packs" to "a player builds a character and walks out of
the creation screen with it." Five steps, plus a demo that runs alongside them rather than
after them.

Companion to `docs/animation-audition.md` (what the clips are) and `docs/motion-vocabulary.md`
(the naming and layering rules).

The judging happens in two rooms, both Vite entries beside the game:

- `npm run sandbox` — the clip browser. One clip at a time, any body, any scene. Answers
  *what is this animation*.
- `npm run drill` — a room per character running a fixed routine a step at a time. Answers
  *does this set of animations hold together*, which no single clip can be asked.

`client/src/drill/drills.ts` is where the routines are written, and it is the file this plan
is most directly about.

---

## The one rule

**A preset is a starting bundle, not a container of abilities.**

"Wizard" names a body, some clothes, a wand, and a couple of skill points already spent. It
grants nothing on its own. Every capability comes from an item held or a skill taken, so the
moment a player drops the wand and picks up a sword, they swing it — with no code anywhere
asking what they picked at creation.

This is worth stating at the top because the alternative is what de-classing removed. The old
paladin *was* a capability container: its cast was an overhead sword
slam, so equipping a wand on that body played a fireball as a holy slam. The motion vocabulary
exists to prevent exactly that, and `act_slam_2h` — the neutral name coined so that gesture
could survive de-classing — turned out to have no clip, no caller, and no reason to exist.

The presets in the creation screen are a slot map and a grant list — a starting body, starting
equipment, and nothing else. Nothing more may accrue to them.

---

## The five steps

| # | Step | State |
|---|---|---|
| 1 | Animations in | Both libraries staged, 79 clips auditioned, 15 bound. Two routines run. Two mechanisms outstanding: the phased action and the chain. |
| 2 | Props and sets | 7 held props, 23 scenery, one GLB, six sets. Placement and grip are editable in the room and export as source. A garden is the notable gap. |
| 3 | Base male + female | Not started. `base-characters` is unpacked locally with `Base Characters` and `Hairstyles`. |
| 4 | Modular clothing | Not started. `outfits-fantasy` unpacked, 52 parts. Assembly builds on the content seam's `resolveBody` / prop-attach path (`client/src/content/`), not a separate avatar package. |
| 5 | Creation loop | Not started. Needs 3 and 4 for the real thing; see below for what does not. |

Step 1's remaining work is not "bind more clips." It is two mechanisms, and each unlocks a
batch:

- **The phased action** — enter, hold as long as the input is held, exit one of several ways.
  Eleven clips arrive in this shape (jump, ninja jump, slide, sit, channelled cast). The
  vocabulary implements it once, hardcoded, as `air_jump`/`air_fall`/`air_land`.
- **The chain** — an ordered run of attacks where continuing the input advances and releasing
  drops into a recovery. Two chains ship in the library: sword `A/B/C` with `_A_Rec`/`_B_Rec`,
  and unarmed `Jab`/`Cross`/`Hook` with `Hook_Rec`.

  A drill step can set `cancelAfter`, which opens the running action's recovery window on a
  timer so the next step cuts in rather than queues. That goes through
  `enterAbilityRecovery` — the same door gameplay would use — so it demonstrates that the
  joins are reachable and shows what they look like. It is not the mechanism. The drill holds
  the stopwatch and the times are written per step by hand; nothing in the content or
  controller layer knows that `Jab` has a successor. Building the chain means moving that
  knowledge inward: the ordered run becomes data, and advancing becomes a response to input
  rather than to a clock.

---

## The demo, and why it is not a detour

The proposal: a creation screen where picking a preset changes the room and plays that
preset's signature motions. Wizard channels a spell in the study; warrior runs a sword combo
at the training dummy; herbalist plants and waters.

It is worth doing now, before steps 3–5, for three reasons.

**It finishes the audition properly.** Judging eleven sword clips in a list is guesswork. The
props landed because you cannot judge a grip with an empty hand; the same argument applies one
level up — you cannot judge a combo without a target, or a farming clip without ground. The
scenes already exist and were arranged around clip families for exactly this reason.

**It is not blocked on the bodies.** Animation reads on a mannequin; that is the whole premise
of `docs/motion-vocabulary.md` ("every motion must read on a featureless mannequin"). The
demo can run on `body.humanoid` today and inherit the real bodies at step 3 for free.

**It is not throwaway.** A preset picker that sets a scene, a stance, and a motion loop is
structurally the creation screen. Step 5 replaces the mannequin and adds the customisation
controls; the selection and preview machinery is the same object.

### Where this stands

The drill room is that machinery, built for judging rather than for choosing. A `Drill` is
`id`, `label`, `note`, `sceneId`, `stance`, and an ordered list of steps; the room picks one,
loads its scene, wears its stance, fills the hands from its slots, and runs the steps on a
timer with manual stepping and scrubbing over the top. Two exist — sword-and-board in the
drill yard, unarmed in the sparring pit — and each brings its own room, because a weapon rack
standing in the corner of an unarmed routine quietly asks why the fighter is empty-handed.

That is the preset table and the motion cycler from the list below, arrived at from the other
direction. The open question is whether it stays two things or becomes one: a routine is
ordered for inspection, worst joins deliberately exposed, and a preview is ordered to flatter.
Those may be two orderings of one table or two tables that share a shape. It is not decided,
and the decision wants making before either grows further.

The content seam — `BODY_KEYS.humanoid`, `clipBindings.json`, the carved `dropin/` GLBs, the
band-masked controller — is no longer sandbox-and-drill-only: `client/src/game/PlayerBody.tsx`
resolves the same `BODY_KEYS.humanoid` body and the same motion keys for the live game as the
judging rooms do. There is no separate legacy avatar path left to migrate off of. What the
rooms still have that the game does not is the creation-screen layer described below: a preset
picker, alternate bodies, and modular clothing.

---

## Presets against what already exists

Every row below is buildable from clips and props already in the repository. "Needs" is the
only column that is work.

### Warrior — `training yard`

| | |
|---|---|
| Stance | sword + shield, composed per arm |
| Signature | `Sword_Regular_A` → `B` → `C`, with `_A_Rec` / `_B_Rec` |
| Supporting | `Sword_Block`, `Idle_Shield_Break`, `Shield_OneShot`, `Shield_Dash`, `Sword_Dash` |
| Props | sword, shield, axe |
| Scene | `drill-yard` — the dummy is placed 2.3 out so a swing has somewhere to travel |
| Routine | `warrior-sword-shield` — guard, move, strike, the combo string, defend, go down, get up |
| Needs | the chain |

### Wizard — `alchemist's study`

| | |
|---|---|
| Stance | `stance_staff` (left arm), until a wand prop exists |
| Signature | `Spell_Simple_Enter` → `Idle_Loop` → `Shoot`, or → `Exit` to cancel |
| Supporting | `OverhandThrow`, `Consume` |
| Props | staff (still procedural), potion, candlestick |
| Scene | exists — cauldron, bookcase, candles |
| Needs | the phased action |

### Herbalist — *garden, missing*

| | |
|---|---|
| Signature | `Farm_PlantSeed`, `Farm_Harvest`, `Farm_Watering` |
| Supporting | `PickUp_Table`, `Walk_Carry_Loop`, `Fixing_Kneeling` |
| Props | farm crate, sack, pot, cauldron — all imported |
| Scene | **needs one.** Buildable from props already in the kit |
| Needs | the scene; the clips are one-shots and need no mechanism |

### Smith — `forge`

| | |
|---|---|
| Signature | `Fixing_Kneeling` (5.2 s, the longest clip in either pack), `TreeChopping_Loop` |
| Supporting | `Push_Loop`, `Walk_Carry_Loop`, `Chest_Open` |
| Props | anvil, whetstone, workbench, axe |
| Scene | exists |
| Needs | nothing — this preset is demoable today |

### Scout — `training yard`

| | |
|---|---|
| Signature | `Roll`, `Slide_Start`/`Loop`/`Exit`, `ClimbUp_1m` |
| Supporting | `Crouch_Idle_Loop`, `Crouch_Fwd_Loop`, `Punch_Jab`/`Cross`/`Hook` |
| Props | sword as a dagger stand-in |
| Scene | `drill-yard`; the unarmed half of its vocabulary is judged in `sparring-pit` |
| Routine | `fighter-unarmed` covers the punches, the crouch loops and `Roll`. Nothing covers the slide or the climb. |
| Needs | crouch as a movement mode; dodge; the phased action for the slide |

### Wanderer — `tavern corner`

| | |
|---|---|
| Signature | `Sitting_Enter` → `Sitting_Idle_Loop` → `Sitting_Exit` |
| Supporting | `Consume`, `Idle_Talking_Loop`, `Emote_Dance_Loop`, `Emote_Point`, wave, thumbs up |
| Props | mug, potion |
| Scene | exists — the stool is placed *under* the body, which is what makes a sit judgeable |
| Needs | nothing — demoable today |

Two of six need nothing. Two need a mechanism already scheduled in step 1. One needs a scene
built from props already imported. That is the argument for starting now.

---

## What the demo needs that does not exist

1. **A preset table** — id, label, scene, stance, and an ordered list of motions to cycle.
   *Exists as `Drill`, in the wrong place.* It sits in `client/src/drill/`, which is the UI, and
   the intent is for the real thing to live next to whatever becomes the loadout authority for
   starting bundles (a `shared/*.json` row, on the model of `shared/actions.json`) rather than
   inside the drill UI. Two tables describing a starting bundle, in two layers, is the shape the
   one rule exists to prevent.
2. **A garden scene**, for the herbalist. Still missing, and still the only preset blocked on
   a set rather than on a mechanism.
3. **A motion cycler** — play this list of clips in order, looping, so a preset previews as a
   short performance rather than a single pose. *Exists as the drill's step runner*, with
   auto-advance, manual stepping, replay, speed, and a per-step width override. It advances on
   a dwell rather than looping, which is the difference between a routine and a preview.
4. **A wand prop.** Not in the Fantasy Props kit. The staff is still procedural too.
5. ~~**A fighting guard.**~~ *Solved without new content.* No clip in either library is a
   guard, but `Punch_Hook_Rec` ENDS in one: measured against `Idle_Loop`, its last frame has
   both forearms 92 and 100 degrees off idle while the legs, head and neck have already
   returned to it. `stance.unarmed` binds that clip and holds it at `'end'`.

   The mechanism is worth more than the stance. `freezeClipAt` takes one moment of a clip as a
   constant pose, so **any clip that passes through a pose worth holding is now a candidate
   stance** — which is a better answer than sourcing a clip per stance from a library that does
   not have them. Two rules came out of doing it:

   - Claim only the bands the pose holds. Unarmed takes `armL` and `armR` and leaves `core` to
     locomotion, so the chest and head keep breathing under a fixed guard. Taking `core` as
     well would give a mannequin — worth knowing, because sword and shield both take it.
   - A stance key may now name a clip that is not itself a stance. `motion.stance_unarmed`
     resolves to a punch recovery, and the `hold` is what makes it a pose.

Deliberately *not* required: the base characters, the outfits, any server change, or the game
migrating off the legacy avatar path.

---

## Suggested order

1. The preset table and the picker, on the mannequin, reusing the existing sets. *Largely
   standing, as the drill room.* What remains is the placement decision above — whether the
   table moves to `shared/` and the routines become one ordering of it — and routines for the
   presets that have none. Smith and Wanderer need no mechanism and are unwritten.
2. The garden scene. Herbalist joins.
3. The chain. Warrior joins, and eleven clips bind.
4. The phased action. Wizard and Scout join, and eleven more bind.
5. Base characters (step 3), which the picker inherits without changing.
6. Outfits (step 4), at which point the picker becomes the creation screen (step 5).

Steps 3 and 4 of the five-step plan land in the middle of this list rather than before it,
which is the point: the preview is what tells you whether the animation work is done, so it
should exist while that work is happening rather than after.
