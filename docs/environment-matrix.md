# Environment support matrix

<!-- GENERATED FILE — do not edit by hand.
     Source of truth: tools/env-requirements/requirements.json (requirements + tools)
                      tools/env-requirements/environments.json (cells + capabilities)
     Regenerate:      node tools/env-requirements/preflight.mjs --matrix > docs/environment-matrix.md
     CI fails if this file drifts from the declarations (.github/workflows/ci.yml). -->

Which tool runs where — DERIVED, never hand-maintained. There is ONE
declaration axis: each environment declares the requirement ids it can
satisfy (`capabilities` in environments.json) and each tool declares the
requirement ids it needs (`requires` in requirements.json). A tool is
supported in an environment iff every fail-severity requirement it needs
is satisfiable there; requirements that do not apply to an environment's
platform (e.g. win32-only ones on Linux) are vacuously satisfied. ⚠ marks
warn-severity gaps: the tool runs there, with the documented hazard.

Detect which environment you are in (the same ids will double as the
environment profile ids for the planned per-environment QA baselines,
issue #27):

```sh
node tools/env-requirements/preflight.mjs --fingerprint
node tools/env-requirements/preflight.mjs --tool preview-up
```

See [`tools/env-requirements/README.md`](../tools/env-requirements/README.md)
for the architecture and how to add a tool or an environment, the
per-requirement `why`/`remedy` reference in
[`environment-requirements.md`](environment-requirements.md), and where this
preflight fits the deploy flow in [`dev-pipeline.md`](dev-pipeline.md).

| tool | `ci-runner` | `preview-vm` | `windows-native` | `wsl` |
|------|---|---|---|---|
| `preview-down` | ✓ | ✗ missing: `gcloud-cli`, `gcloud-auth` | ✓ | ✓ |
| `preview-up` | ✓ | ✗ missing: `gcloud-cli`, `gcloud-auth`, `lfs-real-assets` | ⚠ warns: `openssh-not-plink` | ✓ |
| `qa-harness-local` | ✓ | ✗ missing: `headed-display` | ✓ | ✓ |
| `qa-harness-pr` | ✓ | ✗ missing: `gh-cli`, `gh-auth` | ✓ | ✗ missing: `gh-cli`, `gh-auth` |

## Environments

- **`ci-runner`** — GitHub Actions (ubuntu-latest). Hosted CI runner — gh and gcloud preinstalled, gh auth via GITHUB_TOKEN, gcloud auth via Workload Identity Federation, headed Chromium via xvfb-run. _No GPU: headed Chromium renders via SwiftShader, so CI runs structural checks only (see ci.yml's browser-playtest job)._
- **`preview-vm`** — Preview VM (lean Debian runtime). The ephemeral mog-pr-<N> deploy TARGET — runs SpacetimeDB + nginx and nearly nothing else; deploys are pushed TO it, tools are not run FROM it. _The SpacetimeDB CLI lives under /stdb (owned by the spacetimedb user), not on the SSH user's PATH; there is no git checkout, node, gh, or gcloud on the box._
- **`windows-native`** — Windows host (PowerShell / Git Bash). The Windows dev machine itself — where the QA harness, gh, and gcloud normally run. _gcloud's ssh transport here is PuTTY/plink, so heredoc-over-ssh deploy steps break (openssh-not-plink is unsatisfiable on this host); the SpacetimeDB CLI is Linux-only and lives inside WSL instead of on this PATH._
- **`wsl`** — WSL2 Ubuntu. The Ubuntu distro under WSL2 on the dev machine — hosts the harness's isolated SpacetimeDB and is the documented OpenSSH path for manual preview deploys. _gh is not installed here — PR-targeting flows run from the Windows host or CI. headed-display needs WSLg or an exported DISPLAY._
