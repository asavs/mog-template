#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

echo "Applying shared workspace permissions to $REPO_ROOT..."
sudo chmod -R 777 "$REPO_ROOT"
