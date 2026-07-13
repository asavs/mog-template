# Environment requirements

A tiny, zero-dependency preflight system that answers two questions before the
QA harness or a deploy script does real work:

1. **Does *this* machine have what a tool needs?** (a missing `gh`, an unauthed
   `gcloud`, Linux-native `node_modules` on Windows) — surfaced as a clear
   `why` + `remedy`, not a cryptic downstream `ENOENT`.
2. **Which tool runs in which environment at all?** — a derived
   tool × environment support matrix, never hand-maintained.

Everything a human or agent needs day to day is one command:

```sh
node tools/env-requirements/preflight.mjs --help
```

## Architecture

```
requirements.json ─┐
  requirements  ───┼─▶ preflight.mjs ─▶ checkRequirements  (probe THIS box now)
  tools         ───┤       (engine)  ─▶ fingerprintEnvironment (which cell am I?)
environments.json ─┘                 └▶ deriveSupportMatrix (tool × env, computed)
                                              │
                     docs/environment-requirements.md   (generated, drift-checked)
                     docs/environment-matrix.md         (generated, drift-checked)
```

- **Registry** — `requirements.json` holds two maps: `requirements` (the probe
  registry: each id's `why` / `remedy` / `probe` / `severity`, plus optional
  `platforms`) and `tools` (each runnable tool's `requires` id list).
- **Environments** — `environments.json` holds `environments`: one cell per
  place code runs (`windows-native`, `wsl`, `ci-runner`, `preview-vm`), each
  declaring the requirement ids it `capabilities`-satisfies.
- **Engine** — `preflight.mjs`, one file, **only Node built-ins** so it runs
  before (and without) any `npm install`. It is dual-use: a CLI and an
  importable module (`preflight.d.mts` types it for the TypeScript harness).
- **Fingerprint** — `fingerprintEnvironment()` decides which cell this process
  is in (env markers + platform, never throws).
- **Derived matrix** — a tool is supported in a cell **iff** every
  fail-severity requirement it needs is satisfiable there; requirements that do
  not apply to the cell's platform are vacuously satisfied. Both the
  `docs/environment-*.md` tables and the runtime "not supported in `<cell>`"
  verdicts are computed from the declarations.

## The one-declaration-axis principle

Each fact is declared exactly once; everything else is computed.

| Declared once | Where | Everything derived from it |
|---|---|---|
| a requirement (why/remedy/probe/severity) | `requirements.json` → `requirements` | check results, the requirements doc |
| what a tool requires | `requirements.json` → `tools.<id>.requires` | its per-environment support, its runtime preflight |
| what an environment can satisfy | `environments.json` → `<cell>.capabilities` | its column in the support matrix |

There is no hand-maintained "tool X works on Windows but not the preview VM"
list. Add a capability or a requirement and the matrix, the docs, and the
runtime verdicts all move together. Drift is impossible to commit: CI
regenerates both docs and fails on any diff, and the vitest suites
(`client/qa-harness/env-requirements.test.ts`, `env-matrix.test.ts`) assert the
committed docs match the renderers.

## Recipes

After any change that affects the tables, regenerate both docs (CI enforces this):

```sh
node tools/env-requirements/preflight.mjs --docs   > docs/environment-requirements.md
node tools/env-requirements/preflight.mjs --matrix > docs/environment-matrix.md
```

### Add a requirement

1. Add an entry to `requirements` in `requirements.json`:
   - `why` — the concrete failure if it's missing (what breaks, and how).
   - `remedy` — the exact command/steps to fix it.
   - `probe` — one of the declarative probe types (`binary-on-path`, `env-var`,
     `file-min-size`, `node-modules-platform`, `display-headed`,
     `not-plink-transport`, or the free-form `command-succeeds` escape hatch).
   - `severity` — `fail` (blocks the tool) or `warn` (surfaced, never blocks).
   - `platforms` (optional) — restrict it to e.g. `["win32"]`; elsewhere it is
     vacuously satisfied.
2. Add the id to the `requires` list of any tool that needs it, and to the
   `capabilities` of every environment that can satisfy it.
3. Regenerate the docs.
- **Test that catches you:** `env-requirements.test.ts` fails if `why`/`remedy`
  are empty or the probe type is unknown; `env-matrix.test.ts` fails if a
  `capabilities` id has no matching requirement, or if the committed docs drift.

### Add a tool

1. Add an entry to `tools` in `requirements.json` with a `label` and a
   `requires` list of requirement ids.
2. Wire the call site to preflight it by name — `checkTool('<id>')` in TS
   (see `client/qa-harness/run-harness.ts`) or
   `preflight.mjs --tool <id>` in shell (see `scripts/preview-up.sh`).
3. Regenerate the docs (the tool gets a matrix row automatically).
- **Test that catches you:** `env-matrix.test.ts` fails if `requires` is empty,
  references an unknown requirement, or if a tool is supported in **no**
  environment. It also pins the four stage-A tools' requirement lists, so a
  silent edit to a wired tool trips a test.

### Add an environment

1. Add a cell to `environments` in `environments.json` with `label`,
   `platform`, `description`, `capabilities`, and optional `notes`.
2. If a running process should fingerprint as this cell, add a detection branch
   to `fingerprintEnvironment()` in `preflight.mjs` — its id must match the
   cell id.
3. Regenerate the docs (the cell gets a matrix column automatically).
- **Test that catches you:** `env-matrix.test.ts` validates the cell's shape,
  requires every `capabilities` id to exist, checks every fingerprintable id
  has a declared cell, and re-checks doc drift.

## Fingerprint ids are a stable contract

`preflight.mjs --fingerprint` prints the current cell id. These ids are
**stable**: the planned per-environment QA baseline-profile system
([issue #27](https://github.com/asavs/mog-template/issues/27)) reuses each cell
id as the *environment half* of a baseline profile id, so a run captured on
`wsl` compares against the `wsl` baseline, not a `ci-runner` one. Renaming a
cell is therefore a breaking change there too — treat the ids as an API.
