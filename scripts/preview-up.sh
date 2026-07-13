#!/usr/bin/env bash
#
# preview-up.sh <PR_NUMBER> <SHA> — create-or-reuse an ephemeral preview VM for
# a PR, deploy the prebuilt client + WASM to it with a CLEARED world, and print
# a machine-readable announce JSON on stdout.
#
# Runnable from CI (after building artifacts on the runner) OR by a human with
# gcloud + prebuilt artifacts. This script does NOT build anything — it consumes
# a prebuilt WASM and client dist (like apply-artifacts.sh).
#
# Config knobs (env vars; defaults match the preview-VM factory plan v1 §11).
# In CI these are sourced from repo `vars.*` with these same fallbacks:
#   MACHINE_TYPE           [e2-micro]   VM shape (fallback e2-small if micro OOMs)
#   PREVIEW_MAX_CONCURRENT [3]          hard cap on live preview VMs project-wide
#   ZONE                   [us-central1-a]
#   PREVIEW_DB_NAME        [mog-game-v1]  MUST match the DB name the built client
#                          connects to. client/src/environment.ts maps a base-'/'
#                          build (what `npm run build` produces) to 'mog-game-v1';
#                          the preview VM is fully isolated so reusing that name
#                          here is free of collision and lets the stock client
#                          connect with no preview-specific build flag.
#   PROJECT / GCP_PROJECT               GCP project id (required)
#   WASM_PATH                           override wasm path (else auto-find)
#   DIST_DIR               [client/dist]  built client bundle
#   (PREVIEW_TTL_HOURS is consumed by the GC job in preview-down.yml, not here.)
#
set -euo pipefail

PR_NUMBER="${1:?usage: preview-up.sh <PR_NUMBER> <SHA>}"
SHA="${2:?usage: preview-up.sh <PR_NUMBER> <SHA>}"

MACHINE_TYPE="${MACHINE_TYPE:-e2-micro}"
PREVIEW_MAX_CONCURRENT="${PREVIEW_MAX_CONCURRENT:-3}"
ZONE="${ZONE:-us-central1-a}"
PREVIEW_DB_NAME="${PREVIEW_DB_NAME:-mog-game-v1}"
PROJECT="${PROJECT:-${GCP_PROJECT:?PROJECT (or GCP_PROJECT) is required}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="${DIST_DIR:-$REPO_ROOT/client/dist}"

INSTANCE="mog-pr-${PR_NUMBER}"

# gcloud pinned to the project; all output goes to stderr so stdout is reserved
# for the single announce JSON blob at the end.
gc() { gcloud --project="$PROJECT" "$@"; }
log() { printf '[preview-up] %s\n' "$*" >&2; }

# ---------------------------------------------------------------- locate artifacts
if [ -z "${WASM_PATH:-}" ]; then
  WASM_PATH=$(find "$REPO_ROOT/server/spacetimedb/target/wasm32-unknown-unknown/release" \
    -maxdepth 1 -name '*.wasm' 2>/dev/null | head -1 || true)
fi
if [ -z "${WASM_PATH:-}" ] || [ ! -f "$WASM_PATH" ]; then
  log "ERROR: no wasm found (set WASM_PATH or build the module first)"
  exit 1
fi
if [ ! -d "$DIST_DIR" ]; then
  log "ERROR: client dist not found at $DIST_DIR (build the client first)"
  exit 1
fi
log "artifacts: wasm=$(basename "$WASM_PATH") dist=$DIST_DIR"

# ---------------------------------------------------------------- create-or-reuse
instance_exists() { gc compute instances describe "$INSTANCE" --zone="$ZONE" >/dev/null 2>&1; }

if instance_exists; then
  log "reusing existing instance $INSTANCE"
else
  # Hard concurrency cap (plan decision A): count live preview VMs. This PR's
  # own VM does not exist yet, so it counts fully against the cap.
  LIVE=$(gc compute instances list --filter="labels.mog-preview=true" --format='value(name)' | grep -c . || true)
  log "live preview VMs: $LIVE / cap $PREVIEW_MAX_CONCURRENT"
  if [ "$LIVE" -ge "$PREVIEW_MAX_CONCURRENT" ]; then
    log "ERROR: preview VM cap ($PREVIEW_MAX_CONCURRENT) reached; refusing to create $INSTANCE."
    log "Tear down another preview (scripts/preview-down.sh <PR>) or wait for GC/TTL."
    exit 1
  fi
  log "creating $INSTANCE ($MACHINE_TYPE, debian-12, 10GB pd-standard)"
  gc compute instances create "$INSTANCE" --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size=10GB --boot-disk-type=pd-standard \
    --tags=http-server \
    --labels="mog-preview=true,pr=${PR_NUMBER}" \
    --metadata=enable-oslogin=true >&2

  log "waiting for SSH..."
  for _ in $(seq 1 30); do
    gc compute ssh "$INSTANCE" --zone="$ZONE" --command=true --quiet >/dev/null 2>&1 && break
    sleep 10
  done
fi

# ---------------------------------------------------------------- bootstrap (skip if provisioned)
log "staging + running preview-bootstrap.sh (self-skips if already provisioned)"
gc compute scp --zone="$ZONE" --quiet \
  "$SCRIPT_DIR/preview-bootstrap.sh" "$INSTANCE:/tmp/preview-bootstrap.sh" >&2
