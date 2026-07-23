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
#   PREVIEW_USE_IAP        [false]  if true, pass --tunnel-through-iap on all
#                          gcloud compute ssh/scp (useful when OS Login over
#                          public IP flakes or firewall policy prefers IAP).
#   PREVIEW_VM_SA          [PROJECT_NUMBER-compute@developer.gserviceaccount.com]
#                          service account attached to the preview VM (actAs target
#                          for gcloud compute ssh). Set explicitly so IAM is clear.
#   PREVIEW_DELETE_ON_FAIL [false]  if true, delete the VM when deploy fails after
#                          create/reuse began remote work. Default keeps the VM
#                          labeled deploy-failed=true for salvage.
#   PROJECT / GCP_PROJECT               GCP project id (required)
#   WASM_PATH                           override wasm path (else auto-find)
#   DIST_DIR               [client/dist]  built client bundle
#   (PREVIEW_TTL_HOURS is consumed by the GC job in preview-down.yml, not here.)
#
# SSH / OS Login notes (PR feel-test deploys):
#   Deploy SA needs roles/compute.osAdminLogin (or osLogin) + actAs on the VM's
#   attached service account; instances must have enable-oslogin=true. IAM can
#   lag several minutes. See docs/preview-ssh.md for the checklist and the
#   Permission denied (publickey) failure mode.
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
PREVIEW_USE_IAP="${PREVIEW_USE_IAP:-false}"
PREVIEW_DELETE_ON_FAIL="${PREVIEW_DELETE_ON_FAIL:-false}"
PROJECT="${PROJECT:-${GCP_PROJECT:?PROJECT (or GCP_PROJECT) is required}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="${DIST_DIR:-$REPO_ROOT/client/dist}"

INSTANCE="mog-pr-${PR_NUMBER}"

# ---------------------------------------------------------------- env preflight
# Surface a missing/unauthed tool as a clear why/remedy before we create any VM,
# instead of a cryptic gcloud/rsync error mid-deploy. The requirement list
# (gcloud CLI + auth, the terrain LFS asset being real before we ship dist,
# and the warn-only plink SSH transport hazard on Windows) is declared in
# tools/env-requirements/requirements.json under `tools.preview-up.requires`;
# see docs/environment-matrix.md for where this tool is supported.
# FAIL-OPEN: if `node` itself is unavailable (e.g. a CI step-ordering gap),
# skip the check — preflight must never be the thing that breaks a deploy.
if command -v node >/dev/null 2>&1; then
  node "$REPO_ROOT/tools/env-requirements/preflight.mjs" --tool preview-up >&2
else
  echo "[preview-up] preflight skipped (node unavailable)" >&2
fi

# gcloud pinned to the project; all output goes to stderr so stdout is reserved
# for the single announce JSON blob at the end.
gc() { gcloud --project="$PROJECT" "$@"; }
log() { printf '[preview-up] %s\n' "$*" >&2; }

# Default VM attached SA = project Compute Engine default (actAs target for OS Login).
# Treat empty string (workflow vars default '') as unset.
PROJECT_NUMBER=$(gc projects describe "$PROJECT" --format='value(projectNumber)')
DEFAULT_VM_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
if [ -z "${PREVIEW_VM_SA:-}" ]; then
  PREVIEW_VM_SA="$DEFAULT_VM_SA"
fi

instance_exists() { gc compute instances describe "$INSTANCE" --zone="$ZONE" >/dev/null 2>&1; }

# Shared flags for compute ssh/scp. Optional IAP for flaky public-IP OS Login.
GC_REMOTE_FLAGS=(--zone="$ZONE" --quiet)
if [ "$PREVIEW_USE_IAP" = "true" ]; then
  GC_REMOTE_FLAGS+=(--tunnel-through-iap)
  log "using IAP tunnel for ssh/scp (PREVIEW_USE_IAP=true)"
fi

# Ring buffer of recent probe failure snippets (last 5) for diagnose_ssh_failure.
PROBE_FAIL_LOG=()
record_probe_failure() {
  local snippet="$1"
  PROBE_FAIL_LOG+=("$snippet")
  if [ "${#PROBE_FAIL_LOG[@]}" -gt 5 ]; then
    PROBE_FAIL_LOG=("${PROBE_FAIL_LOG[@]: -5}")
  fi
}

