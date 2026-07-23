# Preview VM SSH / OS Login

How GitHub Actions reaches ephemeral preview VMs (`mog-pr-<N>`) and what to do
when deploy fails with **Permission denied (publickey)**.

## Config: secrets vs variables vs GCE (clean model)

| Layer | What | Examples |
|---|---|---|
| **GitHub Secrets** | Who Actions is + which project | `GCP_SERVICE_ACCOUNT`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_PROJECT` |
| **GitHub Variables** | Knobs (not confidential) | `ZONE`, `MACHINE_TYPE`, `PREVIEW_DB_NAME`, `IMAGE_FAMILY`, `PREVIEW_USE_IAP`, `PREVIEW_DELETE_ON_FAIL` |
| **GCE default** | VM identity if you don’t override | Project default compute SA — **leave unset** |
| **Optional Variable** | Only if the VM must not use the default SA | `PREVIEW_VM_SA` = full SA email (not a secret, just config) |

**Do not** put the default `…-compute@developer.gserviceaccount.com` email into Secrets
or invent it in bash from a project-number lookup. Let GCE attach the default when
`PREVIEW_VM_SA` is unset. That is the idiomatic path and the one that creates VMs
successfully.

Optional later: move the three `GCP_*` secrets into a GitHub **Environment**
named `preview` for stage isolation. Repo-level secrets are fine for a single
project.

`scripts/setup-deploy-infra.sh` is what should create the deploy SA and write
those Secrets once. Day-to-day deploys only *consume* them.

## How deploy SSH works

1. Workflow becomes the **deploy service account** via Workload Identity Federation  
   (`secrets.GCP_SERVICE_ACCOUNT` + WIF provider).
2. `scripts/preview-up.sh` runs `gcloud compute ssh` / `scp` against the VM.
3. Instances use `enable-oslogin=true` — no static SSH keys in metadata.
4. OS Login usernames for service accounts look like `sa_<digits>` in error logs.

## Required IAM (project)

On the deploy SA (e.g. `github-actions-deploy@PROJECT_ID.iam.gserviceaccount.com`):

| Role | Why |
|---|---|
| `roles/compute.osAdminLogin` | Passwordless SSH **and** sudo (apply uses sudo) |
| `roles/compute.viewer` | Describe / list instances |
| `roles/iam.serviceAccountUser` on the **VM’s attached** SA | `gcloud compute ssh` actAs |

Also: instance create/delete + image use (see `setup-deploy-infra.sh` / `deploy-your-vm.md`).

Grant actAs on the SA that is **actually** on the VM (default compute SA unless
you set `PREVIEW_VM_SA`):

```bash
# Resolve the default compute SA in your project:
#   gcloud iam service-accounts list --filter='email~compute@developer'

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:github-actions-deploy@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/compute.osAdminLogin"

gcloud iam service-accounts add-iam-policy-binding \
  PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --project=PROJECT_ID \
  --member="serviceAccount:github-actions-deploy@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

## Hardening behavior (`preview-up.sh`)

| Behavior | Control |
|---|---|
| Retry SSH and SCP with backoff | always on |
| Re-probe before large artifact upload | always on |
| Fail if SSH never becomes ready | always on (no silent fall-through) |
| Last-5 probe snippets + checklist on failure | always on |
| Split wasm / dist scp | always on |
| IAP tunnel | Variable `PREVIEW_USE_IAP=true` (+ IAP IAM/firewall) |
| Custom VM SA | Variable `PREVIEW_VM_SA` (email); unset = GCE default |
| On fail: delete VM vs leave labeled | Variable `PREVIEW_DELETE_ON_FAIL` (default leave + `deploy-failed=true`) |

## Failure mode: Permission denied (publickey)

Typical sequence:

- VM create succeeds.
- An early hop may work; a later hop fails as `sa_…@…: Permission denied (publickey)`.

Common causes: OS Login IAM lag, missing `osAdminLogin` / `actAs`, guest agent not
ready, rare scp flake (mitigated by retries + split uploads).

### Ops recovery

```bash
gh workflow run "Preview VM up" --repo OWNER/REPO -f pr=NN

bash scripts/preview-down.sh NN   # free a half-dead VM
gh workflow run "Preview VM up" --repo OWNER/REPO -f pr=NN
```

## Public-repo hygiene

- Placeholders in docs (`PROJECT_ID`), not real project numbers or SA emails  
- Prefer not pasting long-lived IPs or full `sa_<digits>` into issues  
- Preview announce URLs are fine (ephemeral)  
- Salvage logs omit NAT IPs; use `gcloud compute instances describe`

## Related

- `scripts/preview-up.sh` — create / deploy / announce  
- `scripts/preview-bootstrap.sh` — lean runtime on the VM  
- `scripts/setup-deploy-infra.sh` — one-time SA + Secrets  
- `docs/deploy-your-vm.md` — full VM setup  
- `docs/dev-pipeline.md` — when preview-up runs  
