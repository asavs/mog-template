#!/usr/bin/env bash
set -euo pipefail

# VM runtime cleanup. This removes only regenerated or transient files.
# It must not delete web roots or SpacetimeDB data.

DRY_RUN="${MOG_CLEANUP_DRY_RUN:-0}"
DEPLOY_DAYS="${MOG_CLEANUP_DEPLOY_DAYS:-2}"
BUILD_DAYS="${MOG_CLEANUP_BUILD_DAYS:-2}"
NPM_CACHE_DAYS="${MOG_CLEANUP_NPM_CACHE_DAYS:-7}"
GEMINI_TMP_DAYS="${MOG_CLEANUP_GEMINI_TMP_DAYS:-7}"

log() { printf '[cleanup] %s\n' "$*"; }

validate_number() {
  local name="$1"
  local value="$2"
  case "$value" in
    ''|*[!0-9]*)
      log "ERROR: $name must be a non-negative integer, got '$value'"
      exit 1
      ;;
  esac
}

for pair in \
  "MOG_CLEANUP_DEPLOY_DAYS:$DEPLOY_DAYS" \
  "MOG_CLEANUP_BUILD_DAYS:$BUILD_DAYS" \
  "MOG_CLEANUP_NPM_CACHE_DAYS:$NPM_CACHE_DAYS" \
  "MOG_CLEANUP_GEMINI_TMP_DAYS:$GEMINI_TMP_DAYS"; do
  validate_number "${pair%%:*}" "${pair#*:}"
done

is_protected_path() {
  case "$1" in
    /var/www/mog|/var/www/mog/*|\
    /var/www/mog-beta|/var/www/mog-beta/*|\
    /stdb|/stdb/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

remove_path() {
  local path="$1"

  [ -e "$path" ] || return 0
  if is_protected_path "$path"; then
    log "refusing protected path: $path"
    return 1
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log "dry-run remove $path"
  else
    log "remove $path"
    rm -rf -- "$path"
  fi
}

cleanup_tmp_deploys() {
  find /tmp -maxdepth 1 -type d -name 'deploy-*' -mtime +"$DEPLOY_DAYS" -print0 2>/dev/null |
    while IFS= read -r -d '' path; do
      remove_path "$path"
    done
}

cleanup_build_outputs() {
  [ -d /srv/mog-template ] || return 0

  find /srv/mog-template \
    -path '/srv/mog-template/example code folder' -prune -o \
    -type d \( -path '*/client/dist' -o -path '*/server/spacetimedb/target' \) \
    -mtime +"$BUILD_DAYS" -print0 2>/dev/null |
    while IFS= read -r -d '' path; do
      remove_path "$path"
    done
}

cleanup_npm_caches() {
  for cache_dir in /root/.npm/_cacache /root/.npm/_npx /home/*/.npm/_cacache /home/*/.npm/_npx; do
    [ -d "$cache_dir" ] || continue
    find "$cache_dir" -mindepth 1 -mtime +"$NPM_CACHE_DAYS" -print0 2>/dev/null |
      while IFS= read -r -d '' path; do
        remove_path "$path"
      done
  done
}

cleanup_gemini_tmp_errors() {
  find /tmp -maxdepth 1 -type f -name 'gemini-client-error-*' -mtime +"$GEMINI_TMP_DAYS" -print0 2>/dev/null |
    while IFS= read -r -d '' path; do
      remove_path "$path"
    done
}

cleanup_tmp_deploys
cleanup_build_outputs
cleanup_npm_caches
cleanup_gemini_tmp_errors

log "done"
