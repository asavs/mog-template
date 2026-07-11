#!/bin/bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
echo "Building client in $REPO_ROOT/client..."
cd "$REPO_ROOT/client"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
if [ -d dist ]; then
  sudo chown -R "$(id -u):$(id -g)" dist
fi
npm run build
sudo mkdir -p /var/www/mog
sudo cp -r dist/* /var/www/mog/
sudo chown -R www-data:www-data /var/www/mog
echo "Client built and deployed to /var/www/mog"
