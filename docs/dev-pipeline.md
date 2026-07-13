# Development Pipeline Plan

## Goal

Automate everything an LLM agent can verify on its own, so the only manual step is a human feel-test in the browser on the live VM. An LLM should be able to take an issue, write code on a branch, get automated build and test results, get an automated peer review, and request a preview deploy — all without the human SSH'ing into anything. The human's role is the final gate: log in, play it, decide whether to merge.

For the practical contributor checklist and local commands, see `CONTRIBUTING.md`. This document explains the automation model and the reasoning behind it.

## The pipeline

| Step | Action | Owner | Trigger |
|---|---|---|---|
| 1 | Pick issue or cluster from backlog | LLM or human | — |
| 2 | Create feature branch | LLM | `git checkout -b feat/issue-N` |
| 3 | Write code, commit | LLM | `git commit && git push` |
| 4 | Get build + test results | CI (GitHub Actions) | push to any branch |
| 5 | Iterate until green | LLM | repeat 3–4 |
| 6 | Open pull request | LLM | `gh pr create` |
| 7 | Automated peer review runs | peer-reviewer daemon | PR opened/updated |
| 8 | Iterate on review feedback | LLM | repeat 3–7 |
| 9 | Approval spins up an ephemeral preview VM `mog-pr-<N>` | CI | reviewer approval + CI green |
| 10 | Human plays the announced preview URL in browser | human | manual |
| 11 | Merge/close → preview VM torn down; prod deploy is scaffolded off | human, then CI | `gh pr merge --squash` |

The merge is the human's "ship it" decision: it means "I feel-tested this on the preview VM and it's good." Prod deploy on merge is **scaffolded but off** by default (there is no always-on prod host yet); see [`prod-enable.md`](prod-enable.md) for the flip-switch. A `workflow_dispatch` trigger on `preview-up.yml` can fire a preview deploy manually if the approval auto-trigger is ever missed.

## Architectural choice: ephemeral preview VMs, no always-on game host

> **Naming note:** final public names can still change when the game has a real name. The current preview database name is `mog-game-preview`; prod would be `mog-game-v1`.

**Decision (plan v1 decisions A–J): there is no always-on game host while there are no players.** The old shared-beta path on `mog-server` (a single `mog-game-beta` root) is retired. Instead, an approved PR gets its own short-lived VM.

After CI green + a trusted approval, `preview-up.yml` creates or reuses at most **three** concurrent `e2-micro` VMs named `mog-pr-<N>`, boots a lean SpacetimeDB + nginx runtime (`scripts/preview-bootstrap.sh`), deploys the client + WASM with a **cleared world** (`--delete-data`), and upserts one PR comment announcing `{ pr, sha, vm, url, deployedAt, machineType }`. A new approved commit **redeploys the same VM** in place. `preview-down.yml` deletes the VM on merge/close, and a 30-minute GC sweep reaps any VM whose PR is closed or that is past its **3-hour TTL**. Config knobs (`MACHINE_TYPE`, `PREVIEW_MAX_CONCURRENT`, `PREVIEW_TTL_HOURS`, `ZONE`, `PREVIEW_DB_NAME`) live in repo variables with script-level fallback defaults; the full design is in `docs/preview-vm-factory-plan-v1.md`.

## Build order — five steps

### Step 1 — Adopt feature-branch + squash-merge convention

LLM work happens on a feature branch (e.g., `feat/issue-42`, `fix/...`, `docs/...`). PRs squash-merge to master so each master commit is one logical change with a clean message.

- No code, no infra.
- Update `AGENTS.md` to document the convention.
- Adopt immediately on the next task.

### Step 2 — CI build workflow

`.github/workflows/ci.yml` triggered by `push` and `pull_request`. Runs on `ubuntu-latest` (free hosted runner). Installs Rust toolchain and Node, then:

- `cargo build --release` in `server/spacetimedb/`
- `npm ci && npm run build` in `client/`
- Caches `~/.cargo`, `~/.rustup`, and `node_modules` to keep runs under ~2 minutes.

Output: red/green check on each commit and PR. No deployment, no secrets, no VM access. ~60 lines of YAML.

