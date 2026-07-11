# Peer Reviewer Cron

This project can run an automated reviewer from a real collaborator account. The reviewer is intended for the two-person review loop where one person opens a PR and the other person's VM-side cron job posts a GitHub review.

Use this when you want real `APPROVE` or `REQUEST_CHANGES` reviews. GitHub does not allow a PR author to approve or request changes on their own PR.

## Why This Is The Default

The cron reviewer is the preferred implementation for this repo because:

- it submits reviews from a peer account, not the PR author's account;
- it works with normal GitHub review semantics;
- it re-reviews when a PR receives new commits;
- it does not need public webhooks or a tunnel;
- idle polling costs only GitHub API calls, not LLM calls.

A dedicated GitHub App can still be useful later for neutral bot comments, CI summaries, or organization-level automation. See `docs/github-review-app.md` for that fallback path.

## Files

```text
scripts/reviewer/
+-- HANDOFF.md
+-- check-ci.sh
+-- ensure-labels.sh
+-- merge-gate.sh
+-- review-prompt.md
+-- reviewer.sh
+-- sync-worktree.sh
```

Runtime state lives outside the repo:

```text
~/.mog-reviewer/
+-- seen.txt
+-- log.txt
+-- lock
+-- cron.log
+-- gemini_backoff_until
```

Use one home-directory state folder per reviewer OS user, e.g. `/home/<reviewer-user>/.mog-reviewer`.

`seen.txt` stores `PR_NUMBER HEAD_SHA` pairs. This is deliberate: a PR is reviewed once per head commit, so a follow-up commit after requested changes triggers a fresh review.

## Requirements

Install these on the VM account that will post reviews:

- `gh`
- `gemini`
- `flock`
- `jq`
- `timeout`
- Git access to the repo

Use a stable checkout path for the cron reviewer. Do not point cron at `/tmp`, and do not point it at an active development checkout where people are switching branches. The reviewer checkout is daemon configuration, not a place to write code, run Codex, or keep feature branches. Use one stable checkout path per reviewer identity, e.g. `/opt/mog-reviewers/<reviewer-user>`. Detached worktrees at `origin/master` are the target state:

```bash
sudo install -d -m 2775 -o root -g mog-devs /opt/mog-reviewers
git -C /srv/mog-template worktree add --detach /opt/mog-reviewers/reviewer-a origin/master
git -C /srv/mog-template worktree add --detach /opt/mog-reviewers/reviewer-b origin/master
```

Run each reviewer under its own OS user so its `gh` and Gemini auth stay isolated.

Authenticate `gh` as the peer reviewer account:

```bash
gh auth status
```

The account must be able to read the private repo and submit PR reviews. For a private repo, a normal collaborator login with repo access is enough.

Set up the optional labels used by the reviewer:

```bash
scripts/reviewer/ensure-labels.sh
```

This creates or updates `agent-reviewed`, `agent-requested-changes`, `needs-human-decision`, and `follow-up-candidates`. The reviewer still works if label setup is skipped; label-application failures are logged but non-fatal.

Authenticate Gemini once interactively on the VM:

```bash
cd /opt/mog-reviewers/reviewer-a
gemini
```

When prompted, choose to trust the folder. After the Gemini CLI finishes loading, exit with:

```text
/quit
```

Then verify headless use:

```bash
cd /opt/mog-reviewers/reviewer-a
printf 'say hi in three words' | GEMINI_CLI_TRUST_WORKSPACE=true timeout 60s gemini -m auto -p ""
```

If this asks for manual authorization or times out, run `gemini` interactively from the exact checkout path cron will use, complete authentication, then retry the headless check before enabling cron. The deployed crons set `GEMINI_CLI_TRUST_WORKSPACE=true` because Gemini folder trust is path-specific and the reviewer checkouts are fixed daemon paths.

The reviewer defaults to Gemini CLI's `auto` model routing through `REVIEWER_GEMINI_MODEL=auto`. This lets the CLI choose between the available Pro and Flash models and use its built-in fallback behavior when a selected model is unavailable. If you intentionally need a fixed model, set `REVIEWER_GEMINI_MODEL` to a concrete model name.

