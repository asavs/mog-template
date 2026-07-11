#!/usr/bin/env bash
set -euo pipefail

REPO="${1:?usage: check-ci.sh <owner/repo> <head-sha> [required-checks-file]}"
HEAD_SHA="${2:?usage: check-ci.sh <owner/repo> <head-sha> [required-checks-file]}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIRED_CHECKS_FILE="${3:-$SCRIPT_DIR/required-checks.json}"

if [ -n "${REQUIRED_CHECKS_JSON:-}" ]; then
  required_checks_json="$REQUIRED_CHECKS_JSON"
else
  required_checks_json=$(jq -c . "$REQUIRED_CHECKS_FILE")
fi

printf '%s' "$required_checks_json" |
  jq -e 'type == "array" and length > 0 and all(.[]; type == "string" and length > 0)' >/dev/null

gh api "repos/$REPO/commits/$HEAD_SHA/check-runs?filter=latest&per_page=100" |
  jq -r --argjson required "$required_checks_json" '
    def required_check($name):
      [.check_runs[] | select(.name == $name)]
      | sort_by(.started_at // .completed_at // "")
      | last;

    [$required[] as $name | {name: $name, check: required_check($name)}] as $checks
    | if any($checks[]; .check == null) then "incomplete"
      elif any($checks[]; .check.status != "completed") then "pending"
      elif all($checks[]; .check.conclusion == "success") then "success"
      else "failing" end
  '
