# Preview VM SSH / OS Login

How GitHub Actions reaches ephemeral preview VMs (`mog-pr-<N>`) and what to do
when deploy fails with **Permission denied (publickey)**.

## How deploy SSH works

1. `preview-up.yml` authenticates as the **GitHub Actions deploy service account**
   via Workload Identity Federation.
2. `scripts/preview-up.sh` runs `gcloud compute ssh` / `scp` against the VM.
3. Instances are created with `enable-oslogin=true`. There are **no** static
   SSH keys in metadata; identity is IAM + OS Login.
4. The OS Login username looks like `sa_<numeric-id>` when the principal is a
   service account (what you see in failed scp logs).

## Required IAM (project)

On the deploy SA (e.g. `github-actions-deploy@PROJECT.iam.gserviceaccount.com`):

| Role | Why |
|---|---|
| `roles/compute.osAdminLogin` | Passwordless SSH **and** sudo (apply step uses sudo) |
| `roles/compute.viewer` | Describe instances / list; also enough for `compute project-info describe` (project number) |
| `roles/iam.serviceAccountUser` on the **VM's attached** SA | `gcloud compute ssh` actAs that SA |

Do **not** rely on Resource Manager (`projects describe`) or `get-iam-policy` in the deploy
script — those need permissions outside this least-privilege set.

By default GCE VMs use the project Compute Engine default SA
(`PROJECT_NUMBER-compute@developer.gserviceaccount.com`). Grant:

```bash
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:github-actions-deploy@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/compute.osAdminLogin"

gcloud iam service-accounts add-iam-policy-binding \
  PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --project=PROJECT_ID \
  --member="serviceAccount:github-actions-deploy@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

Also ensure the deploy SA can create/delete instances and use the golden image
(see `docs/deploy-your-vm.md` and `scripts/setup-deploy-infra.sh`).

## Failure mode: Permission denied (publickey)

Observed on PR preview deploys (e.g. PR #38):

- VM create succeeds.
- An early hop sometimes works (bootstrap script scp).
- A later hop fails with `sa_…@EXTERNAL_IP: Permission denied (publickey)`.

Common causes:

1. **OS Login IAM lag** after create (can be minutes).
2. Missing `osAdminLogin` / `actAs` (fails more consistently).
3. Guest agent not ready / OS Login not fully up on golden image boot.
4. Rare multi-source recursive scp flake (script now stages wasm + dist separately).

### What the script does now

| Behavior | Env / note |
|---|---|
| Retry `ssh` / `scp` (not only a single `ssh true`) | built-in backoff |
| Re-probe before large artifact SCP | after mkdir, before wasm/dist |
| Clearer errors | principal, zone, instance, **last 5 probe snippets**, live probe |
| Optional IAP tunnel | `PREVIEW_USE_IAP=true` |
| Explicit VM service account | `PREVIEW_VM_SA` (default: project compute SA); soft `serviceAccountUser` check |
| Fail after create | label `deploy-failed=true` + salvage SSH/tear-down hints; or `PREVIEW_DELETE_ON_FAIL=true` to delete |

Also: waits until SSH succeeds and **exits non-zero** if it never becomes ready
(previously a failed wait could fall through silently). Uploads wasm and `dist/`
as **separate** scp operations (avoids multi-source recursive flake).

### Ops recovery

```bash
# Re-run preview after IAM settles or after merging this hardening
gh workflow run "Preview VM up" --repo OWNER/REPO -f pr=NN

# Or tear down a half-created VM and retry
bash scripts/preview-down.sh NN
gh workflow run "Preview VM up" --repo OWNER/REPO -f pr=NN
```

If failures persist after IAM is correct, try enabling IAP tunnel in the workflow
env (`PREVIEW_USE_IAP: 'true'`) and ensure the deploy SA has
`roles/iap.tunnelResourceAccessor` plus a firewall rule allowing IAP to port 22.

## Public-repo hygiene

This repo is public. Prefer:

- Placeholder project / SA names in docs (`PROJECT_ID`, not real numbers)
- No long-lived IPs or full `sa_<digits>` identities in issues/PR comments
- Preview announce URLs are fine (ephemeral); raw IPs in chat are optional noise

CI salvage logs intentionally omit external IPs; use `gcloud compute instances describe`.

## Related

- `scripts/preview-up.sh` — create/deploy/announce
- `scripts/preview-bootstrap.sh` — lean runtime on the VM
- `docs/deploy-your-vm.md` — full VM + IAM setup
- `docs/dev-pipeline.md` — when preview-up runs in the PR lifecycle