## Configuration

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `REVIEWER_REPO` | `<owner>/mog-template` | GitHub repo to poll. |
| `REVIEWER_USER` | detected from `gh api user` | GitHub username whose PRs are skipped. Normally this is the same account authenticated in `gh`; override only for manual tests. |
| `REVIEWER_ONLY_PR` | unset | Optional PR number filter for one-off tests. |
| `REVIEWER_DRY_RUN` | unset | If set, build the prompt and run Gemini, but log the review action instead of posting to GitHub or marking the commit seen. |
| `REVIEWER_GEMINI_TIMEOUT` | `600` | Maximum seconds to wait for one Gemini review. |
| `REVIEWER_GEMINI_MODEL` | `auto` | Gemini CLI model or alias used for reviews. |
| `REVIEWER_GEMINI_QUOTA_DEFAULT_BACKOFF` | `3600` | Seconds to pause Gemini calls after a quota/capacity error when the CLI does not report a reset time. |
| `REVIEWER_GEMINI_QUOTA_BACKOFF_PADDING` | `300` | Extra seconds added to Gemini-reported quota reset times before retrying. |
| `REVIEWER_REQUIRED_CHECKS_FILE` | `scripts/reviewer/required-checks.json` | JSON file containing required GitHub check-run display names that must pass before Gemini reviews a PR. |
| `REVIEWER_REQUIRED_CHECKS_JSON` | unset | Optional JSON array override for required GitHub check-run display names. Ignored unless `REVIEWER_ALLOW_REQUIRED_CHECKS_OVERRIDE=1`. |
| `REVIEWER_ALLOW_REQUIRED_CHECKS_OVERRIDE` | `0` | Explicit opt-in for replacing the repo's required-check list. Use only for manual smoke tests or temporary operations. |
| `REVIEWER_HEAD_CONTEXT_PATHS` | curated repo paths | Newline-separated repository paths to fetch from the PR head and include in the prompt when present. |
| `REVIEWER_HEAD_CONTEXT_MAX_LINES` | `180` | Maximum lines to include for each selected PR-head file. |
| `REVIEWER_MAX_PRS` | `1` | Maximum number of successful post or dry-run review actions per script run. |
| `REVIEWER_UPDATE_CHECKLIST` | `1` | Update the PR body agent checklist for current P1/blocking findings. |
| `REVIEWER_APPLY_LABELS` | `1` | Attempt to apply lightweight review labels. Label failures are logged but do not fail the review. |
| `REVIEWER_STATE` | `$HOME/.mog-reviewer` | State, logs, and lock directory. |
| `REVIEWER_PROMPT` | `scripts/reviewer/review-prompt.md` | Prompt file. |
| `REVIEWER_REPO_DIR` | repo root inferred from script path | Local checkout used for project docs. |
| `REVIEWER_SYNC_REPO_DIR` | repo root inferred from `sync-worktree.sh` | Checkout path to sync before reviewer runs. |
| `REVIEWER_SYNC_REMOTE` | `origin` | Git remote used by `sync-worktree.sh`. |
| `REVIEWER_SYNC_BRANCH` | `master` | Remote branch used by `sync-worktree.sh`. |
| `REVIEWER_SYNC_LOG` | `$REVIEWER_STATE/sync.log` | Sync log path. |

The safest setup is to run the cron job under the same OS account that authenticated `gh` and Gemini. Use one OS user per reviewer identity (e.g. `reviewer-a`, `reviewer-b`), each with its own checkout, `gh` auth, Gemini auth, and state directory. In normal cron use, leave `REVIEWER_USER` unset so the reviewer skips PRs authored by the posting account.

## What The Script Does

1. Acquires a non-blocking `flock` so cron runs cannot overlap.
2. Lists open non-draft PRs, optionally filtered by `REVIEWER_ONLY_PR`, and skips PRs authored by `REVIEWER_USER`.
3. Gets each PR's current `headRefOid`.
4. Skips the PR only if this exact `PR_NUMBER HEAD_SHA` was already reviewed.
5. Double-checks GitHub reviews for an existing review by the authenticated `gh` user on that same commit.
6. Checks the required CI check-runs from `REVIEWER_REQUIRED_CHECKS_FILE`. `REVIEWER_REQUIRED_CHECKS_JSON` can replace that list only when `REVIEWER_ALLOW_REQUIRED_CHECKS_OVERRIDE=1`; normal cron use should not set the override. Pending or missing checks are skipped until the next cron tick. Failed checks post `REQUEST_CHANGES` without calling Gemini.
7. Builds a prompt from:
   - `scripts/reviewer/review-prompt.md`
   - `AGENTS.md`
   - `server/GUIDELINES.md`
   - `client/GUIDELINES.md`
   - `docs/pr-review-workflow.md`
   - PR metadata
   - required CI gate result and all-check summary
   - PR head file tree
   - selected PR-head file contents for reference validation
   - PR diff
8. Runs `gemini` headless with `REVIEWER_GEMINI_TIMEOUT`.
   If Gemini reports quota exhaustion or no model capacity, the script records a retry time in `gemini_backoff_until` and future cron ticks skip Gemini calls until that time.
