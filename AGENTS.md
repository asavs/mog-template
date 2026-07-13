# Agent / Contributor Onboarding

This file is for anyone — human or AI agent — joining this project cold. Read this first, then follow the links.

---

## What This Project Is

A self-hosted template for a 3D multiplayer web game. The goal is a working authoritative multiplayer loop: players connect, send input, a server tick runs at 20-30 Hz, and everyone sees smooth synchronized movement.

It is a learning-first template, not a production game yet. The stack is intentionally minimal.

**Tech stack:**

| Layer | Technology |
|---|---|
| Hosting | Google Compute Engine (single VM) |
| Web server | Nginx (HTTPS, static files, reverse proxy) |
| Game server + DB | SpacetimeDB (authoritative, in-memory, realtime) |
| Server module | Rust (compiled to WASM, runs inside SpacetimeDB) |
| Frontend | Vite + React + TypeScript + Three.js + React Three Fiber |

---

## Current State

| Thing | Status |
|---|---|
| GitHub repo | `<owner>/mog-template` |
| GCP VM (`mog-server`) | Debian, `e2-small`; beta/prod runtime, not a development box |
| Nginx | installed, running, configured |
| SpacetimeDB 2.1.0 | installed, running as systemd service on `127.0.0.1:3000` |
| Rust / Node build tooling | not required for normal VM operation; GitHub Actions is the build environment |
| UFW firewall | active — allows 22, 80, 443 only |
| `server/` Rust module | implemented (tables, reducers, physics) |
| `client/` Vite app | implemented (rendering, input, interpolation) |
| Static IP | reserved (survives VM stop/start) |
| HTTPS / Certbot | not set up (GH issue #1) |

---

## Repo Layout

```
mog-template/
├── server/                        ← Rust SpacetimeDB module
│   ├── GUIDELINES.md              ← MANDATORY: Rules for SpacetimeDB & Rust
│   ├── spacetimedb/
│   │   ├── Cargo.toml
│   │   └── src/lib.rs             ← table definitions and schema
│   │   └── src/player_logic.rs    ← movement and physics logic
│   ├── spacetime.json             ← SpacetimeDB project config
├── client/                        ← Vite + React + TypeScript frontend
│   ├── GUIDELINES.md              ← MANDATORY: Rules for Three.js & Networking
│   └── src/
│       ├── main.tsx
│       └── App.tsx                ← main game entry point
├── deploy/                        ← canonical copies of VM config files
...
├── scripts/
│   ├── deploy.sh                  ← publish server, regenerate bindings, build/deploy client
│   ├── publish-server.sh          ← publishes the Rust module to local SpacetimeDB
│   ├── generate-bindings.sh       ← regenerates TypeScript bindings from the Rust module
│   ├── build-client.sh            ← builds Vite app and copies dist to /var/www/mog
│   ├── setup-dev.sh               ← configures hooks, permissions, and git safe-directory
...
├── docs/
│   ├── dev-pipeline.md                    ← branch → CI → review → beta → prod workflow
│   ├── asset-storage.md                   ← runtime asset storage and CDN/GCS migration plan
│   ├── pr-review-workflow.md               ← PR review workflow and checklist
│   ├── github-review-app.md                ← dedicated agent reviewer GitHub App setup
│   ├── reviewer-cron.md                    ← peer-account automated reviewer cron
│   ├── spacetimedb-threejs-architecture.md ← how the stack fits together
│   └── deployment-security-checklist.md    ← security rules to follow
├── tools/
│   └── env-requirements/                   ← zero-dep environment preflight (registry + engine)
│       ├── README.md                        ← architecture + add-a-requirement/tool/environment recipes
│       ├── requirements.json                ← requirement + tool declarations
│       └── environments.json                ← environment cells and their capabilities
├── CONTRIBUTING.md                ← day-to-day branch, PR, check, and deploy workflow
├── AGENTS.md                      ← this file
└── README.md
```

---

## 🧭 Deep Context for Agents

This project uses folder-specific guidelines to ensure technical accuracy:
- **If editing the Server:** You MUST read and follow `server/GUIDELINES.md`. It contains critical SpacetimeDB-specific Rust patterns.
- **If editing the Client:** You MUST read and follow `client/GUIDELINES.md`. It contains rules for Three.js rendering and snapshot interpolation.

---

## Access


### GitHub

Clone the repo, then follow the setup below:

```bash
git clone https://github.com/<owner>/mog-template.git
```

### GCP / SSH into the VM

**Account:** `<your-gcp-account>`
**Project:** `<your-gcp-project-id>`

```bash
gcloud auth login        # use your GCP account
gcloud config set project <your-gcp-project-id>
gcloud compute ssh mog-server --zone=<your-zone> --project=<your-gcp-project-id>
```

Note: `gcloud auth login` can leave you pointed at a different project from a prior session — run `gcloud config list` to confirm the active project before creating resources.

The VM is not the normal place to do feature work. Treat `mog-server` as the beta runtime and reviewer-daemon host: GitHub Actions builds artifacts, deploy workflows copy those artifacts to the VM, and the VM applies them. Do not start Codex sessions, run local builds, install development toolchains, or use tmux development sessions there unless you are doing an explicit VM operations task.

Canonical VM paths:

| Path | Purpose |
|---|---|
| `/var/www/mog-beta` | Beta static web root written only by deploy/apply automation. |
| `/stdb` | SpacetimeDB runtime, data, CLI, and shared config owned by the SpacetimeDB/deploy setup. |
| `/tmp/deploy-<sha>` | Transient artifact staging created by CI deploy jobs and removed after apply. |
| `/opt/mog-reviewers/<reviewer-user>` | Stable reviewer checkout for a peer-review daemon (one per reviewer identity). |
| `/home/<reviewer-user>/.mog-reviewer` | Current per-user reviewer daemon state/log directory. |

---

## Docs — Read in This Order

1. **`docs/spacetimedb-threejs-architecture.md`** — how the whole stack fits together. Start here.
2. **`CONTRIBUTING.md`** — day-to-day branch, draft PR, check, beta deploy, and merge workflow.
3. **`docs/dev-pipeline.md`** — the end-to-end automation pipeline (branch → CI → review → preview deploy → feel-test → merge → prod). Read before opening a PR.
4. **`docs/pr-review-workflow.md`** — issue/branch/PR review loop and audit checklist for reviewing work against concrete standards.
5. **`docs/reviewer-cron.md`** — setup for the peer-account automated reviewer cron.
6. **`docs/github-review-app.md`** — setup and permissions for a dedicated agent reviewer GitHub App or comment-only bot.
7. **`docs/asset-storage.md`** — runtime asset storage tradeoffs and GCS/CDN migration plan.
8. **`docs/deployment-security-checklist.md`** — security rules the Nginx config and reducers must follow.

---

## Working on Changes

All work — whether by a human or an LLM agent — happens on a feature branch off `master`. Do not commit directly to `master`.

**Branch names** describe the change with a short topical prefix:

- `feat/<short-description>` or `feat/issue-<N>` for new features
- `fix/<short-description>` or `fix/issue-<N>` for bug fixes
- `docs/<short-description>` for documentation-only changes
- `refactor/<short-description>` for non-behavioral code changes
- `chore/<short-description>` for tooling, dependencies, scripts

**Commits within a branch** can be as messy as needed — iterative, partial, debugging. The branch is a workspace.

**PRs squash-merge into `master`.** Each `master` commit is one logical change with one clean commit message describing the *why*, not a replay of the branch's debug history. The PR title and squash-merge message are what end up in `git log`.

**PRs open as drafts and stay draft while you iterate.** Use `gh pr create --draft` (or the "Create draft" button) when opening. CI runs on drafts so you can verify the build is green before inviting review. Once CI passes and the PR is ready for the peer-reviewer daemon, mark it `Ready for review` (`gh pr ready <num>`). If you need to substantially rework after that — major rewrites, restructured commits — flip back to draft (`gh pr ready <num> --undo`) until the rework lands.

The peer-reviewer daemon only reviews non-draft PRs. Draft status is the explicit signal that "I'm not asking for a review yet."

See `docs/dev-pipeline.md` for the full automation around this: what triggers CI, when the peer-reviewer daemon runs, when preview and prod deploys fire.

See `CONTRIBUTING.md` for the practical contributor checklist and local command guidance.

---

## Environment Requirements

Before running the QA harness or a preview deploy, confirm your environment has
what the tool needs — the preflight turns a missing `gh`/`gcloud`/WSL or
wrong-platform `node_modules` into a clear `why` + `remedy` up front:

```bash
node tools/env-requirements/preflight.mjs --tool qa-harness-local   # or preview-up, etc.
node tools/env-requirements/preflight.mjs --fingerprint             # which environment am I in?
node tools/env-requirements/preflight.mjs --help                    # all flags
```

The QA harness (`client/qa-harness/run-harness.ts`) and the preview scripts
(`scripts/preview-up.sh`, `scripts/preview-down.sh`) already run this by tool
name, so an agent usually sees the verdict without invoking it. Which tool runs
in which environment is the derived matrix in
[`docs/environment-matrix.md`](docs/environment-matrix.md); each requirement's
why/remedy is in [`docs/environment-requirements.md`](docs/environment-requirements.md).
Both are generated — edit the declarations in `tools/env-requirements/`, never
the docs. See [`tools/env-requirements/README.md`](tools/env-requirements/README.md)
for the architecture and the recipes.

## Important Constraints

- CI is the authoritative full-build signal. Do not run local full builds by habit, especially on the VM where disk is tight.
- Do not use `mog-server` for day-to-day development. It should only run beta services, apply CI-built artifacts, and host the reviewer daemons.
- Before committing code changes, run focused checks that are directly useful for the change. On `mog-server`, `./scripts/generate-bindings.sh`, `./scripts/publish-server.sh`, `./scripts/build-client.sh`, and `./scripts/deploy.sh` are acceptable verification/deployment tools when they are specifically warranted.
- For client changes, prefer targeted tests first. Run a local production build only when it is directly useful, when debugging CI/build failures, or when a risky client change needs a local bundle signal before pushing.
- Prefer adding focused headless gameplay/regression scripts, like `client/test-reconnect.ts`, when a change affects networked gameplay behavior that is hard to validate from unit tests alone.
- SpacetimeDB **always** binds to `127.0.0.1:3000` — never `0.0.0.0`
- Nginx handles all public traffic — port 3000 is never opened in the firewall
- The `spacetimedb` system user owns `/stdb` — nothing else writes there
- No secrets in Vite env vars — anything prefixed `VITE_` is visible to players
- The `deploy/` folder contains canonical copies of live config files — keep them in sync when you edit `/etc/nginx/` or `/etc/systemd/` on the VM
- Do not edit, stage, commit, or inspect `example code folder/vibe code game december`; it is only a storage folder for sample code.

---

## What To Build Next

The VM and minimal multiplayer loop are complete. Remaining tasks:

1. **Infrastructure:** Run Certbot for HTTPS (GH issue #1). The static IP is already reserved.
2. **Gameplay:** Add more complex mechanics (combat, inventory, world state).

Before going live: run Certbot for HTTPS (see GH issue #1).

## ⚠️ PERMISSIONS NOTICE
If you see "Permission Denied" errors after a git pull or creating new files, run:
`bash ./scripts/fix-permissions.sh`
