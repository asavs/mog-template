# GitHub Review App

This project can use a dedicated GitHub App identity for agent-assisted PR comments and future automation. For the current two-person review loop, the preferred path is the peer-account reviewer cron in `docs/reviewer-cron.md`.

The goal is still to keep the workflow idiomatic:

- Humans author PRs.
- A peer account, collaborator account, or app identity submits reviews from outside the PR author's account.
- The reviewer reads the same project review docs a human reviewer would use.
- Accepted findings become PR checklist items, review threads, and follow-up commits.

Use the peer-account reviewer cron when you need real `APPROVE` or `REQUEST_CHANGES` reviews from a collaborator account. Use a GitHub App when you want a neutral bot identity, repository automation, or comment-only review assistance.

## App Identity

Name:

```text
mog-review-bot
```

Repository access:

- Only selected repositories.
- Start with `<owner>/mog-template`.

Minimum permissions:

| Permission | Access | Why |
|---|---:|---|
| Metadata | Read | Required by GitHub. |
| Contents | Read | Read code, docs, generated files, and changed files. |
| Pull requests | Read and write | Read PR diffs, submit reviews, approve, request changes, and create inline review comments. |
| Issues | Read and write | Update PR bodies/checklists and comment on PRs, because PRs are issues. |

Optional later:

| Permission | Access | Why |
|---|---:|---|
| Checks | Read | Summarize CI status. |
| Actions | Read | Inspect workflow run logs when debugging CI. |

Do not grant `Contents: write`, `Administration`, `Secrets`, `Deployments`, or broad organization permissions for review-only use.

## Token Model

Use GitHub App installation tokens, not a personal access token.

Preferred GitHub Actions helper:

```yaml
- uses: actions/create-github-app-token@v3
  id: app-token
  with:
    client-id: ${{ vars.MOG_REVIEW_APP_CLIENT_ID }}
    private-key: ${{ secrets.MOG_REVIEW_APP_PRIVATE_KEY }}
    repositories: mog-template
    permission-contents: read
    permission-pull-requests: write
    permission-issues: write
```

Installation tokens expire after about one hour. That is good for review jobs; do not store generated installation tokens.

## Required Review Inputs

Before reviewing, the app must read:

- `AGENTS.md`
- `server/GUIDELINES.md`
- `client/GUIDELINES.md`
- `docs/pr-review-workflow.md`
- feature docs touched by the PR, such as `docs/combat-action-state.md`

The app should inspect the PR diff and nearby changed code. It should not rely only on generated summaries. When a finding depends on platform behavior, the app should consult current official docs for Rust, SpacetimeDB, TypeScript, React, or Three.js rather than relying on a vendored experiment packet.

## Review Event Rules

Use `REQUEST_CHANGES` when at least one finding is likely to cause:

- incorrect gameplay behavior,
- authority/security problems,
- failed production build,
- data or table lifecycle growth without a retention strategy,
- broken deployment or rollback path,
- missing tests for a risky behavior change.

Use `COMMENT` when:

- all findings are optional or follow-up quality suggestions,
- the app is running with the PR author's credentials,
- the app is doing an exploratory or comparison review,
- the PR is docs-only and only has non-blocking suggestions.

Use `APPROVE` only when:

- the app found no blocking issues,
- relevant checks/test evidence are present or explicitly not needed,
- the review did not rely on stale diff context.

## PR Checklist Policy

For accepted blocking findings, the app should update the PR body with a checklist:

```md
## Agent Review Follow-Up

- [ ] Preserve local slash animation time scale
- [ ] Decide `trigger_block_animation` compatibility/deprecation
- [ ] Add `combat_event` retention or bounded subscription
- [ ] Move/exclude Node-only slash timing test from app build
```

Do not create checklist items for duplicate comments, style-only notes, or follow-ups that do not block the PR.

## Review Thread Policy

Each blocking finding should have one primary inline review thread.

Good thread shape:

```md
[P1] Short title.

What can break:
...

Why this violates the project standard:
...

Suggested fix:
...
```

Avoid posting two separate blocking threads for the same root cause. If the same issue appears in server and client code, put the primary thread on the mutation/source-of-truth line and mention the other file as supporting evidence.

## Follow-Up Commit Policy

When addressing findings:

- Prefer one focused commit per accepted finding when practical.
- Reply to the review thread with the fixing commit SHA.
- Check off the corresponding PR checklist item.
- Resolve the thread only after the fix is pushed and visible in the PR diff.

Example reply:

```md
Fixed in `abc1234`: preserves `ATTACK_ANIMATION_TIME_SCALE` in the action-state animation path and adds a regression test.
```

Use linked issues only for non-blocking work that should not delay the PR.

## Peer-Account Default

For this repo's active two-person workflow, run the cron reviewer described in `docs/reviewer-cron.md` under the collaborator account that should review the PR. That is the most direct way to get real GitHub review semantics:

- Reviewer A's cron reviewer reviews Reviewer B's PRs.
- Reviewer B's cron reviewer reviews Reviewer A's PRs.
- Each cron reviewer skips PRs authored by its own configured account.
- Each cron reviewer re-reviews when a PR receives new commits.
- Each cron reviewer should run from a stable checkout or worktree that Gemini has trusted interactively.

## Local Fallback

If the GitHub App is not available, an agent running through the PR author's account may still post a consolidated `COMMENT` review. It must not pretend to be the formal reviewer.

Formal review then comes from:

- a coworker, or
- the peer-account reviewer cron.

## Setup Checklist

1. Create a GitHub App named `mog-review-bot`.
2. Grant the minimum permissions listed above.
3. Install it only on `<owner>/mog-template`.
4. Store client ID as `MOG_REVIEW_APP_CLIENT_ID`.
5. Store private key as `MOG_REVIEW_APP_PRIVATE_KEY`.
6. Add a workflow or external runner that exchanges the private key for an installation token.
7. Run the reviewer with the instructions in `docs/pr-review-workflow.md`.
8. Confirm the app can submit a `COMMENT` review on a test PR.
9. Confirm the app can submit `REQUEST_CHANGES` on a PR authored by another collaborator.
