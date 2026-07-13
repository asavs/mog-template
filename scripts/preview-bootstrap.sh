#!/usr/bin/env bash
#
# preview-bootstrap.sh — lean, runtime-only provision of a fresh preview VM.
#
# This runs ON the preview VM (staged there and invoked over SSH by
# preview-up.sh, or run by hand after `gcloud compute ssh`). It is a strict
# RUNTIME subset of scripts/setup-deploy-infra.sh: only what a player's browser
# needs to reach the game. Deliberately NO Node, NO Rust, NO git, NO reviewer
# stack, NO multi-env beta/prod roots — see the preview-VM factory plan v1
# (§3 and §9).
#
# Installs:
#   - nginx, curl, rsync
#   - ufw allowing ONLY 22 (SSH) and 80 (HTTP); 3000 is never public
#   - SpacetimeDB CLI + standalone under /stdb (user `spacetimedb`), systemd
#     unit listening on 127.0.0.1:3000 ONLY (loopback)
#   - web root /var/www/mog
#   - nginx site: static / + reverse-proxy ONLY /v1/identity and /v1/database/
#     to the loopback SpacetimeDB, with websocket upgrade on the database path
#
# Idempotent: safe to re-run. Drops a sentinel at /var/lib/mog-preview/provisioned
# so preview-up.sh can skip a re-provision on VM reuse.
#
set -euo pipefail

SENTINEL=/var/lib/mog-preview/provisioned

if [ "${FORCE_PROVISION:-false}" != "true" ] && [ -f "$SENTINEL" ]; then
  echo "preview-bootstrap: already provisioned ($SENTINEL present); skipping."
  exit 0
fi

echo "preview-bootstrap: starting lean runtime provision..."

# --- base packages (runtime only) ---
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nginx curl rsync ufw

# --- firewall: SSH + HTTP only, SpacetimeDB never public (plan §10) ---
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw --force enable

# --- SpacetimeDB user + CLI under /stdb (layout matches apply-artifacts.sh) ---
id spacetimedb >/dev/null 2>&1 || \
  sudo useradd --system --create-home --home-dir /stdb --shell /usr/sbin/nologin spacetimedb

if [ ! -x /stdb/spacetime ]; then
  sudo -u spacetimedb -H bash -c 'cd /stdb && curl -sSf https://install.spacetimedb.com | sh -s -- --yes'
  sudo -u spacetimedb -H bash -c '
    set -euo pipefail
    SRC_DIR=$(find /stdb/.local/share/spacetime/bin -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)
    VER=$(basename "$SRC_DIR")
    mkdir -p "/stdb/bin/$VER"
    cp "$SRC_DIR/spacetimedb-cli" "/stdb/bin/$VER/spacetimedb-cli"
    ln -sfn "$VER" /stdb/bin/current
    cp "$SRC_DIR/spacetimedb-cli" /stdb/spacetime
    cp "$SRC_DIR/spacetimedb-standalone" /stdb/spacetimedb-standalone
    chmod +x /stdb/spacetime /stdb/spacetimedb-standalone "/stdb/bin/$VER/spacetimedb-cli"
    mkdir -p /stdb/config /stdb/data
  '
fi

# --- systemd service, loopback-only (never 0.0.0.0) ---
sudo tee /etc/systemd/system/spacetimedb.service >/dev/null <<'UNIT'
[Unit]
Description=SpacetimeDB Server (preview)
After=network.target

[Service]
ExecStart=/stdb/spacetime --root-dir=/stdb start --listen-addr=127.0.0.1:3000
Restart=always
User=spacetimedb
WorkingDirectory=/stdb

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now spacetimedb

# --- single web root (no /beta, no /prod split on a preview box) ---
sudo mkdir -p /var/www/mog
sudo chown -R www-data:www-data /var/www/mog

# --- nginx: static / + ONLY the two SpacetimeDB routes the client needs ---
sudo tee /etc/nginx/sites-available/mog >/dev/null <<'NGINX'
server {
    listen 80;
    server_name _;

    root /var/www/mog;
    index index.html;

    gzip on;
    gzip_vary on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_types application/javascript text/css application/json image/svg+xml model/gltf-binary application/octet-stream application/wasm;

    location / {
        add_header Cache-Control "no-cache";
        try_files $uri $uri/ /index.html;
    }

    location /v1/identity {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /v1/database/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
NGINX
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sfn /etc/nginx/sites-available/mog /etc/nginx/sites-enabled/mog
sudo nginx -t && sudo systemctl restart nginx && sudo systemctl enable nginx >/dev/null 2>&1

# --- sentinel for skip-if-provisioned on VM reuse ---
sudo mkdir -p "$(dirname "$SENTINEL")"
sudo touch "$SENTINEL"

echo "preview-bootstrap: provisioning complete."
