# Enabling prod deploy

Prod deploy is **scaffolded but off** by default (plan v1 decision I). There is
no always-on prod host in this project yet, so a merge to `master` does **not**
deploy anywhere. `.github/workflows/prod-deploy.yml` runs only when the repo
variable `PROD_DEPLOY_ENABLED` is exactly `true`; unset or anything else and the
job is skipped (a skipped job is a green check, so `master` stays green).

This is a flip-switch: stand up a prod VM, set the secrets, set the flag.

## 1. Stand up a prod VM

Use the existing bootstrap — `prod-deploy.yml` targets a VM named `mog-server`
in `us-central1-a` and applies via `scripts/apply-artifacts.sh`:

```sh
PROJECT_ID=<your-project> GITHUB_REPO=asavs/mog-template \
  ./scripts/setup-deploy-infra.sh
```

For the manual, step-by-step version (VM shape, firewall, SpacetimeDB layout,
nginx, publish identity), see [`docs/deploy-your-vm.md`](deploy-your-vm.md). The
prod VM is a normal always-on host — **not** an ephemeral preview VM, and not
the `mog-preview` factory in `scripts/preview-*.sh`.

## 2. Set the required secrets

`prod-deploy.yml` authenticates to GCP with Workload Identity Federation (no
long-lived keys). The bootstrap script sets these for you; if you wire it up by
hand, set all three on the repo:

| Secret | Value |
|---|---|
| `GCP_PROJECT` | GCP project id |
| `GCP_SERVICE_ACCOUNT` | deploy SA email (`github-actions-deploy@<project>.iam.gserviceaccount.com`) |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | full WIF provider resource path |

## 3. Flip the flag

```sh
gh variable set PROD_DEPLOY_ENABLED --body true -R asavs/mog-template
```

From here on, every push to `master` (i.e. every merge) builds and deploys to
`mog-game-v1`. To pause prod deploys again, set the variable to anything other
than `true` (or delete it) — no workflow edit needed.

## First-deploy notes

- Trigger the first deploy explicitly instead of waiting for a merge:
  `gh workflow run prod-deploy.yml -R asavs/mog-template --ref master`.
- The first publish creates and takes ownership of the `mog-game-v1` database
  (single-publisher model — see `docs/deploy-your-vm.md` §5 for the shared
  `/stdb/config/cli.toml` if multiple identities ever need to publish).
- **Schema changes:** SpacetimeDB rejects an incompatible schema republish
  against existing data. Before there is player state worth keeping, the honest
  option is to publish with `--delete-data` (clears the world). Once real state
  exists on `mog-game-v1`, that is no longer safe — a migration step is needed
  first. Prod schema migration is out of scope for this scaffold; revisit before
  there is state worth preserving.
