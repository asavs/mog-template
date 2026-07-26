# Content drop-in (for humans & agents)

Engine contract for the content seam: how a body, a motion, or a prop gets from a file on
disk (or from placeholder code) onto a character. Companion to `docs/character-pipeline.md`
(the roadmap this seam serves) and `docs/motion-vocabulary.md` (naming and layering rules for
motions specifically).

## The seam, in one picture

Every piece of content — a body, a motion clip, a held prop, a scenery piece — is addressed by
a stable logical **key** (`body.humanoid`, `motion.act_swing_1h`, `prop.sword`), never by a file
path. Game code asks `content/resolve.ts` for a key and gets back the same runtime shape no
matter where the bytes came from:

- `resolveBody(key)` → `{ root, skeleton, bones, referenceHeight }`
- `resolveMotion(key)` → `THREE.AnimationClip | null`
- `resolveProp(key)` → `THREE.Object3D | null`

Resolvers never throw and never reject on missing or broken content — they warn to the console
and return `null`. A key with no source degrades to nothing rather than crashing the scene, and
a granted ability must never be gated on its animation having loaded. Swapping placeholder code
for a real asset is a **binding change**, not a code change, and nothing downstream of a
resolver may branch on whether it got procedural or real content.

The vocabulary of keys lives in `keys.ts`. Adding a new motion, prop, or scenery item is a new
entry there — never a class, spell, or character name (see `docs/motion-vocabulary.md` §1 for
why).

## Resolution order (`manifest.ts`)

For any key, in order:

