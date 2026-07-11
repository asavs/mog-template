#!/bin/bash

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
DEFAULT_SHARED_SPACETIME_CONFIG=/stdb/config/cli.toml

resolve_spacetime_cli() {
  if [ -n "${SPACETIME_CLI:-}" ]; then
    printf '%s\n' "$SPACETIME_CLI"
    return
  fi

  if command -v spacetime >/dev/null 2>&1; then
    command -v spacetime
    return
  fi

  if [ -x /stdb/bin/2.1.0/spacetimedb-cli ]; then
    printf '%s\n' /stdb/bin/2.1.0/spacetimedb-cli
    return
  fi

  echo "SpacetimeDB CLI not found. Set SPACETIME_CLI=/path/to/spacetimedb-cli." >&2
  return 1
}

spacetime_cmd() {
  local cli
  local config_path
  cli=$(resolve_spacetime_cli)

  if [ -n "${SPACETIME_CONFIG_PATH:-}" ]; then
    config_path=$SPACETIME_CONFIG_PATH
  elif [ -f "$DEFAULT_SHARED_SPACETIME_CONFIG" ] && grep -q '^spacetimedb_token =' "$DEFAULT_SHARED_SPACETIME_CONFIG"; then
    config_path=$DEFAULT_SHARED_SPACETIME_CONFIG
  else
    config_path=
  fi

  if [ -n "$config_path" ]; then
    "$cli" --config-path "$config_path" "$@"
  else
    "$cli" "$@"
  fi
}

spacetime_config_args() {
  if [ -n "${SPACETIME_CONFIG_PATH:-}" ]; then
    printf '%s\n%s\n' --config-path "$SPACETIME_CONFIG_PATH"
  elif [ -f "$DEFAULT_SHARED_SPACETIME_CONFIG" ] && grep -q '^spacetimedb_token =' "$DEFAULT_SHARED_SPACETIME_CONFIG"; then
    printf '%s\n%s\n' --config-path "$DEFAULT_SHARED_SPACETIME_CONFIG"
  fi
}
