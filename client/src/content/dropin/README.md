# Drop-in content

Put an asset file here named after the content key it replaces, and it takes
over that key on the next dev-server reload. Delete it and the previous source
(usually a procedural placeholder) comes back. No code change either way.

```
dropin/motion/motion.action.magic_cast.glb   replaces the cast motion
dropin/motion/motion.locomotion.walk.glb     replaces the walk cycle
dropin/prop/prop.staff.glb                   replaces the placeholder staff
dropin/body/body.humanoid.glb                replaces the mannequin
```

## Rules

- **Filename must equal the key**, plus `.glb`, `.gltf`, or `.fbx`.
  Keys are listed in `../keys.ts`. A filename that matches no key is ignored.
- **Motion files** should contain a single take; the first clip is used.
- **Rigs** must use the `mog_humanoid` bone names (see `../../avatar/rig.ts`).
  Mixamo-style names are also accepted. Anything else will not bind.
- **Scale** is world units, 1 = 1 metre, against the rest pose in
  `../restPose.ts` (a 1.8 m figure). Author to that and props line up.

Subfolders are for humans — binding is by filename alone, so the layout above is
convention rather than requirement.

## Checking what is bound

The animation sandbox shows every key, the source it resolved to, and whether
that source is a drop-in file or still a procedural placeholder.