9. Parses the first output line as the review verdict.
10. Posts the review through GitHub's review API, with inline comments when Gemini supplies valid changed-line anchors.
11. Updates the PR body agent checklist for current P1/blocking findings.
12. Attempts to apply lightweight labels such as `agent-reviewed`, `agent-requested-changes`, `needs-human-decision`, and `follow-up-candidates`.
13. Records `PR_NUMBER HEAD_SHA` in `seen.txt` only after a successful review post.
14. Stops after `REVIEWER_MAX_PRS` successful post or dry-run review actions.

## Manual Test

From the VM checkout:

```bash
cd /opt/mog-reviewers/reviewer-a
/usr/bin/bash scripts/reviewer/reviewer.sh
tail -n 50 ~/.mog-reviewer/log.txt
```

If there are no open PRs authored by another collaborator, the script may produce no review. To test the full path, open a small throwaway PR from the other account.

To force a one-off review of your own PR as a smoke test, limit the script to that PR and override the skipped author:

```bash
REVIEWER_DRY_RUN=1 REVIEWER_ONLY_PR=28 REVIEWER_USER=nobody REVIEWER_MAX_PRS=1 /usr/bin/bash scripts/reviewer/reviewer.sh
tail -n 50 ~/.mog-reviewer/log.txt
```

Remove `REVIEWER_DRY_RUN=1` only when you intentionally want to post a real review. When the PR author is the same as the authenticated `gh` user, the script posts a `COMMENT` review even if Gemini's verdict is `APPROVE` or `REQUEST_CHANGES`, because GitHub does not allow self-approval or self-request-changes.

## Cron

Run once per minute. Sync the checkout before invoking the reviewer so stale worktrees fail closed:

```cron
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
GEMINI_CLI_TRUST_WORKSPACE=true
* * * * * cd /opt/mog-reviewers/reviewer-a && { /usr/bin/bash scripts/reviewer/sync-worktree.sh && /usr/bin/bash scripts/reviewer/reviewer.sh; } >> ~/.mog-reviewer/cron.log 2>&1
```

The reciprocal reviewer's cron uses its own checkout (e.g. `/opt/mog-reviewers/reviewer-b`) and starts with `sleep 20` to avoid simultaneous `git fetch` operations against the shared object store.

The `cd` target must be a stable checkout path. If cron cannot find `gh` or `gemini`, keep the explicit `PATH=...` line above the cron entry or use absolute command paths in the script.

`sync-worktree.sh` fetches `origin/master`, refuses to run if the checkout is dirty, detaches the checkout at the latest `origin/master`, and logs the SHA. If it fails, the reviewer does not run. If the checkout becomes unrecoverable, recreate it from `origin/master` before trusting new reviews.

## Operations

Pause the cron reviewer:

```bash
crontab -e
```

Comment out the cron line.

Force a re-review of all current heads:

```bash
rm ~/.mog-reviewer/seen.txt
```

The script still checks GitHub for existing reviews on the same head commit, so deleting local state should not duplicate reviews that already posted successfully.

Watch logs:

```bash
tail -f ~/.mog-reviewer/log.txt
```

Watch cron-level failures:

```bash
tail -f ~/.mog-reviewer/cron.log
```

Run merge gate checks before merge:

```bash
scripts/reviewer/merge-gate.sh 29
```

Set `MERGE_GATE_REQUIRE_CHECKS=1` when a PR must have reported GitHub checks before merge.

## Known Limits

- Inline comments are best-effort. If GitHub rejects stale or invalid line anchors, the script falls back to one top-level review body.
- Checklist mutation is limited to the managed `agent-review-checklist` block in the PR body.
- The script does not create follow-up issues automatically. Gemini can propose follow-up issue candidates in the review body; a human or follow-up agent should create only accepted issues.
- Selected PR-head file contents are curated and line-capped. They are meant to validate common doc links, npm scripts, deploy scripts, and workflow references, not to replace full code review of unchanged files.
- Very large diffs may exceed Gemini context limits or produce weaker reviews. Prompt construction uses a temporary file in `REVIEWER_STATE` so large diffs are not duplicated in shell variables before Gemini reads them.
- The script trusts the peer account's local `gh` and `gemini` auth. Keep that VM account locked down.
- The reviewer checkout must stay clean and current. Stale worktrees can make the daemon review with old prompts, old required-check lists, or missing reference context.
- The script includes check summaries in the prompt, but it does not inspect full CI logs. Reviewers should still debug failing CI separately.
- By default, each cron tick posts at most one review. Increase `REVIEWER_MAX_PRS` only when intentionally draining a backlog.

These limits are acceptable for the first durable version. Add richer thread resolution and accepted-issue creation only after the basic cron review loop stays reliable.
