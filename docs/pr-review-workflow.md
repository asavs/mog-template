# PR Review Workflow

This project uses issues, branches, commits, and pull requests as a design loop. The goal is not just to pass CI. The goal is to make every gameplay, networking, and deployment change auditable against concrete project rules.

## Working Loop

1. Notice problems and write issues.
2. Group related issues and check out a focused branch.
3. Commit changes that solve individual issues or tight slices of one issue.
4. Open a PR for the branch.
5. Review the PR against this checklist and the linked source material.
6. Make improvements from review findings.
7. Re-review until the remaining risk is understood and acceptable.

## PR Author Inputs

Every PR should make review cheap by including:

- Linked issue numbers or a short statement of the problem being solved.
- A summary of behavior before and after the change.
- The expected player-facing outcome, if the change affects gameplay.
- Test evidence: commands run, manual checks, and any known gaps.
- Screenshots or short recordings for visible client or 3D scene changes when useful.
- Notes about generated files, schema changes, deployment config, or VM changes.

Commits should stay meaningful. Prefer commits that each answer one small question, such as "add action-state table", "wire block reducer", or "add client regression check".

## Reviewer Inputs

Reviewers should inspect the diff directly and use these local docs first:

- `AGENTS.md`
- `server/GUIDELINES.md` for SpacetimeDB and Rust module work.
- `client/GUIDELINES.md` for React, Three.js, networking, prediction, and interpolation.
- `docs/spacetimedb-threejs-architecture.md` for the intended system shape.
- `docs/deployment-security-checklist.md` for infrastructure and secret-handling changes.
- Feature docs such as `docs/combat-action-state.md` when the PR touches that area.

Use external references when a claim depends on language, framework, or platform behavior:

- Microsoft Pragmatic Rust Guidelines: https://github.com/microsoft/rust-guidelines
- Rust Book: https://doc.rust-lang.org/book/
- SpacetimeDB docs: https://spacetimedb.com/docs/
- SpacetimeDB reducers docs: https://spacetimedb.com/docs/functions/reducers/
- TypeScript Handbook: https://www.typescriptlang.org/docs/
- React docs: https://react.dev/learn
- Three.js docs: https://threejs.org/docs/

When these references disagree with older local docs, prefer the current official docs, then update the local docs as part of the PR or open a follow-up issue.

## Agent Review

Formal agent reviews should come from an identity other than the PR author's account. For this repo's current two-person workflow, use the peer-account reviewer cron in `docs/reviewer-cron.md`: one collaborator's cron job reviews the other collaborator's PRs.

A GitHub App remains a useful future option for neutral bot comments or repository automation. See `docs/github-review-app.md` for app permissions and token guidance. If an agent is running with the PR author's credentials, it should submit a `COMMENT` review only.

Use one consolidated review. The reviewer may think in multiple passes internally, but the PR should receive a single deduplicated set of findings.

Automated reviewers must re-review after follow-up commits. The durable implementation should key review state by PR head commit, not only by PR number.

The peer-account reviewer cron should run from a stable, Gemini-trusted checkout or worktree. It should not run from a temporary directory or whichever branch a developer is actively editing.

Prompt shape:

```text
Review this PR for bugs, regressions, missing tests, and maintainability risks.
Use the local project docs, nearby code patterns, and current official docs for Rust, SpacetimeDB, TypeScript, React, and Three.js when a finding depends on platform behavior.
Return findings first, ordered by severity. For each finding include file/line, risk, and the concrete standard or nearby pattern it violates.
Do not spend review budget on style-only comments unless they hide a behavior or maintenance risk.
```

### Posting Findings

Post one consolidated review after internal passes finish.

- Deduplicate findings before posting.
- Use one primary review thread per root cause when the finding can be anchored to a changed line.
- Add current blocking findings to the managed PR checklist.
- Reply to each review thread with the fixing commit SHA.
- Resolve threads after the fix is pushed and visible.
- Propose linked issues only for non-blocking follow-up work. Create issues only after a human or follow-up agent accepts them.

### Follow-Up Agents

A follow-up agent handles reviews after they land:

- read unresolved review threads and the managed PR checklist;
- make focused commits for accepted blocking findings;
- reply to each addressed thread with the fixing commit SHA;
- resolve threads only after the fix is visible on the PR branch;
- leave non-blocking suggestions alone unless the PR owner explicitly accepts them.

