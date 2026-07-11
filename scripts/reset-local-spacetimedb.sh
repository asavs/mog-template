#!/bin/bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

DB_NAME=${1:-mog-game-v1}

cat <<EOF
This will delete all local SpacetimeDB data under /stdb/data and recreate $DB_NAME
under the shared/current script identity.
EOF

if [ "${RESET_LOCAL_STDB_CONFIRM:-}" != "yes" ]; then
  echo "Set RESET_LOCAL_STDB_CONFIRM=yes to run this destructive reset." >&2
  exit 1
fi

echo "Stopping SpacetimeDB service..."
sudo systemctl stop spacetimedb

echo "Clearing local SpacetimeDB data..."
SPACETIME=$(resolve_spacetime_cli)
mapfile -t SPACETIME_CONFIG_ARGS < <(spacetime_config_args)
sudo "$SPACETIME" "${SPACETIME_CONFIG_ARGS[@]}" server clear --data-dir /stdb/data --yes

echo "Ensuring /stdb ownership for the service..."
sudo chown -R spacetimedb:spacetimedb /stdb

echo "Starting SpacetimeDB service..."
sudo systemctl start spacetimedb

echo "Waiting for local SpacetimeDB..."
for _ in {1..30}; do
  if spacetime_cmd server ping local >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "Publishing $DB_NAME under the active shared/current identity..."
cd "$REPO_ROOT/server"
spacetime_cmd publish "$DB_NAME" --yes

echo "Regenerating bindings and rebuilding client..."
"$REPO_ROOT/scripts/generate-bindings.sh"
"$REPO_ROOT/scripts/build-client.sh"

echo "Local SpacetimeDB reset complete."
