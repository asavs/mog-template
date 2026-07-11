#!/bin/bash
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/common.sh"

SOURCE_CONFIG=${1:-${SPACETIME_CONFIG_PATH:-$HOME/.config/spacetime/cli.toml}}
TARGET_CONFIG=$DEFAULT_SHARED_SPACETIME_CONFIG

if [ ! -f "$SOURCE_CONFIG" ]; then
  echo "Source SpacetimeDB config not found: $SOURCE_CONFIG" >&2
  exit 1
fi

if ! grep -q '^spacetimedb_token =' "$SOURCE_CONFIG"; then
  echo "Source SpacetimeDB config has no spacetimedb_token: $SOURCE_CONFIG" >&2
  exit 1
fi

echo "Installing shared SpacetimeDB CLI config to $TARGET_CONFIG..."
sudo install -d -m 775 "$(dirname "$TARGET_CONFIG")"
sudo install -m 664 "$SOURCE_CONFIG" "$TARGET_CONFIG"
sudo chgrp nogroup "$TARGET_CONFIG"

SPACETIME_CONFIG_PATH=$TARGET_CONFIG spacetime_cmd server set-default local >/dev/null
echo "Shared SpacetimeDB CLI config installed. Scripts will use it by default."
