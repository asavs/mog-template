# Environment requirements

<!-- GENERATED FILE — do not edit by hand.
     Source of truth: tools/env-requirements/requirements.json
     Regenerate:      node tools/env-requirements/preflight.mjs --docs > docs/environment-requirements.md
     CI fails if this file drifts from the registry (.github/workflows/ci.yml). -->

Each row is a declarative environment probe the QA harness and deploy
scripts check before doing real work, so a missing tool surfaces as a
clear `why` + `remedy` instead of a cryptic downstream error. Check any
subset from the CLI:

```sh
node tools/env-requirements/preflight.mjs gh-cli gcloud-cli
```

| id | why | remedy | severity | probe |
|----|-----|--------|----------|-------|
| `gcloud-auth` | gcloud commands run but every API call 403s or prompts interactively when no account is active. | Authenticate with `gcloud auth login` (CI authenticates via Workload Identity Federation before calling the deploy scripts). | fail | `command-succeeds(gcloud auth list --filter=status:ACTIVE --format=value(account))` † |
| `gcloud-cli` | Preview-VM create/deploy/teardown (scripts/preview-up.sh, scripts/preview-down.sh) invoke `gcloud`; absent it every deploy step aborts with command-not-found. | Install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install. | fail | `binary-on-path(gcloud)` |
| `gh-auth` | `gh api` calls that read a PR's preview announce comment return 401 when no gh session is authenticated. | Authenticate once with `gh auth login`. | fail | `command-succeeds(gh auth status)` † |
| `gh-cli` | The harness resolves a PR's preview-VM URL (`--pr`) and reviewer/CI adjudication shell out to `gh`; without it those calls die with a bare ENOENT. | Install the GitHub CLI from https://cli.github.com (Windows: `winget install --id GitHub.cli`). | fail | `binary-on-path(gh)` |
| `headed-display` | The QA harness launches headed Chromium (pointer lock hangs the headless CDP session); with no display available it cannot open a browser window. | On Linux export `DISPLAY` or wrap the run in `xvfb-run -a` (win32/macOS always have a display). | fail | `display-headed` |
| `lfs-real-assets` | If Git LFS content was not pulled, the terrain .glb is a ~130-byte pointer file instead of the real model, so the client ships broken terrain and never becomes joinable. | Fetch LFS objects: `git lfs pull`. | fail | `file-min-size(client/public/models/terrain/dark-fantasy-map-2.glb >= 1048576)` |
| `openssh-not-plink` | On Windows `gcloud compute ssh` uses PuTTY/plink, which does not forward heredocs; preview-up.sh's heredoc-over-ssh publish step fails with rc=127. | Run preview deploys from CI, WSL, or Linux (OpenSSH transport), or use the scp-the-script workaround documented in scripts/preview-up.sh. | warn | `not-plink-transport` |
| `spacetime-cli` | Publishing and starting the module (`spacetime publish`, `spacetime start`) invoke the SpacetimeDB CLI; absent it the integration and publish steps abort. The CLI is Linux-only, so on the Windows dev setup it lives inside WSL rather than on the host PATH. | Install it: `curl -sSf https://install.spacetimedb.com \| sh -s -- --yes`. | fail | `binary-on-path(spacetime)` |
| `windows-node-modules` | Linux-native node_modules on Windows ship the wrong-platform vite/esbuild binaries and a `.bin` with no *.cmd shims, so `npm run qa:*` fails with 'vite-node is not recognized'. | Reinstall from a native shell: `cd client; npm ci` (PowerShell on Windows, not inside WSL). | fail (win32 only) | `node-modules-platform(client)` |
| `wsl-available` | On Windows the harness runs its isolated SpacetimeDB inside WSL2 via `wsl.exe`; absent it ensure-env's bring-up throws a bare spawn ENOENT. | Install WSL2 Ubuntu: `wsl --install -d Ubuntu` (this requirement applies only on Windows hosts). | fail (win32 only) | `binary-on-path(wsl.exe)` |

† `command-succeeds` is the free-form escape-hatch probe type; prefer a declarative probe type where one fits.