gc compute ssh "$INSTANCE" --zone="$ZONE" --quiet \
  --command="bash /tmp/preview-bootstrap.sh" >&2

# ---------------------------------------------------------------- stage artifacts
STAGING="/tmp/deploy-${SHA}"
log "staging artifacts to $STAGING"
gc compute ssh "$INSTANCE" --zone="$ZONE" --quiet \
  --command="rm -rf ${STAGING} && mkdir -p ${STAGING}" >&2
gc compute scp --zone="$ZONE" --quiet --recurse \
  "$WASM_PATH" "$DIST_DIR" "mog-pr-${PR_NUMBER}:${STAGING}/" >&2

# ---------------------------------------------------------------- apply on VM (publish + sync)
# Runs on the VM. Publishes with a CLEARED world (--delete-data, decision E) and
# ALWAYS pins --server to the loopback STDB: an unqualified publish targets
# maincloud and 401s. Then rsyncs dist into the single web root.
log "publishing $PREVIEW_DB_NAME (cleared world) + syncing client"
gc compute ssh "$INSTANCE" --zone="$ZONE" --quiet \
  --command="DB_NAME='${PREVIEW_DB_NAME}' SHA='${SHA}' bash -s" <<'REMOTE' >&2
set -euo pipefail
STAGING="/tmp/deploy-${SHA}"
WEB_ROOT="/var/www/mog"
STDB_SERVER="http://127.0.0.1:3000"

WASM_FILE=$(find "$STAGING" -maxdepth 1 -name '*.wasm' | head -1)
[ -n "$WASM_FILE" ] && [ -f "$WASM_FILE" ] || { echo "ERROR: no wasm in $STAGING" >&2; exit 1; }
[ -d "$STAGING/dist" ] || { echo "ERROR: no dist/ in $STAGING" >&2; exit 1; }

# Resolve the versioned CLI (the /stdb/spacetime wrapper resolves per-user paths).
SPACETIME=$(ls /stdb/bin/*/spacetimedb-cli 2>/dev/null | sort -V | tail -1 || true)
[ -n "${SPACETIME:-}" ] && [ -x "$SPACETIME" ] || { echo "ERROR: spacetime CLI not found" >&2; exit 1; }

# Publish AS the spacetimedb user (HOME=/stdb) — the identity/config live there
# and that user stably owns the preview DB across redeploys, so a reused VM never
# hits the 403 "not the owner" that a per-SSH-user identity would. This is the
# path proven end-to-end in the phase-2 spike. The staged wasm under /tmp is
# world-readable, so spacetimedb can read --bin-path.
echo "[preview-apply] publishing $DB_NAME to $STDB_SERVER as spacetimedb (cleared world)"
sudo -u spacetimedb -H "$SPACETIME" publish --server "$STDB_SERVER" \
  --bin-path "$WASM_FILE" --delete-data --yes "$DB_NAME"

# Skip any dist file that arrived as an unresolved Git LFS pointer rather than
# shipping a broken asset (CI pulls LFS, so this should be a no-op there).
EXCLUDES=()
while IFS= read -r -d '' path; do
  if LC_ALL=C grep -aq '^version https://git-lfs.github.com/spec/v1$' "$path"; then
    rel="${path#"$STAGING/dist/"}"
    echo "[preview-apply] WARNING: $rel is an unresolved LFS pointer; shipping WITHOUT it" >&2
    EXCLUDES+=("--exclude=$rel")
  fi
done < <(find "$STAGING/dist" -type f -print0)

echo "[preview-apply] syncing client bundle to $WEB_ROOT"
sudo mkdir -p "$WEB_ROOT"
sudo rsync -a --checksum --no-times --delete "${EXCLUDES[@]}" "$STAGING/dist/" "$WEB_ROOT/"
sudo chown -R www-data:www-data "$WEB_ROOT"

rm -rf "$STAGING"
echo "[preview-apply] done."
REMOTE

# ---------------------------------------------------------------- record TTL marker
# Stamp the deploy time as a numeric instance label so the scheduled GC job can
# age out VMs past PREVIEW_TTL_HOURS with a single `gcloud instances list`.
DEPLOY_EPOCH=$(date -u +%s)
gc compute instances update "$INSTANCE" --zone="$ZONE" \
  --update-labels="last-deploy=${DEPLOY_EPOCH}" >&2

# ---------------------------------------------------------------- announce
IP=$(gc compute instances describe "$INSTANCE" --zone="$ZONE" \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

log "preview live: http://${IP}/"

# Machine-readable announce (plan §8.2 — EXACT fields). Emitted between markers
# on stdout so callers (the workflow) can extract it unambiguously.
cat <<JSON
MOG_PREVIEW_ANNOUNCE_BEGIN
{
  "pr": ${PR_NUMBER},
  "sha": "${SHA}",
  "vm": "${INSTANCE}",
  "url": "http://${IP}/",
  "deployedAt": "${DEPLOYED_AT}",
  "machineType": "${MACHINE_TYPE}"
}
MOG_PREVIEW_ANNOUNCE_END
JSON
