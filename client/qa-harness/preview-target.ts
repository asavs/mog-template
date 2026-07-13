/**
 * Resolve a PR's ephemeral preview-VM URL from its announce comment.
 *
 * The Preview VM Factory (docs/preview-vm-factory-plan-v1.md §8.2) posts ONE
 * comment per PR carrying a hidden marker and a ```json fence:
 *
 *     <!-- mog-preview-announce -->
 *     Beta feel-test ready ...
 *     ```json
 *     { "pr": 20, "sha": "…", "vm": "mog-pr-20", "url": "http://<ip>/",
 *       "deployedAt": "…", "machineType": "e2-micro" }
 *     ```
 *
 * `npm run qa:harness -- --pr 20` reads that comment, targets the remote URL,
 * and skips the local SpacetimeDB/Vite bootstrap. Parsing is kept pure and
 * separate from the `gh` invocation so it is unit-testable without a network
 * or a live VM (see preview-target.test.ts).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Hidden HTML marker the factory writes so we can find the one announce comment. */
export const ANNOUNCE_MARKER = '<!-- mog-preview-announce -->';

/** The machine-readable payload inside the announce comment's json fence. */
export type PreviewAnnounce = {
  pr: number;
  sha: string;
  vm: string;
  url: string;
  deployedAt: string;
  machineType: string;
};

/** Minimal shape the pure parser needs from a GitHub issue comment. */
export type AnnounceComment = {
  body: string;
  createdAt: string;
};

/** No announce comment on the PR yet (VM not provisioned / not approved). */
export class NoAnnounceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoAnnounceError';
  }
}

/** An announce comment exists but its json fence is missing or malformed. */
export class AnnounceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnnounceParseError';
  }
}

/** True for any URL whose host is not loopback (i.e. a remote preview VM). */
export function isRemoteClientUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1';
  } catch {
    return false;
  }
}

/**
 * From all PR comments, pick the announce comment. Multiple announce comments
 * can exist (the factory tries to update in place, but a re-announce or a
 * recreated VM may leave more than one) — take the most recent. When
 * timestamps are equal or unparseable, later array position wins, matching
 * `gh`'s oldest-first ordering.
 */
export function selectAnnounceComment(comments: AnnounceComment[]): AnnounceComment | null {
  const marked = comments.filter((c) => typeof c?.body === 'string' && c.body.includes(ANNOUNCE_MARKER));
  if (marked.length === 0) return null;
  return marked.reduce((chosen, candidate) => {
    const tChosen = Date.parse(chosen.createdAt);
    const tCandidate = Date.parse(candidate.createdAt);
    if (Number.isFinite(tChosen) && Number.isFinite(tCandidate)) {
      return tCandidate >= tChosen ? candidate : chosen;
    }
    // Undated (or partially dated) comments: prefer the later one in array order.
    return candidate;
  });
}

/** Pull the first ```json fenced block (or a ``` block wrapping an object) out of a comment body. */
function extractJsonFence(body: string): string | null {
  const match =
    body.match(/```json\s*([\s\S]*?)```/i) ?? body.match(/```\s*(\{[\s\S]*?\})\s*```/);
  return match ? match[1].trim() : null;
}

function validateAnnounce(parsed: unknown): PreviewAnnounce {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AnnounceParseError('preview announce JSON is not an object');
  }
  const rec = parsed as Record<string, unknown>;
  const url = typeof rec.url === 'string' ? rec.url.trim() : '';
  if (!url) {
    throw new AnnounceParseError('preview announce JSON is missing a "url" field');
  }
  const prNum = typeof rec.pr === 'number' ? rec.pr : Number(rec.pr);
  return {
    pr: Number.isFinite(prNum) ? prNum : 0,
    sha: typeof rec.sha === 'string' ? rec.sha : '',
    vm: typeof rec.vm === 'string' ? rec.vm : '',
    url,
    deployedAt: typeof rec.deployedAt === 'string' ? rec.deployedAt : '',
    machineType: typeof rec.machineType === 'string' ? rec.machineType : '',
  };
}

