#!/usr/bin/env bash
#
# setup-deploy-infra.sh — one-command bootstrap of the GCP + GitHub deploy
# infrastructure this template's workflows expect. Automates the manual steps
# in docs/deploy-your-vm.md end to end.
#
# Idempotent: every step checks for existing resources before creating, so it
# is safe to re-run after a partial failure.
#
# Usage:
#   PROJECT_ID=my-proj GITHUB_REPO=me/mog-template ./scripts/setup-deploy-infra.sh
#
# Required env:
#   PROJECT_ID     GCP project id (existing, or pass CREATE_PROJECT=true to make it)
#   GITHUB_REPO    GitHub "<owner>/<repo>" the deploy workflows live in
#
# Optional env (defaults in brackets):
#   ZONE [us-central1-a]        MACHINE_TYPE [e2-small]      SWAP_SIZE [2G]
#   VM_NAME [mog-server]        # MUST match the name hardcoded in the workflows
#   BILLING_ACCOUNT []          # link this billing account (needed for a new project)
#   CREATE_PROJECT [false]      # create PROJECT_ID if it does not exist
#   ASSUME_YES [false]          # skip confirmation prompts (unattended/agent runs)
#
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?PROJECT_ID is required}"
GITHUB_REPO="${GITHUB_REPO:?GITHUB_REPO (\"<owner>/<repo>\") is required}"
ZONE="${ZONE:-us-central1-a}"
VM_NAME="${VM_NAME:-mog-server}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-small}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
POOL="${POOL:-github-actions}"
PROVIDER="${PROVIDER:-github}"
SA_NAME="${SA_NAME:-github-actions-deploy}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"
CREATE_PROJECT="${CREATE_PROJECT:-false}"
ASSUME_YES="${ASSUME_YES:-false}"

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
confirm() {
  [ "$ASSUME_YES" = "true" ] && return 0
  read -r -p "    $1 [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ]
}
gc() { gcloud --project="$PROJECT_ID" "$@"; }

# ---------------------------------------------------------------- preflight
command -v gcloud >/dev/null || die "gcloud not found on PATH"
command -v gh >/dev/null || die "gh not found on PATH"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated (run: gh auth login)"
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
  || die "no active gcloud account (run: gcloud auth login)"

log "Deploy infra bootstrap"
info "project=$PROJECT_ID  repo=$GITHUB_REPO"
info "vm=$VM_NAME  zone=$ZONE  machine=$MACHINE_TYPE  swap=$SWAP_SIZE"
confirm "This creates billable GCP resources. Continue?" || die "aborted by user"

# --------------------------------------------------- project + billing + APIs
if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  [ "$CREATE_PROJECT" = "true" ] || die "project '$PROJECT_ID' not found (pass CREATE_PROJECT=true to create it)"
  log "Creating project $PROJECT_ID"
  gcloud projects create "$PROJECT_ID"
fi
if [ -n "$BILLING_ACCOUNT" ]; then
  log "Linking billing account $BILLING_ACCOUNT"
  gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
fi

log "Enabling required APIs"
gc services enable compute.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

# ------------------------------------------------------------------ firewall
log "Firewall rules (ssh / http / https)"
fw_exists() { gc compute firewall-rules describe "$1" >/dev/null 2>&1; }
fw_exists allow-ssh   || gc compute firewall-rules create allow-ssh   --network=default --direction=INGRESS --action=ALLOW --rules=tcp:22  --source-ranges=0.0.0.0/0
fw_exists allow-http  || gc compute firewall-rules create allow-http  --network=default --direction=INGRESS --action=ALLOW --rules=tcp:80  --source-ranges=0.0.0.0/0 --target-tags=http-server
fw_exists allow-https || gc compute firewall-rules create allow-https --network=default --direction=INGRESS --action=ALLOW --rules=tcp:443 --source-ranges=0.0.0.0/0 --target-tags=https-server

# ------------------------------------------------------------------ VM create
if gc compute instances describe "$VM_NAME" --zone="$ZONE" >/dev/null 2>&1; then
  log "VM $VM_NAME already exists — skipping create"
else
  log "Creating VM $VM_NAME ($MACHINE_TYPE, debian-12)"
  gc compute instances create "$VM_NAME" --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size=20GB --boot-disk-type=pd-standard \
    --tags=http-server,https-server --metadata=enable-oslogin=true
  info "waiting for SSH to become available..."
  for _ in $(seq 1 30); do
    gc compute ssh "$VM_NAME" --zone="$ZONE" --command=true --quiet >/dev/null 2>&1 && break
    sleep 10
  done
fi