1. **A `dropin/` file whose basename matches the key** — an artist's override wins.
2. **An explicit entry in `CONTENT_MANIFEST`** — a deliberate pin, for content that does not fit
   the drop-in naming convention (one object inside a multi-object pack; see "Multi-object
   packs" below).
3. **A procedural generator registered under the key** (`registry.ts`) — the placeholder.
4. **Nothing** — the key is unbound; callers degrade gracefully.

Delete a drop-in file and the previous source (usually the procedural placeholder) comes back.
No code change either way. The sandbox's seam panel (`npm run sandbox`) lists every known key,
which source it currently resolves to, and whether that's a drop-in file or still a placeholder.

## Drop-in: adding a real asset

Put a file under `client/src/content/dropin/` named after the key it replaces, plus `.glb`,
`.gltf`, or `.fbx`:

```text
dropin/body.humanoid.glb            replaces the procedural mannequin
dropin/motion.act_swing_1h.glb      replaces the procedural sword swing
dropin/motion.stance_unarmed.glb    replaces the procedural guard stance
dropin/prop.staff.glb               replaces the placeholder stick
```

Picked up on the next dev-server reload — Vite globs `dropin/**/*.{glb,gltf,fbx}` at build
time (`import.meta.glob`). Subfolders under `dropin/` are for humans; binding is by basename
alone, so a flat layout works identically to a nested one.

**Motion files** should contain a single take. The resolver picks a clip by name — the motion
id itself (`act_swing_1h`, not the key's `motion.` prefix) — falling back to the file's only
clip if there's exactly one and warning if there are several with no name match. Never picked
by index: shared libraries hold many named clips, and an index silently plays the wrong one.

**Body/rig files** must use the `mog_humanoid` bone names (canonical table in `rig.ts`).
Quaternius/UE5-style names (`pelvis`, `spine_01`, `upperarm_l`, …) and legacy Mixamo-style names
(`mixamorigRightHand`, …) are also recognized via `boneNameCandidates`. Anything else will not
bind — three.js silently drops an animation track whose target bone doesn't exist, so a
mis-spelled bone plays as a moving torso above a dead limb, with nothing in the console.

**Scale** is world units, 1 = 1 metre. `resolveBody` normalizes any imported body to
`MOG_REST_POSE.referenceHeight` (2.0 m) automatically — see `resolve.ts`'s `normalizeHeight`,
which measures actual skinned/mesh geometry (never a stray light or helper an exporter left in)
and rescales, refusing implausible factors rather than guessing. Motions and props are *not*
auto-scaled: author them against the 2.0 m rest pose in `restPose.ts` so they line up.

## Multi-object packs (`CONTENT_MANIFEST`)

Some content doesn't fit "one file per key" — the Fantasy Props kit ships 20+ props and scenery
pieces in a single GLB because its textures are trim sheets shared across every object in it;
splitting them into separate files would embed the same sheet dozens of times. `manifest.ts`
pins each of those keys to `{ kind: 'file', url: <the pack>, objectName: <node name> }`.

Node names inside that pack are the content keys with dots swapped for underscores
(`prop.sword` → `prop_sword`), so no separate mapping table exists and none can go stale — but
the swap itself is load-bearing: three.js runs glTF node names through
`PropertyBinding.sanitizeNodeName`, which strips dots, so a node literally named `prop.sword`
would arrive as `prop_sword` anyway and a naive key→node lookup would miss it. Built by
`tools/prop-import/import.mjs`.

Drop-in still wins over a manifest pin — replacing one prop from a 20-object pack is a single
`dropin/prop.sword.glb` file, with the other 19 objects untouched.

## Procedural placeholders (`registry.ts`, `procedural/`)

Placeholder content is code, not files. `registerBodyGenerator` / `registerMotionGenerator` /
`registerPropGenerator` register a function under an id; by convention a generator registered
under a key *is* that key's default (step 3 of resolution above). Procedural bodies are boxes
and capsules parented to `mog_humanoid` bones, authored against `restPose.ts`; procedural
motions emit bone rotation tracks by canonical bone name, authored against the same rest pose,
which is what lets a placeholder motion and a placeholder body agree with each other for free.

Some keys are procedural **permanently**, not as a placeholder waiting on art — no strafe or
backpedal exists in either staged animation library, so `loco_walk_l` and its siblings are
generated, and no staff exists in the Fantasy Props kit, so `prop.staff` is generated. See
`docs/animation-audition.md` for the full inventory of what's bound, what's still placeholder,
and why.

## Rig aliasing (`rig.ts`)

The canonical rig id is `mog_humanoid`. Its bone **ids** (`hips`, `rightUpperArm`, …) are the
stable contract every consumer — sockets, VFX spawns, anim events — refers to; its bone
**names** follow whatever spelling the art actually ships, which today is UE5 Mannequin
spelling (`pelvis`, `spine_01`, `upperarm_r`, …), because that's what the Quaternius animation
libraries, base characters, hairstyles, and props all use. A neutral in-house spelling was tried
first and abandoned: aliasing a bone *name* tells you where a bone is, but an animation *track*
target is a name too, and nothing rewrites track names, so a procedural clip authored against
the neutral spelling silently dropped 19 of 20 tracks the moment a real UE5-named body loaded.
Older Mog-spelled and Mixamo-spelled assets are still recognized at lookup time via
`boneNameCandidates` — that mechanism works for *finding* a bone by any of its known spellings,
which is a different (and safe) use from authoring a track name against one spelling and hoping
it matches another.

## Sockets and grips (`sockets.ts`)

Props are authored in a canonical frame — origin at the grip, +Y toward the business end
(blade point, staff tip, bottle mouth), +Z out the "front" face — and know nothing about hands.
`sockets.ts` holds the grip transform (position + rotation, per prop per socket) that rotates
that authoring frame into `rightHand` / `leftHand`. A prop that sits wrong in the hand is fixed
by editing three numbers in that table, not by hunting through mesh code. These numbers are
currently calibrated for the UE5/Quaternius rig specifically — rig aliasing matches bone names
across skeletons, not bone *orientations*, so a grip is not yet portable to an arbitrarily
different rig without recalibration.

## Stances (`stances.ts`)

A stance is a held pose composed from clips that each claim a named **band** of the rig
(`core`, `armL`, `armR` — see `docs/motion-vocabulary.md` §2 for the full band model), so
sword-and-board can be built from a sword pose (right arm) and a shield pose (left arm) without
either clip needing to be an authored pair. `freezeClipAt` takes one moment of any clip — not
necessarily a clip that is itself a "stance" — as a constant pose; `motion.stance_unarmed`
resolves to a punch-recovery clip held at its last frame, because that frame is a passable
fighting guard and no clip in either animation library is one outright.

## Checking what is bound

`npm run sandbox` opens the clip/prop browser: every known key, the source it currently
resolves to (dropin / manifest / procedural / unbound), and every clip in every staged pack
whether or not anything binds to it yet. `npm run drill` runs a fixed routine through a body
wearing a real stance and props, to judge whether a *set* of bindings holds together end to end
— a judgement no single clip in the sandbox can make on its own. Both are documented in
`docs/character-pipeline.md`.

## What we do not need from art

- Per-class walk/run folders — motions are named for the gesture, never the class
  (`docs/motion-vocabulary.md` §1).
- A full unique mesh per armor/prop combination.
- Mixamo specifically — any retarget-to-`mog_humanoid` pipeline is fine; Mixamo naming is
  recognized for legacy packs only.