Unblocks pipeline steps 4 and 5 (LLM can iterate against a build signal without SSH'ing into the VM).

### Step 3 — Integration tests against live SpacetimeDB

Headless tests (`cargo test`, `npm test`) landed alongside step 2 in PR #62. This step covers the remaining test scripts that need a running SpacetimeDB instance:

- `client/test-reconnect.ts` (`npm run test:reconnect:local`)
- `client/test-combat-action-state.ts` (`npm run test:combat-action:local`)

Adds a third CI job that installs the SpacetimeDB CLI, starts a standalone instance on `127.0.0.1:3000`, publishes the server module to `mog-game-v1`, then runs the regression scripts against it. The instance is torn down with the runner.

Maps to issues #51 (Rust unit tests with mocks — partly addressed by the headless `cargo test`) and #44 (automated perf regression — future addition once the integration harness is stable). Grows over time as more headless gameplay scripts are added — "approaching LLM playability" means continually moving more verification from the human's feel-test into CI.

### Step 4 — Deploy automation (ephemeral previews + scaffolded prod)

**`preview-up.yml`** — triggers on `pull_request_review` (state: approved) plus `workflow_dispatch`. Cheap gates run first (PR open, not draft, trusted approver association or allowlisted bot, **fork PRs rejected**, CI green on head SHA); only then does it build the client + WASM and call `scripts/preview-up.sh` to create-or-reuse `mog-pr-<N>`, publish to `mog-game-preview` with a cleared world, and upsert the announce comment. `preview-down.yml` handles teardown (PR close, manual dispatch) and the scheduled TTL/orphan GC.

**`prod-deploy.yml`** — triggers on push to master, but is **gated on `vars.PROD_DEPLOY_ENABLED == 'true'`** and skipped by default. It builds the root bundle with `npm run build`, publishes to `mog-game-v1`, and syncs the prod web root via `scripts/apply-artifacts.sh`. See `prod-enable.md` to turn it on.

Build-then-apply order (compile and bundle first, publish and swap only if the build succeeded) keeps the skew-safe property from #16.

Requirements: Workload Identity Federation secrets for GitHub Actions to reach GCP, plus (for previews) instance create/delete permission on the deploy service account.

Maps to issues #2 (deploy automation) and #16 (skew-safe order).

### Step 5 — Branch protection on master

GitHub repo setting (Settings → Branches → Branch protection rules for `master`):

- Require pull request before merging
- Require status check to pass: the CI build job from step 2
- Require approval: the peer-reviewer daemon (or a human reviewer when one is around)
- Block direct pushes

No code. Prevents accidental bypass of the pipeline.

## Issue mapping

| Issue | Step | Notes |
|---|---|---|
| #2 Automate Deployment | 4 | Covered by `preview-up.yml`/`preview-down.yml` (on approval / close) and scaffolded `prod-deploy.yml` (on merge, flag-gated) |
| #16 Deploy version skew | 4 | Preview script enforces build-before-publish |
| #44 Perf regression testing | 3 | Add as one of the CI test jobs |
| #51 Rust unit testing suite | 3 | First test job after `cargo build` succeeds |
| #15 VM doc clarity | 1 | AGENTS.md update touches this |

## Non-goals

- **Deploying without a feel-test.** Preview provisioning is gated on a trusted reviewer approval + CI green; the human only merges after feel-testing the announced preview URL. Skip neither.
- **Local Windows development.** SpacetimeDB CLI is Linux-only; CI handles the Linux builds, the VM remains the only place server code actually runs. WSL2 is a possible future productivity upgrade, not part of this pipeline.
- **Production hardening.** TLS (#1), static IP (#3), nginx route restrictions (#11), `wss://` (#12) are tracked separately. This document covers dev workflow only.
- **Always-on prod / shared beta in this project.** No always-on game host while there are no players; prod deploy is scaffolded off (`prod-enable.md`) and the shared `mog-server` beta path is retired in favor of ephemeral `mog-pr-<N>` previews.
- **Schema migration automation.** When a PR changes the SpacetimeDB schema, the prod-deploy may need a migration step before publishing the new module. Out of scope for the initial pipeline; revisit before there is user state on `mog-game-v1` worth preserving.
