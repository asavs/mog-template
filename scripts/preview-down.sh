#!/usr/bin/env bash
#
# preview-down.sh <PR_NUMBER> — delete a PR's ephemeral preview VM.
#
# Tolerant of an already-absent instance (exits 0): teardown fires on PR close,
# TTL GC, and manual dispatch, so races where the VM is already gone are normal.
#
# Config knobs (env vars; defaults match docs/preview-vm-factory-plan-v1 §11):
#   ZONE                 [us-central1-a]
#   PROJECT / GCP_PROJECT             GCP project id (required)
#
set -euo pipefail

PR_NUMBER="${1:?usage: preview-down.sh <PR_NUMBER>}"
ZONE="${ZONE:-us-central1-a}"
PROJECT="${PROJECT:-${GCP_PROJECT:?PROJECT (or GCP_PROJECT) is required}}"

INSTANCE="mog-pr-${PR_NUMBER}"

gc() { gcloud --project="$PROJECT" "$@"; }
log() { printf '[preview-down] %s\n' "$*" >&2; }

if ! gc compute instances describe "$INSTANCE" --zone="$ZONE" >/dev/null 2>&1; then
  log "$INSTANCE already absent — nothing to tear down."
  exit 0
fi

log "deleting $INSTANCE (zone $ZONE)"
gc compute instances delete "$INSTANCE" --zone="$ZONE" --quiet
log "deleted $INSTANCE."
