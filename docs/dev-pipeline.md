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
| 9 | Auto-deploy to `mog-game-beta` for feel-test | CI | reviewer approval + CI green |
| 10 | Human plays beta in browser | human | manual |
| 11 | Merge to master → auto-deploy to `mog-game-v1` | human, then CI | `gh pr merge --squash` |

The merge is the human's "ship it" decision: it means "I feel-tested this on beta and it's good." Merging then auto-deploys to `mog-game-v1`. Master never runs unvetted code because nothing reaches prod without passing through the feel-test on beta. A `workflow_dispatch` trigger is also wired up so the preview deploy can be fired manually if ever needed.

## Architectural choice: two SpacetimeDB databases on one VM

> **Naming note:** final public names can still change when the game has a real name. The current database names are `mog-game-beta` and `mog-game-v1`.

**Decision: `mog-game-beta` (preview) and `mog-game-v1` (prod) on the same VM. Sequential PR previews, master always running.**

`mog-game-v1` runs whatever was last merged. `mog-game-beta` runs whatever PR is currently being feel-tested. The client picks which database to connect to from the served base path. Both databases share the same VM resources but are independent state.

Only one PR can be on `mog-game-beta` at a time. GitHub Actions' `concurrency` group is set so a newer preview deploy cancels any older in-flight one — whichever PR was most recently approved is what's live on beta.

**Upgrade path:** per-PR ephemeral databases (`mog-pr-60`, `mog-pr-61`, …) become worthwhile when (a) the VM is upgraded beyond e2-small so concurrent SpacetimeDB instances don't risk OOM, and (b) PR volume is high enough that parallel feel-testing is actually needed. Neither is true today.

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

### Step 4 — Two-environment deploy automation

Two workflows, both SSH into the VM and run `scripts/apply-artifacts.sh`.

**`preview-deploy.yml`** — triggers on `pull_request_review` (state: approved) when CI is green, plus `workflow_dispatch` as a manual fallback. Builds the PR's branch in CI with `npm run build:beta`, then publishes the WASM to `mog-game-beta` and copies the `/beta/` client bundle to the beta web root. A `concurrency` group ensures newer preview deploys cancel older in-flight ones.

**`prod-deploy.yml`** — triggers on push to master (i.e., when a PR merges). Same flow, but builds the root bundle with `npm run build`, publishes to `mog-game-v1`, and syncs the prod web root.

Both scripts use the same build-then-apply order (compile and bundle first, publish and swap only if the build succeeded) — the skew-safe property from #16 is baked in.

Requirements: Workload Identity Federation secrets for GitHub Actions to reach GCP, plus two SpacetimeDB databases provisioned on the VM (`spacetime` supports multiple named databases on one instance). Client config must stay aware of which database to connect to for `/` versus `/beta/`.

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
| #2 Automate Deployment | 4 | Covered by both `preview-deploy.yml` (on approval) and `prod-deploy.yml` (on merge) |
| #16 Deploy version skew | 4 | Preview script enforces build-before-publish |
| #44 Perf regression testing | 3 | Add as one of the CI test jobs |
| #51 Rust unit testing suite | 3 | First test job after `cargo build` succeeds |
| #15 VM doc clarity | 1 | AGENTS.md update touches this |

## Non-goals

- **Deploying without a feel-test.** Auto-deploys are gated on reviewer approval (`mog-game-beta`) and on merge (`mog-game-v1`). The merge gate exists because the human only merges after feel-testing on beta. Skip neither.
- **Local Windows development.** SpacetimeDB CLI is Linux-only; CI handles the Linux builds, the VM remains the only place server code actually runs. WSL2 is a possible future productivity upgrade, not part of this pipeline.
- **Production hardening.** TLS (#1), static IP (#3), nginx route restrictions (#11), `wss://` (#12) are tracked separately. This document covers dev workflow only.
- **Per-PR ephemeral databases.** Single `mog-game-beta` is the explicit choice for the current VM size and PR volume. Upgrade path documented above.
- **Schema migration automation.** When a PR changes the SpacetimeDB schema, the prod-deploy may need a migration step before publishing the new module. Out of scope for the initial pipeline; revisit before there is user state on `mog-game-v1` worth preserving.