This keeps the reviewer from silently editing code and keeps fix ownership visible in GitHub.

### Merge Gate Agents

Before merge, a merge-gate agent should verify:

- the latest PR head has an approval from an account other than the author;
- there are no latest-head `REQUEST_CHANGES` reviews;
- required checks are passing or explicitly waived;
- blocking review threads are resolved;
- the managed PR checklist is complete;
- the PR is not a draft and GitHub reports it mergeable.

The helper script `scripts/reviewer/merge-gate.sh` performs the mechanical checks available through GitHub. It does not merge the PR.

## Review Gates

### Scope and Issue Fit

- The PR has a clear purpose and does not mix unrelated gameplay, infrastructure, dependency, and cleanup work.
- Related issues are grouped intentionally, and unrelated issues are left for separate branches.
- The branch and commits make it possible to understand how each issue was solved.
- Any speculative design choice is called out in the PR body or a review comment.
- Public API changes, including public reducers, are either backward-compatible or clearly documented as deprecations/breaking changes.

### SpacetimeDB Server

- Server state remains authoritative. Clients request actions; reducers validate and mutate tables.
- Reducers are deterministic and do not use filesystem, network, wall-clock APIs, process state, or external randomness.
- Reducers validate identity with `ctx.sender` and never trust a client-provided identity for authority.
- Reducers return expected errors instead of panicking for normal player actions.
- Table schemas, indexes, scheduled reducers, and generated bindings stay in sync.
- Generated client bindings are regenerated, not manually edited.
- Public tables expose only state clients need to subscribe to.
- Public transient/event tables have a retention strategy or bounded subscription pattern.
- Server logic stores persistent state in tables, not globals or static mutable state.

### Rust Quality

- Code follows the local SpacetimeDB Rust patterns in `server/GUIDELINES.md`.
- Ownership and cloning choices are intentional, especially in tick, combat, and reducer paths.
- Numeric units are clear for time, position, velocity, cooldowns, damage, and animation windows.
- Expected failure paths use `Result` and descriptive errors.
- New helper functions remove real duplication or clarify domain rules.
- Node/browser/Rust test files are placed so production build configs do not compile the wrong runtime target.
- Tests or regression scripts cover behavior that would be easy to break later.

### TypeScript, React, and Three.js

- TypeScript uses generated SpacetimeDB types where available and avoids `any` unless justified.
- Subscriptions, event listeners, intervals, and animation resources are cleaned up.
- High-frequency movement and render state stay in refs and `useFrame`, not React state.
- Remote players use snapshot interpolation; local players use prediction and reconciliation.
- Client code handles connection, reconnect, reducer failure, and missing local-player state gracefully.
- 3D assets are loaded through appropriate loaders and are not reloaded every frame.
- Animation changes preserve gameplay timing contracts, including explicit time scales and server impact windows.
- Visual changes are checked at realistic desktop and mobile viewport sizes when relevant.

### Security and Deployment

- No secrets are added to Vite env vars, generated client code, logs, or docs.
- Public traffic still goes through Nginx; SpacetimeDB stays bound to `127.0.0.1:3000`.
- Firewall, systemd, Nginx, and deploy-script changes keep `deploy/` as the canonical config copy.
- Deployment changes explain rollback or recovery steps when failure would leave the game offline.

### Test Evidence

Reviewers should expect relevant evidence, not every command for every PR. CI is the authoritative full-build signal, so local full builds are not required by habit.

- Server/module changes: focused Rust tests, build, publish check, or reducer/gameplay validation that matches the risk.
- Client changes: focused tests first; `npm run build` only when directly useful, when debugging CI/build failures, or when the PR needs a local bundle signal before pushing.
- Networked gameplay changes: a focused headless script, local SpacetimeDB check, VM check, or manual multiplayer test.
- Documentation-only changes: link and command accuracy checks are enough.

If the PR lacks evidence for a risky path, request changes or ask for a follow-up issue before approving.

## Review Comment Style

Lead with concrete findings:

- What can break?
- Which player, operator, or contributor is affected?
- What file and line show the risk?
- What evidence would make the reviewer comfortable?

Prefer actionable comments over taste comments. If a point is architectural but not blocking, label it as a follow-up candidate instead of mixing it with required fixes.
