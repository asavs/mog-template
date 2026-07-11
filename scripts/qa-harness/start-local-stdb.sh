#!/bin/bash
# Runs INSIDE WSL2 (Ubuntu). Starts a SpacetimeDB instance dedicated to the
# QA harness, isolated from the production VM. Safe to re-run: skips the
# start step if an instance is already listening on 127.0.0.1:3000.
set -euo pipefail

export PATH="/root/.cargo/bin:/root/.local/bin:$PATH"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../common.sh"

LISTEN_ADDR=127.0.0.1:3000
LOG_FILE=/root/spacetime.log

port_open() {
  (echo > "/dev/tcp/${LISTEN_ADDR/:/\/}") 2>/dev/null
}

if port_open; then
  echo "SpacetimeDB already listening on $LISTEN_ADDR"
else
  echo "Starting SpacetimeDB on $LISTEN_ADDR..."
  CLI=$(resolve_spacetime_cli)
  nohup "$CLI" start --listen-addr "$LISTEN_ADDR" > "$LOG_FILE" 2>&1 &
  disown

  for _ in $(seq 1 30); do
    port_open && break
    sleep 1
  done

  if ! port_open; then
    echo "SpacetimeDB failed to start within 30s" >&2
    cat "$LOG_FILE" >&2
    exit 1
  fi
  echo "SpacetimeDB ready."
fi

if [ "${1:-}" = "--publish" ]; then
  # --delete-data: schema changes require it, and the local QA database is
  # disposable bot traffic — a clean slate every publish beats the cryptic
  # DataView decode errors a half-migrated module produces.
  echo "Publishing $REPO_ROOT/server/spacetimedb to database 'mog-game-v1' (with --delete-data)..."
  cd "$REPO_ROOT/server"
  spacetime_cmd publish --delete-data --yes mog-game-v1
fi
