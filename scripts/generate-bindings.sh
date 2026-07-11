#!/bin/bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

echo "Generating TypeScript bindings from $REPO_ROOT/server/spacetimedb..."
cd "$REPO_ROOT/server"
spacetime_cmd generate \
  --lang typescript \
  --out-dir "$REPO_ROOT/client/src/generated" \
  --module-path "$REPO_ROOT/server/spacetimedb" \
  --yes
echo "TypeScript bindings generated."
