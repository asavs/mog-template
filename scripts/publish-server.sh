#!/bin/bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

echo "Publishing server module in $REPO_ROOT/server..."
cd "$REPO_ROOT/server"
if ! spacetime_cmd publish --yes; then
  cat >&2 <<'EOF'
Server module build completed, but publish failed.

If the error is "not authorized to perform action on database", this VM's
SpacetimeDB CLI token is not the owner of the local database.

Use a shared owner config:
  SPACETIME_CONFIG_PATH=/path/to/shared/cli.toml ./scripts/publish-server.sh

Or log in with the owner token / recreate the local database under the current
identity.
EOF
  exit 1
fi
echo "Server module published."
