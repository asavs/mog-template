# Contributing

This repo uses pull requests as the working unit for humans and agents. Start with `AGENTS.md` for project context, then use this file for the day-to-day contribution loop.

## Before You Start

Read the docs that match the work:

- `AGENTS.md` for repo orientation, constraints, and access notes.
- `docs/dev-pipeline.md` for the branch, CI, review, preview deploy, feel-test, and merge pipeline.
- `server/GUIDELINES.md` before editing `server/`.
- `client/GUIDELINES.md` before editing `client/`.
- `docs/deployment-security-checklist.md` before changing Nginx, systemd, firewall, deploy scripts, secrets, or VM config.
- `docs/asset-storage.md` before changing large runtime assets or asset loading behavior.

## Branch And PR Flow

1. Sync `master`.
2. Create a focused branch from `master`.
3. Make the smallest coherent change.
4. Run the relevant checks for the changed area.
5. Commit and push.
6. Open a draft PR.
7. Wait for CI.
8. Patch until CI is green.
9. Mark the PR ready for review.
10. Address review feedback.
11. A trusted approval + green CI spins up an ephemeral preview VM (`mog-pr-<N>`) for the PR.
12. A human feel-tests the announced preview URL and merges when satisfied.

Branch names should describe the change:

- `feat/<short-description>` for features.
- `fix/<short-description>` for fixes.
- `docs/<short-description>` for docs-only changes.
- `refactor/<short-description>` for non-behavioral code changes.
- `chore/<short-description>` for tooling and maintenance.

PRs should start as drafts. The peer-reviewer daemon only reviews non-draft PRs, so draft status means the author is still iterating.

## PR Body

Include:

- What changed.
- Why it changed.
- Player, contributor, or operator impact.
- Checks run.
- Known gaps or follow-up work.
- Screenshots or recordings for visible client changes when useful.

For docs-only PRs, link and command accuracy checks are enough.

## Checks

CI is the authoritative full-build signal. Do not run local full builds by habit, especially on the VM where disk is tight. Run local builds when they are directly useful for the change, when debugging a failure, or when the repo guidelines for that area make the local signal worth the cost.

Use focused checks first:

- Documentation-only changes: `git diff --check`.
- Client unit behavior: from `client/`, run `npm run test`.
- Client full bundle check: from `client/`, run `npm run build` or `npm run build:beta` when needed.
- Server module changes: from `server/spacetimedb/`, run the relevant Rust build or tests.
- Generated bindings: run `./scripts/generate-bindings.sh` when server schemas or reducers change.
- Local publish verification: run `./scripts/publish-server.sh` when validating server publish behavior on the VM.

If a relevant check is skipped, explain why in the PR body.

## Environment Requirements

The QA harness and the preview-deploy scripts preflight their environment before
doing real work, so a missing tool surfaces as a clear `why` + `remedy` instead
of a cryptic downstream error. To check your own machine:

```bash
npm run env:check -- --tool qa-harness-local   # from client/; or any tool id
node tools/env-requirements/preflight.mjs --tool preview-up   # from repo root
node tools/env-requirements/preflight.mjs --fingerprint       # which environment am I?
```

`--tool <name>` reports every requirement that tool needs plus a derived
"is this tool supported here?" verdict; `--fingerprint` names the environment
cell you're in. The full picture lives in two generated docs —
[`docs/environment-requirements.md`](docs/environment-requirements.md) (each
requirement's why/remedy) and
[`docs/environment-matrix.md`](docs/environment-matrix.md) (which tool runs in
which environment) — both derived from declarations in `tools/env-requirements/`.
See [`tools/env-requirements/README.md`](tools/env-requirements/README.md) for
the architecture and how to add a requirement, tool, or environment.

## VM Usage Policy

`mog-server` (referenced in these docs) is the prod runtime — scaffolded but off by default, see
`docs/prod-enable.md` — and the reviewer-daemon host, not a development machine. PR review runs
against its own short-lived preview VM instead (`mog-pr-<N>`, one per approved PR, torn down on
merge/close — see `docs/dev-pipeline.md`); there is no persistent shared beta host. Normal
contributors and agents should not use `mog-server` for day-to-day coding, Codex sessions, local
builds, tmux workspaces, or dependency installation.

GitHub Actions builds and tests the project. Deploy workflows copy prebuilt artifacts to the
target VM (preview or prod), where the apply script publishes the server module and swaps in
the static client files.

SSH into a VM only for explicit operations work such as service inspection, deploy debugging,
reviewer daemon maintenance, disk cleanup, or infrastructure changes.

Runtime and reviewer state should stay separated:

| Path | Purpose |
|---|---|
| `/var/www/mog` | Prod static web root (on `mog-server`, when prod deploy is enabled). |
| `/stdb` | SpacetimeDB runtime and data. |
| `/tmp/deploy-<sha>` | Temporary CI artifact staging. |
| `/opt/mog-reviewers/<reviewer-user>` | Per-reviewer daemon checkout. |
| `/home/<reviewer-user>/.mog-reviewer` | Current per-user reviewer daemon state/logs. |

## Client Development Modes

From `client/`:

```bash
npm run dev
```

Starts the local root-shaped app at `/`. The Vite dev server proxies `/v1` to local SpacetimeDB on `127.0.0.1:3000`.

```bash
npm run dev:beta
```

Starts the local beta-shaped app under `/beta/`. It uses the same local SpacetimeDB proxy and selects the `mog-game-beta` database by base path (`client/src/environment.ts`) — useful for exercising the base-path-aware code paths locally; no deployed environment currently serves this build.

```bash
npm run build
```

Builds the prod/root bundle for `/`.

```bash
npm run build:beta
```

Builds the beta bundle for `/beta/`. No deploy workflow currently ships this build; it exists
for local base-path testing. CI's own builds use the root/prod bundle (`npm run build`), with
`VITE_STDB_DB_NAME` overridden per-target where needed (see below).

## Deployment Model

There is no persistent beta environment. PR review runs against an ephemeral preview VM
(`mog-pr-<N>`) instead:

| Environment | Database | Lifetime |
|---|---|---|
| Preview (`mog-pr-<N>`) | `PREVIEW_DB_NAME` (defaults to `mog-game-v1`), a fresh world per deploy | Created on trusted approval + green CI; redeployed in place on new commits; torn down on merge/close or after its 3-hour TTL |
| Prod (`mog-server`) | `mog-game-v1` | Always-on when enabled (scaffolded off by default — `docs/prod-enable.md`); deploys on push to `master` |

Full model, including the ADR-style decision log for why previews are ephemeral rather than a
shared always-on box, in `docs/dev-pipeline.md`.

Keep deploy configuration source-of-truth files under `deploy/` in sync with live VM config.

Disk cleanup on the VM should use `scripts/cleanup-runtime-artifacts.sh` or the matching `mog-runtime-cleanup.timer`. Do not manually delete `/var/www/mog`, `/stdb`, reviewer checkouts, or reviewer state directories to recover space.

## Asset Changes

Small source assets can stay in Git. Large runtime assets should be considered carefully because they affect Git LFS checkout cost, CI artifact size, deploy time, and VM disk usage.

Before adding large models, animation packs, textures, audio, or generated terrain data, read `docs/asset-storage.md` and document the tradeoff in the PR.

## Permission Issues On The VM

If a command fails because repo files are owned by the wrong user, run:

```bash
bash ./scripts/fix-permissions.sh
```

The current Git hooks also attempt to run this after checkout and merge. If the hooks report `Permission denied`, the Git operation may still have succeeded; check `git status --short --branch` before retrying.
