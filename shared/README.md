# Shared data

## `avatar-loadout.json`

Canonical **loadout authority** for the game (presets, items, grants, body ids, baseline grants, legacy class map).

- Client presentation (mesh paths, clips, socket TRS) stays in `client/src/avatar/catalog.ts`.
- After editing this file, regenerate:

```bash
node scripts/gen-avatar-loadout.mjs
# or: cd client && npm run gen:loadout
```

That writes:

- `client/src/avatar/loadoutAuthority.generated.ts`
- `server/spacetimedb/src/loadout_authority.generated.rs`

Do not hand-edit the generated files. See `client/src/avatar/ART_DROP_IN.md`.

**Add a new item end-to-end:** [`docs/avatar-add-item.md`](../docs/avatar-add-item.md) (authority → codegen → presentation → optional preset seed).
