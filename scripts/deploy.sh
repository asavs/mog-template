#!/bin/bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
echo "Starting deployment from $REPO_ROOT..."
"$REPO_ROOT/scripts/publish-server.sh"
"$REPO_ROOT/scripts/generate-bindings.sh"
"$REPO_ROOT/scripts/build-client.sh"
echo "Deployment complete!"
"$REPO_ROOT/scripts/fix-permissions.sh"
