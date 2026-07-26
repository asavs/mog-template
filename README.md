# MOG Template

A self-hosted, learning-first template for a 3D multiplayer web game: SpacetimeDB (Rust) as the
authoritative server, Three.js/React (Vite) as the client, one generic data-driven pipeline for
every combat/ability action, and a content seam that lets placeholder art and real art bind to
the same logical keys.

The goal is a small, honest multiplayer loop — connect, move, fight — built so that adding a
new ability or a new piece of content is a data row, not an engine change.

## Project structure

```text
mog-template/
├── server/spacetimedb/      # Rust SpacetimeDB module — tables, reducers, the tick loop
├── client/                  # Vite + React + Three.js app
│   ├── src/actions/         # Generated action defs + gameplay gates
│   ├── src/anim/            # Band-masked AnimationController
│   ├── src/content/         # The content seam — see ART_DROP_IN.md
│   ├── src/drill/           # Routine-testing room (npm run drill)
│   ├── src/game/            # The actual game entry
│   ├── src/sandbox/         # Clip/prop browser (npm run sandbox)
│   ├── src/sim/             # Client-side prediction: movement, ground collision
│   └── src/presentation/    # Server state → animation bridge
├── shared/                  # actions.json / arena.json — codegen input for both sides
├── tools/                   # Codegen (gen-actions, gen-arena) + env-requirements preflight
├── deploy/                  # Production config (Nginx, systemd)
├── scripts/                 # Deploy and local-VM scripts
└── docs/                    # See docs/README.md for the index
```

## The action pipeline

One generic pipeline expresses every combat/ability primitive. Adding an action is a **row in
`shared/actions.json`**; adding a new *kind* of effect (damage, heal, displacement, …) is
**one match arm** in `server/spacetimedb/src/actions/effects.rs`. Nothing else in the system
branches on an action id — not the client, not the animation bridge, not the input layer.

```bash
cd client
npm run gen:actions          # regenerate both sides' typed defs from shared/actions.json
npm run gen:actions:check    # CI-style: fail if the generated files are stale
```

Full wire contract — phases, hold modes, effect kinds, the phase machine — in
[`docs/action-pipeline.md`](docs/action-pipeline.md).

## Input: 8 primitives

The whole input surface is 8 rows of data (`client/src/input/keymap.ts`): movement (WASD),
camera/aim (mouse), jump (Space), `primary` (LMB — tap/hold resolves light vs. heavy),
`block` (RMB, hold), `roll` (Left Shift), `ability1`–`ability5` (1–5), and `potion` (R).
Rebinding — including unbinding jump or binding sprint, which is on the wire but unbound by
default — is a row edit in `keymap.ts`, never a code change.

## Content: drop-in art, procedural fallback

Every body, motion clip, and prop is addressed by a stable key (`body.humanoid`,
`motion.act_swing_1h`, `prop.sword`) that resolves to either a real asset dropped into
`client/src/content/dropin/` or a procedural placeholder — the same runtime shape either way, so
swapping art for a placeholder is a file add/delete, never a code change. Full contract,
including the rig/bone-name aliasing that makes UE5-spelled, Mixamo-spelled, and legacy-spelled
skeletons all bind: [`client/src/content/ART_DROP_IN.md`](client/src/content/ART_DROP_IN.md).
Motion naming/layering rules: [`docs/motion-vocabulary.md`](docs/motion-vocabulary.md).

## Running it

### Server (SpacetimeDB)

```bash
cd server
spacetime publish   # publish the module to a local SpacetimeDB instance
```

### Client — three entry points

```bash
cd client
npm install
npm run dev       # the actual game, at /
npm run sandbox    # clip/prop browser — every content key, every source, bound or not
npm run drill      # routine room — run a fixed sequence on a body wearing real stances/props
```

`npm run dev:beta` / `npm run build:beta` build the same client under a `/beta/` base path, for
local parity with how a preview deploy is served — see
[`docs/dev-pipeline.md`](docs/dev-pipeline.md) for when a preview VM actually gets one.

## Tests

```bash
cd client
npm run test        # Vitest — unit + integration, no live SpacetimeDB needed
npm run build        # tsc -b && vite build — the authoritative type/bundle check
```

```bash
cd server/spacetimedb
cargo test           # Rust unit tests
```

On Windows, run the Rust suite through WSL rather than natively (the SpacetimeDB toolchain is
Linux-first here):

```bash
wsl -- bash -lc "cd /mnt/c/path/to/repo/server/spacetimedb && cargo test"
```

CI is the authoritative full-build signal (`.github/workflows/ci.yml`): server build + tests,
client build + tests + generated-file drift checks, a live-SpacetimeDB integration smoke, and a
structural browser playtest. See [`docs/dev-pipeline.md`](docs/dev-pipeline.md) for the full
branch → CI → review → preview-deploy → merge loop, and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the day-to-day checklist.

## Docs

Start with [`docs/README.md`](docs/README.md) for the full index. Highlights:

- [`docs/action-pipeline.md`](docs/action-pipeline.md) — the action wire contract.
- [`docs/motion-vocabulary.md`](docs/motion-vocabulary.md) — animation naming/layering rules.
- [`docs/character-pipeline.md`](docs/character-pipeline.md) — where character content is
  headed, and what's already real.
- [`docs/spacetimedb-threejs-architecture.md`](docs/spacetimedb-threejs-architecture.md) — how
  the stack fits together, written for someone new to realtime multiplayer.
- [`AGENTS.md`](AGENTS.md) — onboarding for anyone (human or agent) joining cold.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — branch/PR/check workflow.

## Credits

Built on the [vibe-coding-starter-pack-3d-multiplayer](https://github.com/majidmanzarpour/vibe-coding-starter-pack-3d-multiplayer)
by [Majid Manzarpour](https://github.com/majidmanzarpour), licensed under the MIT License. See
[NOTICE](NOTICE) for the full attribution and original license text.
