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
#                          connects to. The caller (preview-up.yml) builds the
#                          client with VITE_STDB_DB_NAME="$PREVIEW_DB_NAME",
#                          which client/src/environment.ts reads (falling back
#                          to 'mog-game-v1' when unset), so this one knob
#                          governs both the publish target here and the
#                          client's connection target.
#   IMAGE_FAMILY           [mog-preview]  golden-image family (plan §9). If an
#                          image exists in this family (in PROJECT), the VM is
#                          created FROM it and the bootstrap below self-skips via
#                          its sentinel; otherwise falls back to stock debian-12
#                          + full bootstrap. Baked by scripts/preview-bootstrap.sh.
#   PROJECT / GCP_PROJECT               GCP project id (required)
#   WASM_PATH                           override wasm path (else auto-find)
#   DIST_DIR               [client/dist]  built client bundle
#   (PREVIEW_TTL_HOURS is consumed by the GC job in preview-down.yml, not here.)
#
# Manual runs from Windows: the heredoc-over-ssh publish step below (`gcloud
# compute ssh ... --command=... <<'REMOTE'`) fails under Windows gcloud's
# plink SSH transport with rc=127 (plink does not forward the heredoc the way
# OpenSSH does). Workaround: scp the apply script to the VM and run it there
# as a plain `--command` instead of piping a heredoc over ssh. CI runs on
# Ubuntu/OpenSSH and is unaffected.
#
set -euo pipefail

PR_NUMBER="${1:?usage: preview-up.sh <PR_NUMBER> <SHA>}"
SHA="${2:?usage: preview-up.sh <PR_NUMBER> <SHA>}"

MACHINE_TYPE="${MACHINE_TYPE:-e2-micro}"
PREVIEW_MAX_CONCURRENT="${PREVIEW_MAX_CONCURRENT:-3}"
ZONE="${ZONE:-us-central1-a}"
PREVIEW_DB_NAME="${PREVIEW_DB_NAME:-mog-game-v1}"
IMAGE_FAMILY="${IMAGE_FAMILY:-mog-preview}"
PROJECT="${PROJECT:-${GCP_PROJECT:?PROJECT (or GCP_PROJECT) is required}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="${DIST_DIR:-$REPO_ROOT/client/dist}"

INSTANCE="mog-pr-${PR_NUMBER}"

# ---------------------------------------------------------------- env preflight
# Surface a missing/unauthed tool as a clear why/remedy before we create any VM,
# instead of a cryptic gcloud/rsync error mid-deploy. Checks gcloud CLI + auth,
# that the terrain LFS asset is real (not a pointer) before we ship dist, and
# warns (never fails) about the plink SSH transport on Windows.
# FAIL-OPEN: if `node` itself is unavailable (e.g. a CI step-ordering gap),
# skip the check — preflight must never be the thing that breaks a deploy.
if command -v node >/dev/null 2>&1; then
  node "$REPO_ROOT/tools/env-requirements/preflight.mjs" \
    gcloud-cli gcloud-auth lfs-real-assets openssh-not-plink >&2
else
  echo "[preview-up] preflight skipped (node unavailable)" >&2
fi

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
  # `| wc -l` (no `|| true`): if `gcloud list` itself fails (auth / API / rate
  # limit), pipefail propagates the error and the script halts loudly instead of
  # masking it as LIVE=0 and creating a VM that could blow past the cap. wc -l on
  # empty output is a correct 0.
  LIVE=$(gc compute instances list --filter="labels.mog-preview=true" --format='value(name)' | wc -l)
  log "live preview VMs: $LIVE / cap $PREVIEW_MAX_CONCURRENT"
  if [ "$LIVE" -ge "$PREVIEW_MAX_CONCURRENT" ]; then
    log "ERROR: preview VM cap ($PREVIEW_MAX_CONCURRENT) reached; refusing to create $INSTANCE."
    log "Tear down another preview (scripts/preview-down.sh <PR>) or wait for GC/TTL."
    exit 1
  fi
  # Image source: prefer the golden image family (plan Phase 4 / §9) so a fresh
  # VM already has OS + STDB + nginx + firewall + layout and the bootstrap step
  # below self-skips via its sentinel. Fall back to stock debian-12 + full
  # bootstrap when no image has been baked into IMAGE_FAMILY yet (first-ever run,
  # or a cleared image family). Custom images live in THIS project, so both the
  # family lookup and `--image-project` scope to $PROJECT.
  if gc compute images describe-from-family "$IMAGE_FAMILY" >/dev/null 2>&1; then
    log "creating $INSTANCE ($MACHINE_TYPE) from golden image family '$IMAGE_FAMILY' (bootstrap self-skips)"
    IMAGE_ARGS=(--image-family="$IMAGE_FAMILY" --image-project="$PROJECT")
  else
    log "creating $INSTANCE ($MACHINE_TYPE) from debian-12 (no image in family '$IMAGE_FAMILY'; full bootstrap)"
    IMAGE_ARGS=(--image-family=debian-12 --image-project=debian-cloud)
  fi
  # Stamp last-deploy at CREATE time too, not only after a successful publish
  # (see the "record TTL marker" step below). A VM that is created but then
  # fails bootstrap/publish before reaching that step would otherwise carry NO
  # last-deploy label at all, and preview-down.yml's GC sweep only TTL-reaps
  # instances that HAVE one (a missing label skips the age check entirely) —
  # such a create-then-fail VM would leak forever unless its PR happens to
  # close. Stamping the label here closes that GC gap; the refresh after a
  # real publish (below) still overwrites it with the true last-deploy time.
  gc compute instances create "$INSTANCE" --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    "${IMAGE_ARGS[@]}" \
    --boot-disk-size=10GB --boot-disk-type=pd-standard \
    --tags=http-server \
    --labels="mog-preview=true,pr=${PR_NUMBER},last-deploy=$(date -u +%s)" \
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
# path proven end-to-end in the phase-2 spike.
#
# spacetimedb must be able to traverse the staging dir and read the wasm. Default
# Debian-12 GCE umask (022) already allows this, but set the bits explicitly so
# the publish never depends on the ambient OS Login umask (a stricter 077/027
# would otherwise leave /tmp/deploy-<sha> unreadable to spacetimedb). The SSH
# user owns both, so no sudo is needed to chmod them.
chmod 755 "$STAGING"
chmod 644 "$WASM_FILE"
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
# `add-labels` is the canonical single-label upsert (it overwrites the key's
# value on redeploy), so no separate update/clear dance is needed.
DEPLOY_EPOCH=$(date -u +%s)
gc compute instances add-labels "$INSTANCE" --zone="$ZONE" \
  --labels="last-deploy=${DEPLOY_EPOCH}" >&2

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