# --------------------------------------------- provision VM (idempotent, remote)
log "Provisioning VM (swap, nginx, SpacetimeDB) — this runs over SSH"
gc compute ssh "$VM_NAME" --zone="$ZONE" --quiet \
  --command="SWAP_SIZE='$SWAP_SIZE' bash -s" <<'REMOTE'
set -euo pipefail

# --- swap (small instances are RAM-tight) ---
if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l "${SWAP_SIZE:-2G}" /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# --- base packages ---
sudo apt-get update -y
sudo apt-get install -y nginx curl rsync

# --- SpacetimeDB user + CLI under /stdb (load-bearing path) ---
id spacetimedb >/dev/null 2>&1 || \
  sudo useradd --system --create-home --home-dir /stdb --shell /usr/sbin/nologin spacetimedb

if [ ! -x /stdb/spacetime ]; then
  sudo -u spacetimedb -H bash -c 'cd /stdb && curl -sSf https://install.spacetimedb.com | sh -s -- --yes'
  sudo -u spacetimedb -H bash -c '
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

# --- systemd service, loopback-only ---
sudo tee /etc/systemd/system/spacetimedb.service >/dev/null <<'UNIT'
[Unit]
Description=SpacetimeDB Server
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

# --- web roots ---
sudo mkdir -p /var/www/mog /var/www/mog-beta
sudo chown -R www-data:www-data /var/www/mog /var/www/mog-beta

# --- nginx (SPA + beta subpath + SpacetimeDB reverse proxy) ---
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

    location /beta/ {
        alias /var/www/mog-beta/;
        index index.html;
        add_header Cache-Control "no-cache";
        try_files $uri $uri/ /beta/index.html;
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

echo "VM provisioning complete."
REMOTE

# ------------------------------------------ Workload Identity Federation + SA
log "Workload Identity Federation pool + provider"
gc iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 \
  || gc iam workload-identity-pools create "$POOL" --location=global --display-name="GitHub Actions"

gc iam workload-identity-pools providers describe "$PROVIDER" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1 \
  || gc iam workload-identity-pools providers create-oidc "$PROVIDER" --location=global \
       --workload-identity-pool="$POOL" --display-name="GitHub OIDC" \
       --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
       --attribute-condition="assertion.repository == '${GITHUB_REPO}'" \
       --issuer-uri="https://token.actions.githubusercontent.com"

log "Deploy service account + IAM (least privilege)"
gc iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 \
  || gc iam service-accounts create "$SA_NAME" --display-name="GitHub Actions Deploy"

# Let this repo's Actions runs impersonate the SA (scoped to the exact repo).
gc iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_REPO}" >/dev/null

# SSH + passwordless sudo on the VM via OS Login, plus instance lookup.
gc projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA_EMAIL" --role="roles/compute.osAdminLogin" --condition=None >/dev/null
gc projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA_EMAIL" --role="roles/compute.viewer"     --condition=None >/dev/null

# CRITICAL: `gcloud compute ssh` impersonates the VM's ATTACHED service account,
# so the deploy SA needs actAs on it. Without this the deploy fails INSTANTLY at
# the Stage step: "PERMISSION_DENIED ... iam.serviceAccounts.actAs".
VM_SA=$(gc compute instances describe "$VM_NAME" --zone="$ZONE" --format='value(serviceAccounts[0].email)')
gc iam service-accounts add-iam-policy-binding "$VM_SA" \
  --member="serviceAccount:$SA_EMAIL" --role="roles/iam.serviceAccountUser" >/dev/null

# --------------------------------------------------------- GitHub repo secrets
log "Setting GitHub Actions secrets on $GITHUB_REPO"
gh secret set GCP_PROJECT         -R "$GITHUB_REPO" -b "$PROJECT_ID"
gh secret set GCP_SERVICE_ACCOUNT -R "$GITHUB_REPO" -b "$SA_EMAIL"
gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER -R "$GITHUB_REPO" \
  -b "projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

# -------------------------------------------------------------------- summary
IP=$(gc compute instances describe "$VM_NAME" --zone="$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
log "Bootstrap complete."
info "VM external IP : $IP"
info "Deploy SA      : $SA_EMAIL"
info ""
info "Trigger the first deploy:"
info "  gh workflow run prod-deploy.yml -R $GITHUB_REPO --ref master"
info "  gh run watch -R $GITHUB_REPO"
info ""
info "The first deploy publishes and takes ownership of the SpacetimeDB databases"
info "(single-publisher model). If you later need MULTIPLE identities to publish,"
info "set up the shared /stdb/config/cli.toml — see docs/deploy-your-vm.md section 5."
