# Deploy your own instance

This guide walks through standing up the cloud infrastructure this template's
GitHub Actions workflows expect, so `git push` to `master` (or a PR review
approval, for the beta/preview environment) deploys automatically to your own
VM.

It provisions a single small VM running SpacetimeDB + Nginx, and wires up
GitHub Actions to reach it over SSH using Workload Identity Federation (no
long-lived service account keys). Everything is HTTP-only for now — TLS/
Certbot is a separate follow-up.

## Automated path

`scripts/setup-deploy-infra.sh` runs every step below end to end (idempotent,
safe to re-run). If you'd rather not do it by hand:

```sh
PROJECT_ID=<your-project> GITHUB_REPO=<owner>/<repo> \
  CREATE_PROJECT=true BILLING_ACCOUNT=<XXXXXX-XXXXXX-XXXXXX> \
  ./scripts/setup-deploy-infra.sh
```

Then trigger the first deploy (`gh workflow run prod-deploy.yml -R <owner>/<repo>
--ref master`). The rest of this document explains what that script does and how
to do it manually.

## Prerequisites

- A GCP project with billing enabled, and the `gcloud` CLI authenticated
  against it (`gcloud auth login`, `gcloud config set project <PROJECT_ID>`).
- A GitHub repo containing this template, with `gh` authenticated against it.
- This repo's two deploy workflows already in `.github/workflows/`:
  `prod-deploy.yml` and `preview-deploy.yml`. **Both hardcode the VM name
  `mog-server` and zone `us-central1-a`** — either use those exact values, or
  edit the workflows to match whatever you choose. (A cleaner template would
  parameterize these via repo `vars`; today they're hardcoded.)

Replace every `<placeholder>` below with your own values. Nothing here should
be copy-pasted verbatim.

## 1. Project setup

```sh
gcloud services enable \
  compute.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project=<PROJECT_ID>
```

Firewall rules — SSH, HTTP, HTTPS only. Port 3000 (SpacetimeDB) stays
internal; Nginx reverse-proxies to it.

```sh
gcloud compute firewall-rules create allow-ssh --project=<PROJECT_ID> \
  --network=default --direction=INGRESS --action=ALLOW --rules=tcp:22 \
  --source-ranges=0.0.0.0/0

gcloud compute firewall-rules create allow-http --project=<PROJECT_ID> \
  --network=default --direction=INGRESS --action=ALLOW --rules=tcp:80 \
  --source-ranges=0.0.0.0/0 --target-tags=http-server

gcloud compute firewall-rules create allow-https --project=<PROJECT_ID> \
  --network=default --direction=INGRESS --action=ALLOW --rules=tcp:443 \
  --source-ranges=0.0.0.0/0 --target-tags=https-server
```

## 2. Create the VM

The workflows hardcode the name `mog-server` in zone `us-central1-a`.

```sh
gcloud compute instances create mog-server \
  --project=<PROJECT_ID> \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=20GB \
  --boot-disk-type=pd-standard \
  --tags=http-server,https-server \
  --metadata=enable-oslogin=true
```

`e2-small` (2 vCPU-burst / 2GB RAM) is a safe minimum — SpacetimeDB plus a
Rust build's memory footprint has been observed to OOM smaller shapes. If
you want to try something free-tier eligible (`e2-micro`, 1GB RAM), budget a
larger swapfile (4GB+) and expect it to be tighter under load; it is not the
tested/recommended shape.

`enable-oslogin=true` is required — the deploy workflow authenticates via
IAM (Workload Identity Federation + OS Login), not SSH keys baked into
instance metadata.

## 3. Provision the VM

SSH in (`gcloud compute ssh mog-server --project=<PROJECT_ID>
--zone=us-central1-a`) and set up the pieces the deploy script
(`scripts/apply-artifacts.sh`) expects to already exist.

### 3a. Swap

RAM is tight on small instances. Add swap before installing anything:

```sh
sudo fallocate -l 2G /swapfile   # use 4G on e2-micro
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 3b. Base packages

```sh
sudo apt-get update -y
sudo apt-get install -y nginx curl rsync
```

### 3c. SpacetimeDB

Create a dedicated system user with its home directory at `/stdb` — this
path is load-bearing: `scripts/apply-artifacts.sh` looks for the CLI under
`/stdb/bin/*/spacetimedb-cli` and the shared publish config at
`/stdb/config/cli.toml`.

```sh
sudo useradd --system --create-home --home-dir /stdb --shell /usr/sbin/nologin spacetimedb
```

Install the CLI as that user:

```sh
sudo -u spacetimedb -H bash -c '
  cd /stdb
  curl -sSf https://install.spacetimedb.com | sh -s -- --yes
'
```

The installer puts the versioned CLI + standalone server binaries under
`/stdb/.local/share/spacetime/bin/<version>/`. Lay them out where the deploy
script and systemd unit expect them:

```sh
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
```

Note: `spacetime start` execs a sibling `spacetimedb-standalone` binary from
the same directory as the `spacetime` binary it was launched from — that's
why it's copied to `/stdb/spacetimedb-standalone` directly, not just into the
versioned `bin/` subdirectory.

systemd service, bound to loopback only (Nginx fronts it):

```sh
sudo tee /etc/systemd/system/spacetimedb.service >/dev/null <<'EOF'
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
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now spacetimedb
```

### 3d. Web roots + Nginx

Two web roots — prod and beta/preview — matching the DB names each
workflow deploys to (`mog-game-v1` / `mog-game-beta`):

```sh
sudo mkdir -p /var/www/mog /var/www/mog-beta
sudo chown -R www-data:www-data /var/www/mog /var/www/mog-beta
```

Nginx config: serve `/var/www/mog` at `/`, `/var/www/mog-beta` at `/beta/`,
and reverse-proxy SpacetimeDB's HTTP API. Adjust asset paths
(`/assets/`, `/models/`, etc.) to match your client's actual build output.

```nginx
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
```

```sh
sudo tee /etc/nginx/sites-available/mog >/dev/null <<'EOF'
# (paste the config above)
EOF
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sfn /etc/nginx/sites-available/mog /etc/nginx/sites-enabled/mog
sudo nginx -t && sudo systemctl restart nginx && sudo systemctl enable nginx
```

Verify: `curl http://127.0.0.1:3000/v1/identity` should return `405` (wrong
method, but reachable) and `curl http://<vm-external-ip>/` should return your
placeholder/empty web root.

## 4. Workload Identity Federation + deploy service account

This lets GitHub Actions authenticate to GCP without a long-lived key.

```sh
gcloud iam workload-identity-pools create github-actions \
  --project=<PROJECT_ID> --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github \
  --project=<PROJECT_ID> --location=global \
  --workload-identity-pool=github-actions \
  --display-name="GitHub OIDC" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository == '<GITHUB_ORG>/<GITHUB_REPO>'" \
  --issuer-uri="https://token.actions.githubusercontent.com"
```

The `--attribute-condition` scopes token exchange to *this exact repo* —
tighter than trusting the whole GitHub org/owner.

```sh
gcloud iam service-accounts create github-actions-deploy \
  --project=<PROJECT_ID> --display-name="GitHub Actions Deploy"

gcloud iam service-accounts add-iam-policy-binding \
  github-actions-deploy@<PROJECT_ID>.iam.gserviceaccount.com \
  --project=<PROJECT_ID> \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github-actions/attribute.repository/<GITHUB_ORG>/<GITHUB_REPO>"
```

Grant the minimum roles needed to SSH/SCP into the VM via OS Login — not
Owner or Editor:

```sh
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:github-actions-deploy@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/compute.osAdminLogin"

gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:github-actions-deploy@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/compute.viewer"

# `gcloud compute ssh` impersonates the VM's ATTACHED service account, so the
# deploy SA also needs actAs on it. By default the VM runs as the Compute
# Engine default SA (<PROJECT_NUMBER>-compute@developer.gserviceaccount.com).
# Without this the Stage step fails INSTANTLY (before any SSH) with:
#   "PERMISSION_DENIED: ... does not have iam.serviceAccounts.actAs
#    permission on the instance's service account".
gcloud iam service-accounts add-iam-policy-binding \
  <PROJECT_NUMBER>-compute@developer.gserviceaccount.com \
  --project=<PROJECT_ID> \
  --member="serviceAccount:github-actions-deploy@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

`osAdminLogin` (rather than plain `osLogin`) is what grants passwordless
sudo on the VM — required because `apply-artifacts.sh` runs `mkdir`,
`rsync`, and `chown` under `sudo`. This works because OS Login
automatically adds authorized principals to a `google-sudoers` group with
`NOPASSWD:ALL` in `/etc/sudoers.d/`; no manual sudoers editing needed.

**Note on IAM propagation:** OS Login's permission check has been observed
to lag several minutes behind a fresh IAM binding — longer than typical GCP
IAM propagation. If SSH fails immediately after granting these roles with
"does not have login permission," wait and retry before assuming
misconfiguration.

## 5. SpacetimeDB publish identity

The deploy script publishes as whatever OS Login user connects — by
default that's an anonymous per-user identity with no ownership of your
databases, which fails with 403 on publish. Fix this by creating one shared
identity that owns both databases, and pointing all publishers at it via
`/stdb/config/cli.toml`.

Bootstrap it once (as the `spacetimedb` user, or any user that can reach
`127.0.0.1:3000`) by publishing a real build of your server module — this
both creates the identity/token *and* creates the databases:

```sh
sudo -u spacetimedb -H bash -c '
  export HOME=/stdb
  /stdb/spacetime publish --server local --bin-path /path/to/server.wasm --yes mog-game-v1
  /stdb/spacetime publish --server local --bin-path /path/to/server.wasm --yes mog-game-beta
'
```

This writes a token to `/stdb/.config/spacetime/cli.toml`. Share it project-
wide (readable by any OS Login user, including the deploy SA) at the path
`scripts/apply-artifacts.sh` looks for:

```sh
sudo install -d -m 775 /stdb/config
sudo install -m 664 /stdb/.config/spacetime/cli.toml /stdb/config/cli.toml
sudo chgrp nogroup /stdb/config/cli.toml
```

(`scripts/setup-shared-spacetime-config.sh` in this repo automates this
install step from an existing config file, if you'd rather use that.)

## 6. GitHub repo secrets

Set on the repo the workflows live in:

```sh
gh secret set GCP_PROJECT -R <GITHUB_ORG>/<GITHUB_REPO> -b "<PROJECT_ID>"
gh secret set GCP_SERVICE_ACCOUNT -R <GITHUB_ORG>/<GITHUB_REPO> \
  -b "github-actions-deploy@<PROJECT_ID>.iam.gserviceaccount.com"
gh secret set GCP_WORKLOAD_IDENTITY_PROVIDER -R <GITHUB_ORG>/<GITHUB_REPO> \
  -b "projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github-actions/providers/github"
```

## 7. First deploy

```sh
gh workflow run prod-deploy.yml -R <GITHUB_ORG>/<GITHUB_REPO> --ref master
gh run watch -R <GITHUB_ORG>/<GITHUB_REPO>
```

If it fails, `gh run view --log-failed -R <GITHUB_ORG>/<GITHUB_REPO>` shows
which step. Once green, `http://<vm-external-ip>/` should serve the client
and the module should be live on `mog-game-v1`.

Runtime assets (models, skybox) are stored in Git LFS. The deploy workflows
check out with `lfs: true` so every deploy ships the real assets — a fresh VM
needs no manual asset seeding. If LFS is unavailable at deploy time,
`apply-artifacts.sh` skips the unresolved pointer with a warning (preserving
any already-deployed real asset) rather than hard-failing; but note the
client hard-requires its assets, so a deploy that ships without them will
load and then crash the 3D scene.

## Troubleshooting

**`spacetime publish` returns 403 / "not the owner"** — the connecting
user's default identity doesn't own the database. Re-check step 5: is
`/stdb/config/cli.toml` present, world-readable, and does it contain a
`spacetimedb_token` line? `scripts/apply-artifacts.sh` only picks it up if
that grep succeeds.

**Stage step fails with `iam.serviceAccounts.actAs` PERMISSION_DENIED** — the
deploy SA is missing `roles/iam.serviceAccountUser` on the VM's *attached*
service account (step 4, the last grant). This fails immediately, before any
SSH handshake, and is the single most common miss.

**SSH/sudo fails from the workflow** — confirm the deploy SA has
`roles/compute.osAdminLogin` (not just `osLogin`) at the project level, and
that the WIF provider's `--attribute-condition` matches the repo exactly
(`<org>/<repo>`, case-sensitive). Recheck after a few minutes — OS Login
permission propagation can lag.

**Deploy fails with "staged ... is a Git LFS pointer"** — the checkout didn't
fetch LFS objects, so an asset shipped as a pointer file. The workflows set
`lfs: true` for exactly this reason; if you changed it, restore it. (The
apply script will otherwise skip the asset with a warning, and the client
will crash on the missing model.)

**VM runs out of memory / SpacetimeDB gets OOM-killed** — check
`free -h` and `sudo systemctl status spacetimedb`. Increase the swapfile
size, or move to a larger machine type; `e2-small` is the tested minimum.

**GitHub Actions won't start any job at all** ("The job was not started ...
spending limit needs to be increased") — this is GitHub Actions minutes, not
GCP. Private repos draw from a limited monthly minute quota; **public repos
get unlimited free minutes on standard runners.** Either make the repo public
or raise the spending limit in GitHub → Billing & plans.
