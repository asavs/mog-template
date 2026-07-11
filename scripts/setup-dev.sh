#!/bin/bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
echo "Setting up development environment in $REPO_ROOT..."

# 1. Mark directory as safe to prevent "dubious ownership" errors in shared environment
echo "Marking directory as safe for git..."
git config --global --add safe.directory /srv/mog-template

# 2. Configure Git to use the hooks in scripts/git-hooks
echo "Configuring shared git hooks..."
git config core.hooksPath scripts/git-hooks

# 3. Ensure current permissions are open
"$REPO_ROOT/scripts/fix-permissions.sh"

# 4. Success message
echo ""
echo "Setup complete!"
echo "Permissions will now auto-fix on every git pull or branch switch."
