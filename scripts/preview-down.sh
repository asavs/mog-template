#!/usr/bin/env bash
#
# preview-down.sh <PR_NUMBER> — delete a PR's ephemeral preview VM.
#
# Tolerant of an already-absent instance (exits 0): teardown fires on PR close,
# TTL GC, and manual dispatch, so races where the VM is already gone are normal.
#
# Zone-agnostic: the VM's ACTUAL zone is discovered from its name rather than
# assumed from the ZONE knob, so a delete never misses (and leaks) a VM if the
# zone default ever changed between create and teardown.
#
# Config knobs (env vars):
#   PROJECT / GCP_PROJECT             GCP project id (required)
#
set -euo pipefail

PR_NUMBER="${1:?usage: preview-down.sh <PR_NUMBER>}"
PROJECT="${PROJECT:-${GCP_PROJECT:?PROJECT (or GCP_PROJECT) is required}}"

INSTANCE="mog-pr-${PR_NUMBER}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------- env preflight
# Fail fast with a clear why/remedy if gcloud is missing or unauthed, rather
# than a cryptic error mid-teardown. The requirement list is declared in
# tools/env-requirements/requirements.json under `tools.preview-down.requires`.
# FAIL-OPEN when `node` is unavailable — preflight must never be the thing
# that blocks a teardown.
if command -v node >/dev/null 2>&1; then
  node "$REPO_ROOT/tools/env-requirements/preflight.mjs" --tool preview-down >&2
else
  echo "[preview-down] preflight skipped (node unavailable)" >&2
fi

gc() { gcloud --project="$PROJECT" "$@"; }
log() { printf '[preview-down] %s\n' "$*" >&2; }

# Discover the instance's real zone. Constrained to the mog-preview label so this
# can never delete a same-named non-preview VM. `value(zone)` yields the short
# zone name (e.g. us-central1-a), not a URL.
ZONE_ACTUAL=$(gc compute instances list \
  --filter="name=${INSTANCE} AND labels.mog-preview=true" \
  --format='value(zone)' | head -1)

if [ -z "$ZONE_ACTUAL" ]; then
  log "$INSTANCE already absent — nothing to tear down."
  exit 0
fi

log "deleting $INSTANCE (zone $ZONE_ACTUAL)"
gc compute instances delete "$INSTANCE" --zone="$ZONE_ACTUAL" --quiet
log "deleted $INSTANCE."
