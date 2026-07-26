# Shared data

Canonical, hand-authored source files consumed by codegen on both the client and server. Never
hand-edit a `*.generated.*` output — edit the JSON here and regenerate.

## `actions.json`

The **action-pipeline authority**: every action def, slot binding, and resource def, shared by
client and server. After editing, regenerate:

```bash
cd client && npm run gen:actions
# check without writing: npm run gen:actions:check
```

Generates `server/spacetimedb/src/actions/defs.generated.rs` and
`client/src/actions/defs.generated.ts`. Full field-by-field contract in
[`docs/action-pipeline.md`](../docs/action-pipeline.md).

## `arena.json`

The world's collision contract: bounds, spawn points, and collider rows (`box` / `cylinder`),
consumed identically by `client/src/sim/ground.ts` and `server/spacetimedb/src/collision.rs` so
client prediction and server authority resolve collision the same way. Visual geometry
(`client/src/world/arenaArchitecture.ts`) may be anything; these rows are what both simulations
agree on. Regenerate after editing:

```bash
cd client && npm run gen:arena
# check without writing: npm run gen:arena:check
```

## `fixtures/`

Golden test fixtures shared across languages — e.g. `movement-trace.json`, replayed by
`client/src/sim/movement.trace.test.ts` to check the TypeScript prediction path stays within
tolerance of a recorded trace. Not codegen input; hand-author or capture these directly.

## Content (rig, motions, props)

The drop-in/procedural content seam — not shared JSON, but the other half of "what both client
and server agree a body/motion/prop is" — lives at
[`client/src/content/ART_DROP_IN.md`](../client/src/content/ART_DROP_IN.md).