/** Parse a single announce comment body into a validated {@link PreviewAnnounce}. */
export function parseAnnounceBody(body: string): PreviewAnnounce {
  const fence = extractJsonFence(body);
  if (!fence) {
    throw new AnnounceParseError('preview announce comment has no ```json fenced block');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence);
  } catch (err) {
    throw new AnnounceParseError(
      `preview announce JSON is malformed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateAnnounce(parsed);
}

/**
 * Pure resolver: given a PR's comments, return its preview announce. Throws
 * {@link NoAnnounceError} when nothing is announced and {@link AnnounceParseError}
 * when the announce is unusable. This is the unit-tested core.
 */
export function resolveAnnounceFromComments(comments: AnnounceComment[], pr: number): PreviewAnnounce {
  const chosen = selectAnnounceComment(comments);
  if (!chosen) {
    throw new NoAnnounceError(
      `no preview VM announced on PR ${pr} — has it been approved? (create is gated on ` +
        `trusted approval + green CI; see docs/preview-vm-factory-plan-v1.md §8.1)`,
    );
  }
  return parseAnnounceBody(chosen.body);
}

/** Injectable command runner so tests can drive the gh layer without spawning gh. */
export type GhRunner = (args: string[]) => string;

const defaultGhRunner: GhRunner = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });

/** Fetch a PR's issue comments via `gh api`, normalized to {@link AnnounceComment}. */
export function fetchPrComments(pr: number, repo: string, run: GhRunner = defaultGhRunner): AnnounceComment[] {
  const out = run(['api', `repos/${repo}/issues/${pr}/comments`, '--paginate']);
  const raw = JSON.parse(out) as Array<{ body?: string; created_at?: string }>;
  return raw.map((c) => ({ body: c.body ?? '', createdAt: c.created_at ?? '' }));
}

/** Best-effort `owner/repo` for the announce lookup: env override, then the `public` remote, then `origin`. */
export function defaultPreviewRepo(): string {
  const fromEnv = process.env.QA_PREVIEW_REPO?.trim();
  if (fromEnv) return fromEnv;
  for (const remote of ['public', 'origin']) {
    try {
      const url = execFileSync('git', ['remote', 'get-url', remote], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/i);
      if (m) return m[1].replace(/\.git$/, '');
    } catch {
      /* try next remote */
    }
  }
  return 'asavs/mog-template';
}

export type ResolvePreviewOptions = {
  repo?: string;
  run?: GhRunner;
};

/** Resolve a PR number to its live preview announce (fetch + parse). */
export function resolvePreviewTarget(pr: number, opts: ResolvePreviewOptions = {}): PreviewAnnounce {
  const repo = opts.repo ?? defaultPreviewRepo();
  const comments = fetchPrComments(pr, repo, opts.run);
  return resolveAnnounceFromComments(comments, pr);
}

/** Parse `--pr <N>` / `--pr=<N>` (or `QA_PR`) out of an argv slice. Returns undefined when absent. */
export function parsePrArg(argv: string[]): number | undefined {
  let pr: number | undefined;
  const prEnv = process.env.QA_PR;
  if (prEnv && /^\d+$/.test(prEnv.trim())) pr = Number(prEnv.trim());
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr') {
      const raw = argv[i + 1];
      pr = Number(raw);
      if (!Number.isInteger(pr) || pr <= 0) throw new Error(`--pr expects a positive PR number, got ${raw ?? '(nothing)'}`);
      i++;
    } else if (a.startsWith('--pr=')) {
      const raw = a.slice('--pr='.length);
      pr = Number(raw);
      if (!Number.isInteger(pr) || pr <= 0) throw new Error(`--pr expects a positive PR number, got ${raw}`);
    }
  }
  return pr;
}

/** Human-readable one-block summary of a resolved announce for harness/CLI logs. */
export function formatAnnounce(a: PreviewAnnounce): string {
  return [
    `preview:    PR #${a.pr}${a.vm ? ` on ${a.vm}` : ''}`,
    `url:        ${a.url}`,
    a.sha ? `sha:        ${a.sha}` : null,
    a.deployedAt ? `deployedAt: ${a.deployedAt}` : null,
    a.machineType ? `machine:    ${a.machineType}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}
