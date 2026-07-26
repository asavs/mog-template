# Motion Vocabulary

The reference set of character motions, what each must communicate, and the rules for
authoring new ones. Engineers implement playback from this; animators (and procedural
placeholder generators) author to it. Companion to `client/src/content/ART_DROP_IN.md`
(rig and asset pipeline) and `docs/action-pipeline.md` (server action phases).

## 1. The principle

**A motion belongs to an ability or to locomotion — never to a character class.**

A body is a skeleton (`mog_humanoid`) plus a skin. It contributes proportions and
appearance, nothing else. What a character *does* is defined by abilities, and each
ability names the gesture that performs it. Any body holding a wand casts a fireball
with the same hurl; any body holding a sword swings it with the same arc.

The failure this prevents: a per-class animation set where "cast" on one body is an
overhead sword slam and on another an open-palm throw. Equip a wand on the first body
and a fireball plays as a holy slam — the motion was keyed to the class fantasy, not to
the thing being performed. Under this vocabulary that cannot happen, because there is no
"paladin cast"; there is only the fireball ability, which requests `act_hurl_1h`.

Corollaries:

- Motions are named for the **gesture and its mechanics**, not for a spell, class, or
  character (`act_hurl_1h`, never `paladin_cast` or `fireball_anim`).
- Ability → motion is **many-to-one**. Fireball and lightning may share one hurl; they
  differ in projectile, VFX, and timing data, not in skeleton motion.
- Every motion must read on a featureless mannequin. If it needs a cape, a face, or a
  particular weapon mesh to make sense, it is not vocabulary — it is decoration.

## 2. The vocabulary

Summary. Durations are targets at 1.0 playback rate; contact beats are contractual
(section 4), the rest is guidance.

| Motion            | Reads as                          | Layer      | Loop     | Length    |
|-------------------|-----------------------------------|------------|----------|-----------|
| `loco_idle`       | Alive, waiting                    | Full body  | Loop     | 3–4 s     |
| `loco_walk_*`     | Unhurried travel                  | Full body  | Loop     | ~1.0 s    |
| `loco_run_*`      | Committed speed                   | Full body  | Loop     | ~0.65 s   |
| `air_jump`        | Effort leaving the ground         | Full body  | One-shot | ~0.25 s   |
| `air_fall`        | Suspended, braced                 | Full body  | Loop     | ~0.8 s    |
| `air_land`        | Weight arriving                   | Full body  | One-shot | ~0.3 s    |
| `act_hurl_1h`     | Gathering, then throwing energy   | Overlay    | One-shot | ~0.9 s    |
| `act_swing_1h`    | A weapon cutting through space    | Overlay    | One-shot | ~0.9 s    |
| `act_guard_hold`  | Braced wall, deliberate           | Overlay    | Hold     | enter+loop|
| `act_drink`       | Consuming, briefly vulnerable     | Overlay    | One-shot | ~1.4 s    |
| `stance_*`        | At ease, holding a loadout        | Upper band | Loop     | 2.5–3.5 s |
| `react_hit`       | Impact received                   | Overlay    | One-shot | ~0.35 s   |
| `react_death`     | Final, irreversible collapse      | Full body  | One-shot | ~1.5 s    |

### Bands, and why an overlay has two widths

The rig splits into five disjoint **bands**:

| Band    | Bones                              | Normally driven by         |
|---------|------------------------------------|----------------------------|
| `lower` | Hips, both legs, both feet         | locomotion, always         |
| `mid`   | Spine, Spine1                      | locomotion                 |
| `core`  | Spine2, Neck, Head                 | stance / action / reaction |
| `armL`  | Left clavicle, arm, hand, fingers  | stance / action / reaction |
| `armR`  | Right clavicle, arm, hand, fingers | stance / action / reaction |

Every clip is filtered to a band set before it plays, and the sets in play at any
moment never overlap. That is what lets overlays blend normally instead of
additively: no bone is ever driven by two actions, or by none.

