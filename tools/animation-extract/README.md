# animation-extract

Turns an upstream animation library into the per-key GLBs that live in
`client/src/content/dropin/`.

This exists so the assets in the repo have provenance. Without it, `dropin/` is a
pile of binaries nobody can regenerate, re-pick, or re-cut — and the first time
someone wants a different clip for `act_slam_2h` they are back to an afternoon of
rediscovery.

Deliberately its own package: it is a one-off authoring step, not a build
dependency, and nobody cloning the game should pay to install it.

## Source

[Quaternius Universal Animation Library 1 and 2](https://quaternius.com/packs/universalanimationlibrary2.html),
CC0. Take the `Unreal-Godot/*.glb` files, and the one **without** the `_RM`
suffix — `_RM` has root motion baked in, and our controller expects the game's
physics to move the character, so baked root motion fights it and slides.

## Run

```sh
npm install
node extract.mjs <UAL1.glb> <UAL2.glb> <output-dir>
cp <output-dir>/*.glb ../../client/src/content/dropin/
```

Which clip serves which key is the `BINDINGS` table at the top of `extract.mjs`.
Change a line there and re-run to re-pick a gesture.

## What it does

- keeps one animation per output, renamed to our motion id, so the file is
  self-describing and the seam finds it by name
- strips the mannequin from motion files — they animate a body, they are not one
- emits `body.humanoid.glb` separately: mesh and skeleton, no animation

Roughly 16 MB of source becomes ~3.2 MB across 16 files, which keeps `dropin/`
inside the budget enforced by `dropin.budget.test.ts`.

## Gotcha

Disposing a `gltf-transform` Animation orphans its channels and samplers but does
**not** release the accessors they hold. Dispose channels and samplers explicitly
first, or every "one clip" file comes out the size of the entire library — which
is exactly what happened the first time.
