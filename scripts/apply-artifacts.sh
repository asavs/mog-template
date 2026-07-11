#!/bin/bash
# Apply pre-built deploy artifacts on mog-server.
#
# Called by the deploy workflow after WASM + client/dist have been scp'd
# to /tmp/deploy-<sha>/. This script does NOT build anything — it consumes
# the staged artifacts, publishes them, and cleans up.
#
# Args:
#   $1  target  prod|beta
#   $2  sha     deploy commit SHA (used as the staging dir suffix)

set -euo pipefail

TARGET="${1:-}"
SHA="${2:-}"

if [ -z "$TARGET" ] || [ -z "$SHA" ]; then
  echo "Usage: $0 prod|beta <sha>" >&2
  exit 1
fi

case "$TARGET" in
  prod) DB_NAME="mog-game-v1";   WEB_ROOT="/var/www/mog" ;;
  beta) DB_NAME="mog-game-beta"; WEB_ROOT="/var/www/mog-beta" ;;
  *) echo "ERROR: target must be prod or beta (got: $TARGET)" >&2; exit 1 ;;
esac

STAGING_DIR="/tmp/deploy-${SHA}"
WASM_FILE=$(find "$STAGING_DIR" -maxdepth 1 -name '*.wasm' | head -1)

if [ -z "$WASM_FILE" ] || [ ! -f "$WASM_FILE" ]; then
  echo "ERROR: no .wasm in $STAGING_DIR" >&2
  ls -la "$STAGING_DIR" >&2 || true
  exit 1
fi
if [ ! -d "$STAGING_DIR/dist" ]; then
  echo "ERROR: no dist/ in $STAGING_DIR" >&2
  exit 1
fi

# Resolve the SpacetimeDB CLI. /stdb/spacetime is a wrapper that resolves to
# the calling user's ~/.local/share/spacetime/bin/current/ — that doesn't exist
# for the deploy SA's user, so prefer the versioned binary directly. Glob so
# we pick up new versions automatically after `spacetime version upgrade`.
SPACETIME=$(ls /stdb/bin/*/spacetimedb-cli 2>/dev/null | sort -V | tail -1 || true)

if [ -z "${SPACETIME:-}" ] && command -v spacetime >/dev/null 2>&1; then
  SPACETIME=$(command -v spacetime)
fi

if [ -z "${SPACETIME:-}" ] || [ ! -x "$SPACETIME" ]; then
  echo "ERROR: spacetime CLI not found under /stdb/bin/*/ or on PATH" >&2
  exit 1
fi

# Use the shared identity if it's present and has a token.
CONFIG_ARGS=()
if [ -f /stdb/config/cli.toml ] && grep -q '^spacetimedb_token =' /stdb/config/cli.toml; then
  CONFIG_ARGS=(--config-path /stdb/config/cli.toml)
fi

log() { printf '[deploy/%s] %s\n' "$TARGET" "$*"; }

log "db=$DB_NAME web-root=$WEB_ROOT wasm=$(basename "$WASM_FILE")"

log "Publishing server module to $DB_NAME..."
PUBLISH_ARGS=(--bin-path "$WASM_FILE" --yes)
if [ "$TARGET" = "beta" ]; then
  log "Beta deploy may reset preview data for schema changes."
  PUBLISH_ARGS+=(--delete-data)
fi
"$SPACETIME" "${CONFIG_ARGS[@]}" publish "${PUBLISH_ARGS[@]}" "$DB_NAME"

LFS_POINTER_EXCLUDES=()
while IFS= read -r -d '' path; do
  if ! LC_ALL=C grep -aq '^version https://git-lfs.github.com/spec/v1$' "$path"; then
    continue
  fi

  rel_path="${path#"$STAGING_DIR/dist/"}"
  existing_path="$WEB_ROOT/$rel_path"

  if [ -f "$existing_path" ] && ! LC_ALL=C grep -aq '^version https://git-lfs.github.com/spec/v1$' "$existing_path"; then
    log "Preserving existing runtime asset $rel_path; staged file is a Git LFS pointer"
    LFS_POINTER_EXCLUDES+=("--exclude=$rel_path")
    continue
  fi

  echo "ERROR: staged $rel_path is a Git LFS pointer, and no existing real asset is present at $existing_path" >&2
  echo "Seed the runtime asset outside Git LFS or restore LFS access before deploying this commit." >&2
  exit 1
done < <(find "$STAGING_DIR/dist" -type f -print0)

LFS_POINTER_EXCLUDES=()
while IFS= read -r -d '' path; do
  if ! LC_ALL=C grep -aq '^version https://git-lfs.github.com/spec/v1$' "$path"; then
    continue
  fi

  rel_path="${path#"$STAGING_DIR/dist/"}"
  existing_path="$WEB_ROOT/$rel_path"

  if [ -f "$existing_path" ] && ! LC_ALL=C grep -aq '^version https://git-lfs.github.com/spec/v1$' "$existing_path"; then
    log "Preserving existing runtime asset $rel_path; staged file is a Git LFS pointer"
    LFS_POINTER_EXCLUDES+=("--exclude=$rel_path")
    continue
  fi

  echo "ERROR: staged $rel_path is a Git LFS pointer, and no existing real asset is present at $existing_path" >&2
  echo "Seed the runtime asset outside Git LFS or restore LFS access before deploying this commit." >&2
  exit 1
done < <(find "$STAGING_DIR/dist" -type f -print0)

log "Syncing client bundle to $WEB_ROOT..."
sudo mkdir -p "$WEB_ROOT"
# Checksum unchanged files and leave their existing mtimes alone in the web
# root. This lets browser validators reuse cached runtime assets when a
# code-only PR ships a fresh bundle.
sudo rsync -a --checksum --no-times --delete "${LFS_POINTER_EXCLUDES[@]}" "$STAGING_DIR/dist/" "$WEB_ROOT/"
sudo chown -R www-data:www-data "$WEB_ROOT"

log "Cleaning up $STAGING_DIR..."
rm -rf "$STAGING_DIR"

log "Done."