# Track whether we own remote work so fail-path can salvage / tear down.
CREATED_THIS_RUN=false
DEPLOY_SUCCEEDED=false

salvage_or_delete_on_fail() {
  local rc=$?
  # Successful path sets DEPLOY_SUCCEEDED before announce; trap still fires.
  if [ "$DEPLOY_SUCCEEDED" = "true" ] || [ "$rc" -eq 0 ]; then
    return 0
  fi
  if ! instance_exists 2>/dev/null; then
    return 0
  fi
  log "--- deploy failed (rc=${rc}); post-fail VM handling ---"
  # Keep last-deploy so GC/TTL still applies; mark as failed for operators.
  gc compute instances add-labels "$INSTANCE" --zone="$ZONE" \
    --labels="deploy-failed=true,last-deploy=$(date -u +%s)" >&2 || true
  local ip
  ip=$(gc compute instances describe "$INSTANCE" --zone="$ZONE" \
    --format='value(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null || echo unknown)
  if [ "$PREVIEW_DELETE_ON_FAIL" = "true" ]; then
    log "PREVIEW_DELETE_ON_FAIL=true — deleting $INSTANCE to free the preview cap"
    gc compute instances delete "$INSTANCE" --zone="$ZONE" --quiet >&2 || true
    log "deleted $INSTANCE"
  else
    log "SALVAGE: left $INSTANCE running (ip=${ip}) labeled deploy-failed=true"
    log "  ssh: gcloud compute ssh $INSTANCE --zone=$ZONE --project=$PROJECT"
    log "  tear down: bash scripts/preview-down.sh $PR_NUMBER"
    log "  or set PREVIEW_DELETE_ON_FAIL=true to auto-delete on future failures"
  fi
}
trap salvage_or_delete_on_fail EXIT

log_deploy_principal() {
  local principal
  principal=$(gcloud config get-value account 2>/dev/null || echo unknown)
  log "deploy principal (gcloud account): $principal"
  log "preview VM attached SA (actAs target): $PREVIEW_VM_SA"
  # Soft check: does the VM SA policy mention this principal as serviceAccountUser?
  # Best-effort — missing permission to get-iam-policy must not abort deploy.
  if [[ "$principal" == *.iam.gserviceaccount.com ]]; then
    if gc iam service-accounts get-iam-policy "$PREVIEW_VM_SA" \
      --flatten='bindings[].members' \
      --filter="bindings.role:roles/iam.serviceAccountUser AND bindings.members:serviceAccount:${principal}" \
      --format='value(bindings.role)' 2>/dev/null | grep -q serviceAccountUser; then
      log "IAM soft-check: $principal has serviceAccountUser on $PREVIEW_VM_SA"
    else
      log "WARNING: soft-check did not see serviceAccountUser for $principal on $PREVIEW_VM_SA"
      log "  (grant roles/iam.serviceAccountUser on the VM SA — docs/preview-ssh.md)"
      log "  if the binding exists, ignore: get-iam-policy filter can lag or lack permission"
    fi
  else
    log "deploy principal is not a service account email; skipping actAs soft-check"
  fi
}

diagnose_ssh_failure() {
  log "--- SSH/SCP diagnostics ---"
  log "instance=$INSTANCE zone=$ZONE project=$PROJECT iap=$PREVIEW_USE_IAP"
  log "vm_sa=$PREVIEW_VM_SA"
  log "gcloud account: $(gcloud config get-value account 2>/dev/null || echo unknown)"
  log "active accounts:"
  gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | while read -r acc; do
    log "  - $acc"
  done || true
  if [ "${#PROBE_FAIL_LOG[@]}" -gt 0 ]; then
    log "last ${#PROBE_FAIL_LOG[@]} probe failure snippet(s):"
    local i
    for i in "${!PROBE_FAIL_LOG[@]}"; do
      log "  [$((i + 1))] ${PROBE_FAIL_LOG[$i]}"
    done
  else
    log "no captured probe failure snippets (failures were silent redirects)"
  fi
  # One non-quiet probe so the real gcloud/OS Login message is visible in CI logs.
  # Use an explicit =true check — do NOT use ${VAR:+flag} here: VAR is always set
  # (default "false"), and :+ would treat the non-empty string "false" as truthy.
  log "probe (ssh --command=true, not quiet):"
  DIAG_SSH_FLAGS=(--zone="$ZONE")
  if [ "$PREVIEW_USE_IAP" = "true" ]; then
    DIAG_SSH_FLAGS+=(--tunnel-through-iap)
  fi
  gc compute ssh "$INSTANCE" "${DIAG_SSH_FLAGS[@]}" \
    --command=true 2>&1 | tail -30 | while IFS= read -r line; do log "  $line"; done || true
  log "Checklist (docs/preview-ssh.md):"
  log "  1) deploy SA has roles/compute.osAdminLogin (sudo) or osLogin"
  log "  2) deploy SA has roles/iam.serviceAccountUser on VM SA ($PREVIEW_VM_SA)"
  log "  3) instance metadata enable-oslogin=true (set at create)"
  log "  4) IAM propagation can lag several minutes after role grants"
  log "  5) try PREVIEW_USE_IAP=true if public-IP OS Login is flaky"
}

# Wait until SSH works; fail loudly if it never does (do not continue silently).
wait_for_ssh() {
  local max_attempts="${1:-36}" # default ~6 minutes at 10s
  local attempt
  local err
  log "waiting for SSH (up to ${max_attempts} attempts)..."
  for attempt in $(seq 1 "$max_attempts"); do
    err=$(gc compute ssh "$INSTANCE" "${GC_REMOTE_FLAGS[@]}" --command=true 2>&1) && {
      log "SSH ready (attempt ${attempt}/${max_attempts})"
      return 0
    }
    # Keep a short single-line snippet for the last-5 ring buffer.
    record_probe_failure "attempt=${attempt} $(echo "$err" | tr '\n' ' ' | tail -c 240)"
    log "SSH not ready (attempt ${attempt}/${max_attempts}); sleeping 10s"
    sleep 10
  done
  log "ERROR: SSH never became ready for $INSTANCE"
  diagnose_ssh_failure
  return 1
}

# Retry an ssh command that must succeed.
remote_ssh() {
  local cmd="$1"
  local max_attempts="${2:-8}"
  local attempt
  local rc
  local err
  for attempt in $(seq 1 "$max_attempts"); do
    if err=$(gc compute ssh "$INSTANCE" "${GC_REMOTE_FLAGS[@]}" --command="$cmd" 2>&1); then
      # Echo remote stdout/stderr to our stderr for CI logs.
      printf '%s\n' "$err" >&2
      return 0
    fi
    rc=$?
    record_probe_failure "ssh cmd attempt=${attempt} rc=${rc} $(echo "$err" | tr '\n' ' ' | tail -c 200)"
    log "ssh failed rc=${rc} (attempt ${attempt}/${max_attempts}): ${cmd}"
    if [ "$attempt" -lt "$max_attempts" ]; then
      sleep 15
    fi
  done
  log "ERROR: ssh failed after ${max_attempts} attempts"
  diagnose_ssh_failure
  return 1
}

# Retry scp of one local path to a remote path on the instance.
# Usage: remote_scp [--recurse] <local> <remote-path-on-instance>
remote_scp() {
  local recurse=()
  if [ "${1:-}" = "--recurse" ]; then
    recurse=(--recurse)
    shift
  fi
  local local_path="${1:?remote_scp: local path required}"
  local remote_path="${2:?remote_scp: remote path required}"
  local max_attempts=8
  local attempt
  local rc
  local err
  for attempt in $(seq 1 "$max_attempts"); do
    if err=$(gc compute scp "${GC_REMOTE_FLAGS[@]}" "${recurse[@]}" \
      "$local_path" "${INSTANCE}:${remote_path}" 2>&1); then
      printf '%s\n' "$err" >&2
      return 0
    fi
    rc=$?
    record_probe_failure "scp attempt=${attempt} rc=${rc} $(echo "$err" | tr '\n' ' ' | tail -c 200)"
    log "scp failed rc=${rc} (attempt ${attempt}/${max_attempts}): $(basename "$local_path") -> ${INSTANCE}:${remote_path}"
    if [ "$attempt" -lt "$max_attempts" ]; then
      # Re-probe SSH; OS Login can flap between successful hops.
      gc compute ssh "$INSTANCE" "${GC_REMOTE_FLAGS[@]}" --command=true >/dev/null 2>&1 || true
      sleep 15
    fi
  done
  log "ERROR: scp failed after ${max_attempts} attempts for $local_path"
  diagnose_ssh_failure
  return 1
}

log_deploy_principal

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
  # Attach PREVIEW_VM_SA explicitly so actAs IAM is unambiguous (matches
  # docs/preview-ssh.md + setup-deploy-infra.sh). Scopes needed for OS Login
  # guest agent + any GCP APIs the image may call.
  log "attaching VM service account: $PREVIEW_VM_SA"
  gc compute instances create "$INSTANCE" --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    "${IMAGE_ARGS[@]}" \
    --boot-disk-size=10GB --boot-disk-type=pd-standard \
    --tags=http-server \
    --service-account="$PREVIEW_VM_SA" \
    --scopes=https://www.googleapis.com/auth/cloud-platform \
    --labels="mog-preview=true,pr=${PR_NUMBER},last-deploy=$(date -u +%s)" \
    --metadata=enable-oslogin=true >&2
  CREATED_THIS_RUN=true

fi

# Always require a live SSH session before any scp (guest agent / OS Login can
# lag after create, stop/start, or long idle). Fail here instead of mid-scp with
# a bare Permission denied (publickey).
wait_for_ssh 36

# ---------------------------------------------------------------- bootstrap (skip if provisioned)
log "staging + running preview-bootstrap.sh (self-skips if already provisioned)"
remote_scp "$SCRIPT_DIR/preview-bootstrap.sh" "/tmp/preview-bootstrap.sh"
remote_ssh "bash /tmp/preview-bootstrap.sh"

# ---------------------------------------------------------------- stage artifacts
# Split multi-source recursive scp into sequential transfers. A single
# `gcloud compute scp --recurse wasm dist host:dir/` has been observed to fail
# with Permission denied (publickey) after an earlier hop succeeded (PR #38).
STAGING="/tmp/deploy-${SHA}"
log "staging artifacts to $STAGING"
remote_ssh "rm -rf ${STAGING} && mkdir -p ${STAGING}"
# Re-probe immediately before large transfers (OS Login can flap).
remote_ssh "true" 4
remote_scp "$WASM_PATH" "${STAGING}/$(basename "$WASM_PATH")"
# Copy so remote path is $STAGING/dist (basename of DIST_DIR is normally "dist").
remote_scp --recurse "$DIST_DIR" "${STAGING}/"

# ---------------------------------------------------------------- apply on VM (publish + sync)
# Runs on the VM. Publishes with a CLEARED world (--delete-data, decision E) and
# ALWAYS pins --server to the loopback STDB: an unqualified publish targets
# maincloud and 401s. Then rsyncs dist into the single web root.
log "publishing $PREVIEW_DB_NAME (cleared world) + syncing client"
# Retry the outer SSH that carries the apply heredoc (same OS Login flakiness).
APPLY_OK=false
for apply_attempt in 1 2 3 4 5; do
  if gc compute ssh "$INSTANCE" "${GC_REMOTE_FLAGS[@]}" \
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

# Do NOT delete $STAGING here: if SSH drops after this point, outer retries would
# find an empty staging dir and fail forever. Local cleanup runs after success.
echo "[preview-apply] done."
REMOTE
  then
    APPLY_OK=true
    break
  fi
  log "apply ssh failed (attempt ${apply_attempt}/5); re-staging artifacts then retrying in 20s"
  # Re-upload in case a partial remote apply wiped or corrupted staging mid-flight.
  remote_ssh "mkdir -p ${STAGING}" 3 || true
  remote_scp "$WASM_PATH" "${STAGING}/$(basename "$WASM_PATH")" || true
  remote_scp --recurse "$DIST_DIR" "${STAGING}/" || true
  sleep 20
done
if [ "$APPLY_OK" != "true" ]; then
  log "ERROR: apply step failed after retries"
  diagnose_ssh_failure
  exit 1
fi
# Safe to drop staging only after a fully successful apply hop.
remote_ssh "rm -rf ${STAGING}" 3 || true

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

# Clear failed marker if a previous attempt labeled this VM.
gc compute instances remove-labels "$INSTANCE" --zone="$ZONE" \
  --labels=deploy-failed >&2 2>/dev/null || true

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

DEPLOY_SUCCEEDED=true