The arms are separate bands because the poses we import are one-armed. A shield
pose raises the left arm and leaves the right where idle put it; the cast clips
are entirely left-handed and every sword clip is entirely right-handed. Splitting
lets one held pose be **composed** from two clips, one per arm — which is the only
reason sword-and-board exists, since no clip in the library is both.

`core` is what cannot be split. Spine2, neck and head are shared, so they go to
exactly one claimant — by convention whichever pose is the more committed, since
the torso was authored to support it.

An overlay claims one of two widths:

- **`torso`** = `mid` + `upper`. The action owns everything from the pelvis up.
- **`arms`** = `upper` only. The lower spine stays with locomotion.

**The width follows from movement, not from taste.** An action that roots you gets
`torso`, because nothing else needs the spine and the extra lean is what sells the
weight. An action you can walk through gets `arms`, because a gait's counter-rotation
lives in the lower spine and an overlay that takes it makes the legs read as
belonging to someone else.

Every overlay motion must also look correct played full-body on a standing
character — standing is the base case, the overlay is the optimization.

### Movement is one number

An ability declares `movement`: the fraction of normal move speed it permits, `0`
(rooted) to `1` (free). Gameplay scales the move speed by it. The animation layer
picks the mask width from it. **It is deliberately the same number**, because a
value that says "you may walk" and a mask that says "the legs are mine" cannot be
allowed to disagree, and the cheapest way to guarantee that is to not have two
values.

This has a consequence for authoring, and it is the reason it is stated here rather
than in code: **a motion with `movement > 0` must be authored to read on top of
somebody else's walk.** No weight shift you cannot see the legs doing, no hip drive,
no big torso rotation. If a gesture genuinely needs the whole body to read — a dodge
roll — then it roots you, and that is a design decision about the ability, made
deliberately, not a rendering accident.

If a narrow mask would leave a clip with no tracks at all, the width widens instead
of the motion vanishing. An action that plays as nothing is worse than an action
that fights the gait a little.

### Stances

A **stance** is a looping pose over the upper bands that stands in for locomotion's
own upper body for as long as a loadout is equipped. It is not a gait, and this is
the whole point: equipping a staff changes idle, walk, and run at once. The
alternative — a gait set per weapon — multiplies every new weapon by every direction
and speed, and is the kind of content debt that stops people adding weapons.

A stance may be composed from several clips, each naming the bands it holds, so a
pose per arm covers every combination of what is in each hand without a clip per
pair. Bands must not repeat within one stance. Whatever a stance does not hold —
because no part covers it, or because an action claimed that arm — stays with
locomotion rather than falling to the bind pose.

A stance is authored knowing the pelvis and lower spine belong to somebody else. It
never widens to `torso`; a background pose that fought every gait it was worn over
would be worse than no pose.

Two exist today: `stance_staff` and `stance_sword_shield`. A stance travels with the
loadout that implies it — which prop goes in which hand is part of the same
decision as the pose.

### Locomotion

**`loco_idle`** — full-body loop. The character is alive: slow breathing sway in the
spine (±2–3°), a subtle weight shift once per loop. Never a frozen pose — a static
mannequin reads as a bug, not a character. Blends in/out with a 0.2 s crossfade.

**`loco_walk_*`** — full-body loop, two full steps per cycle. Relaxed arm swing
opposing the legs, mild counter-rotation between shoulders and hips (~15°). Cadence is
the read: even, unhurried.

**`loco_run_*`** — full-body loop, two steps, roughly 0.65 s. The read comes from
commitment: torso leans forward 10–15°, arm swing doubles, hips rise and fall visibly.
Walk and run must be distinguishable by silhouette alone at a glance — lean and
amplitude, not just speed.

**Direction.** Eight discrete variants per gait (`_f`, `_b`, `_l`, `_r` for walk and
run), selected from movement direction relative to facing; no angular blending at this
tier. Rules that keep the set coherent:

- The **torso faces the aim direction** in all variants; only the legs and a small hip
  turn encode travel direction. Strafing must not turn the chest.
- Strafes are lateral steps at the forward cadence (cross-step or shuffle, either is
  fine, pick one for both sides). Left may be a mirror of right.
- Backpedal is the forward cycle reversed in leg phase with ~80 % stride — visibly more
  cautious than forward, same cadence family.
- Foot cadence should track ground speed. Placeholder tier accepts foot slide, but the
  step rhythm must match: cycle seconds ≈ stride meters ÷ speed (m/s). Footstep audio
  keys off the playing clip, so wrong cadence is audible as well as visible.

Gait changes (idle↔walk↔run, direction changes) crossfade at 0.15–0.2 s.

### Air

Jump is three motions so the airborne phase can stretch with real physics rather than
one fixed-length clip guessing the hang time.

**`air_jump`** — one-shot takeoff. Anticipation crouch (hips drop ~0.15 m on the 2.0
reference height, knees bend ~40°) for ~0.1 s, then explosive extension, arms driving
upward. Enters with a fast 0.08 s blend; hands off to `air_fall` when extension peaks.

**`air_fall`** — loop while airborne (both jump apex and walking off a ledge). Legs
slightly tucked, arms out for balance, gentle 2–3° sway so it stays alive. Never plays
on the ground.

**`air_land`** — one-shot on ground contact. Knees absorb (30–40° bend), torso dips,
then recover to neutral. Interruptible: locomotion input cancels the recovery half
immediately. Blends out at 0.15 s.

### Abilities

Beat times are offsets from motion start. The **contact beat** is where the gameplay
effect happens (projectile spawns, damage lands) and must line up with the ability's
server timing — see section 4.

**`act_hurl_1h`** — ranged spell release from the casting hand. Upper-body overlay,
one-shot, ~0.9 s.

| Beat    | Time      | Pose                                                            |
|---------|-----------|-----------------------------------------------------------------|
| Windup  | 0 → 0.35  | Casting hand pulls back past the shoulder, spine twists away ~30°, off-hand guards forward. Energy is *gathered*. |
| Release | ~0.4      | Fast forward thrust — hand snaps from behind the shoulder to full extension toward aim in ≤0.1 s. Contact beat: projectile leaves the hand at full extension. |
| Recover | 0.5 → 0.9 | Arm settles, spine untwists, back to base pose.                 |

The read is *push away from the body along the aim line*. Enter blend 0.08 s; recover
is interruptible by another cast (chain-casting re-enters at windup).

**`act_swing_1h`** — one-handed weapon arc. Upper-body overlay, one-shot, ~0.9 s.

| Beat    | Time       | Pose                                                           |
|---------|------------|----------------------------------------------------------------|
| Windup  | 0 → 0.35   | Weapon hand cocks up and across the body, shoulders wind opposite the coming arc (~45° counter-twist). |
| Strike  | 0.35 → 0.45| Horizontal (slightly descending) arc through the front 180°, ≤0.1 s. Contact beat at the arc's center, directly ahead. |
| Recover | 0.45 → 0.9 | Follow-through past the body, then return.                     |

The read is *lateral arc* — deliberately perpendicular to the cast's forward thrust so
the two are never confusable in silhouette. Enter blend 0.08 s; recover interruptible
by the next swing.

**`act_guard_hold`** — active block. Upper-body overlay, enter + held loop + exit.

- **Enter** (~0.12 s): arms snap up, guard item (or forearms) squared in front of the
  chest, elbows out, stance compresses slightly. Speed *is* the read — a block that
  eases in reads as a failed block.
- **Hold** (loop): braced and compact, with micro-sway so it stays alive. Legs remain
  free for slow movement.
- **Exit** (~0.25 s): relaxed drop back to base, matching the block-recovery window
  during which the player cannot act.
- On successfully absorbing a hit: a sharp 2–4 frame backward shove of the guard arms,
  recovering within the hold — a compressed `react_hit` that never leaves the loop.

