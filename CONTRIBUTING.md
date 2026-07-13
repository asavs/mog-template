# Contributing

This repo uses pull requests as the working unit for humans and agents. Start with `AGENTS.md` for project context, then use this file for the day-to-day contribution loop.

## Before You Start

Read the docs that match the work:

- `AGENTS.md` for repo orientation, constraints, and access notes.
- `docs/dev-pipeline.md` for the branch, CI, review, beta deploy, feel-test, and merge pipeline.
- `server/GUIDELINES.md` before editing `server/`.
- `client/GUIDELINES.md` before editing `client/`.
- `docs/deployment-security-checklist.md` before changing Nginx, systemd, firewall, deploy scripts, secrets, or VM config.
- `docs/asset-storage.md` before changing large runtime assets or asset loading behavior.

Do not edit, stage, commit, or inspect `example code folder/vibe code game december`.

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
11. Let the beta deploy run after approval.
12. A human feel-tests beta and merges when satisfied.

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

The VM (`mog-server` in these docs) is the beta/prod runtime, not a development machine. Normal contributors and agents should not use it for day-to-day coding, Codex sessions, local builds, tmux workspaces, or dependency installation.

GitHub Actions builds and tests the project. Deploy workflows copy prebuilt artifacts to the VM, where the apply script publishes the server module and swaps static client files into the beta/prod web roots.

SSH into the VM only for explicit operations work such as service inspection, deploy debugging, reviewer daemon maintenance, disk cleanup, or infrastructure changes.

Runtime and reviewer state should stay separated:

| Path | Purpose |
|---|---|
| `/var/www/mog-beta` | Beta static web root. |
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

Starts the local beta-shaped app under `/beta/`. It uses the same local SpacetimeDB proxy and selects the beta database by base path.

```bash
npm run build
```

Builds the prod/root bundle for `/`.

```bash
npm run build:beta
```

Builds the beta bundle for `/beta/`.

Deploy workflows use the correct build mode in CI. Local dev scripts are for fast iteration; deployed beta/prod coherence is verified through GitHub Actions.

## Deployment Model

Beta and prod currently run on the same VM with separate SpacetimeDB databases and web roots:

| Environment | Database | Web root | Client base |
|---|---|---|---|
| Prod | `mog-game-v1` | `/var/www/mog` | `/` |
| Beta | `mog-game-beta` | `/var/www/mog-beta` | `/beta/` |

Preview deploys build the PR branch in GitHub Actions and deploy to beta after CI is green and the PR is approved. Prod deploys from `master` after merge.

Keep deploy configuration source-of-truth files under `deploy/` in sync with live VM config.

Disk cleanup on the VM should use `scripts/cleanup-runtime-artifacts.sh` or the matching `mog-runtime-cleanup.timer`. Do not manually delete `/var/www/mog-beta`, `/var/www/mog`, `/stdb`, reviewer checkouts, or reviewer state directories to recover space.

## Asset Changes

Small source assets can stay in Git. Large runtime assets should be considered carefully because they affect Git LFS checkout cost, CI artifact size, deploy time, and VM disk usage.

Before adding large models, animation packs, textures, audio, or generated terrain data, read `docs/asset-storage.md` and document the tradeoff in the PR.

## Permission Issues On The VM

If a command fails because repo files are owned by the wrong user, run:

```bash
bash ./scripts/fix-permissions.sh
```

The current Git hooks also attempt to run this after checkout and merge. If the hooks report `Permission denied`, the Git operation may still have succeeded; check `git status --short --branch` before retrying.