**`act_drink`** — consume a held item. Upper-body overlay, one-shot, ~1.4 s. Hand
raises item to the head, head tilts back — the tilted head against a raised elbow is
the silhouette — hold ~0.5 s, then lower. Deliberately slow and *not* interruptible-
looking: its cost is the vulnerability window, and the motion must advertise it.

### Reactions

**`react_hit`** — damage taken (non-fatal). Upper-body overlay, one-shot, ~0.35 s: a
sharp 10–15° spine flinch away from neutral within 2–3 frames, then ease back. Must
never steal leg control or interrupt an in-flight ability motion — it layers on top,
additively if supported, else briefly winning the upper-body mask. Skippable under
rapid repeated hits (retrigger, don't queue).

**`react_death`** — full-body one-shot, ~1.5 s, clamps on its final frame. A staggered
collapse: impact recoil → knees buckle → fall. The final pose must read as *down* from
every camera angle — fully horizontal, limbs settled, no pose a living character ever
holds. Highest playback priority; nothing interrupts it, it interrupts everything.

## 3. Readability at placeholder fidelity

The first implementation of every motion is procedural, on a segmented mannequin —
boxes/capsules parented to `mog_humanoid` bones, no skinning, no face, no fingers, no
cloth. These rules are what make motion read anyway. They are also simply good
animation; real art inherits them.

1. **Silhouette first.** Every key pose must read as a flat black shape. Test by
   imagining the mannequin unlit in profile: windup, contact, and recovery must be
   distinguishable from each other and from idle by outline alone. If a pose only
   reads because of a color or an effect, re-pose it.
2. **One dominant axis per ability.** Cast thrusts forward (sagittal), melee arcs
   sideways (transverse), guard squares up (static frontal), drink goes vertical.
   Never give two abilities the same dominant silhouette change.
3. **Anticipation must be long enough to register: ≥ 150 ms** (9 frames at 60 fps),
   moving *opposite* the action. The release itself should be fast (≤ 100 ms) — the
   eye reconstructs fast actions from their anticipation and follow-through, so those
   two carry the read, not the blur between.
4. **Exaggerate rotations ~1.5× natural.** Without skin deformation, joint rotation is
   the only signal. Spine twists of 10° vanish; use 30°+. Walk arm-swing ±45° at the
   shoulder; run ±70°. When in doubt, push until it looks too much in isolation — in
   gameplay at distance it will look right.
5. **Rotation over translation.** Bones may only rotate (plus hips translating for
   crouch/jump/collapse). Never translate a limb bone to reach a pose — segments
   visibly detach on an unskinned rig.
6. **Weight lives in the hips.** Every effortful action starts with a hip drop or
   shift. Jump crouches before it rises; the swing's hips lead the shoulders; landing
   compresses. A mannequin with static hips reads as a puppet on a rod.
7. **Counter-rotation sells force.** Shoulders wind against hips (≥ 20° differential)
   before any throw or swing, and release through. This one rule does more for a crude
   rig than any amount of arm detail.
8. **Moving holds.** Any held pose (idle, guard, fall) gets ±2–3° of slow sway. Frozen
   frames read as a hang, not a hold.
9. **Ease curves, not linear keys.** Pose-to-pose with slow-out of anticipation and
   sharp snap into contact. Linear interpolation is the single loudest "programmer
   art" tell; even two-key motions get an easing function.
10. **Timing contrast between motions.** If every motion is ~0.9 s with the same
    windup fraction, the set blurs together. Guard is near-instant, drink is slow,
    death is heavy; protect those differences.

## 4. Ability-authored motion contract

A new ability declares its motion as data. This is the whole mechanism that keeps
motion body-agnostic: the ability states *what the gesture is and when its beats land*,
and any conforming body performs it.

An ability author **must define**:

| Field           | Meaning                                                              |
|-----------------|----------------------------------------------------------------------|
| `motion`        | A vocabulary motion id (reuse first; add a new gesture only if no existing one reads correctly). |
| `layer`         | `full` or `upper` — whether legs stay under locomotion control.      |
| `windup_s`      | Motion start → contact beat. Drives both the server's active tick and the clip's contact placement. One number, one source of truth. |
| `recover_s`     | Contact → able to act again. Matches the server recovery window.     |
| `hold`          | For sustained abilities (guard): enter/loop/exit structure instead of windup/recover. |
| `socket`        | Which attachment the gesture is performed with: `right_hand`, `left_hand`, `both`, or `none`. |
| `movement`      | `can_move` / `can_rotate` per phase, mirroring the server action-state flags. |
| `interruptible` | What may cancel recovery (next use of same ability, any action, nothing). |

The clip is authored so its contact beat sits at `windup_s` at 1.0 playback rate.
**Never reconcile a timing mismatch with a runtime time-scale** — re-author the clip or
change the ability data. Scaled playback desynchronizes anticipation from gameplay and
is how animation timing rots.

An ability author **must NOT assume**:

- **A specific body.** Only the `mog_humanoid` bone set and the normalized 2.0
  reference height exist. No bone lengths, no proportions, no finger bones.
- **A class fantasy.** No "this is the paladin version." If a gesture only makes sense
  for one character concept, it is mis-designed — describe the mechanics instead.
- **A weapon mesh.** The gesture moves a socket; whatever is attached comes along.
  A stick, a sword, and nothing at all must all look intentional.
- **Handedness.** Author for the declared socket; the system may mirror.
- **Exclusive playback.** Upper-body gestures run over arbitrary locomotion; a gesture
  that only works from a standstill must declare `layer: full` and lock movement.

## 5. Naming scheme

Logical motion ids, snake_case (repo-wide rule), pattern:

```
<family>_<gesture>[_<qualifier>]
```

| Family   | Covers                         | Examples                                    |
|----------|--------------------------------|---------------------------------------------|
| `loco`   | Ground movement                | `loco_idle`, `loco_walk_f`, `loco_run_l`    |
| `air`    | Airborne                       | `air_jump`, `air_fall`, `air_land`          |
| `act`    | Anything an ability performs   | `act_hurl_1h`, `act_swing_1h`, `act_drink`  |
| `stance` | Held poses for a loadout       | `stance_staff`, `stance_sword_shield`       |
| `react`  | Involuntary responses          | `react_hit`, `react_death`                  |

The family names the **layer**, not the fiction. There is deliberately no `cast`
family, and no separate `melee` or `use`: drawing a bow, priming a grenade, downing
a potion and channelling a spell are the same problem for a skeleton, and "cast" is
a word one game system happens to use for one of them. A vocabulary that encodes a
fiction has to be renamed the first time the fiction changes.

Qualifiers describe mechanics: direction (`_f/_b/_l/_r`), grip (`_1h/_2h`), variant
number (`_a/_b`) for authored variety. Nothing else.

Rules:

- **Never a character, class, or pack name in a motion id.** `paladin_slash` and
  `wizard2_magic_attack` are source-asset filenames at most; the moment a clip enters
  the game it is `act_swing_1h` / `act_hurl_1h`.
- **Never a specific ability's name in a motion id.** `fireball` is an *ability*
  id (loadout authority); its motion is `act_hurl_1h`. This is what lets fireball and
  lightning share a gesture without either owning it.
- The motion id **is** the clip name inside the GLB. Shared libraries
  (`animations/locomotion.glb`, `animations/combat.glb`) hold many named clips;
  loaders must select clips by name, never by index.
- Legacy action keys map forward as: `idle→loco_idle`, `walk/run(+dir)→loco_*`,
  `jump→air_jump`, `slash→act_swing_1h`, `block→act_guard_hold`, `cast→act_hurl_1h`,
  `drinking→act_drink`, `death→react_death`. `react_hit`, `air_fall`, and `air_land`
  are new vocabulary with no legacy equivalent.
