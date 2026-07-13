/**
 * Resolve the beta (or prod) feel-test URL without rediscovering the VM IP.
 *
 * Sources, in order of authority for "what is live right now":
 *   1. deploy/runtime.json  — checked-in host + path (where the VM is)
 *   2. GET {url}/deploy.json — written by apply-artifacts.sh on every deploy
 *      (full SHA, optional PR number, deployedAt)
 *   3. Baked join-screen commit in the client bundle (short SHA fallback
 *      when deploy.json is missing — e.g. deploys from before this landed)
 *
 * Used by `npm run qa:beta` and by `run-harness.ts --beta`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME_PATH = path.join(REPO_ROOT, 'deploy', 'runtime.json');

export type RuntimeConfig = {
  host: string;
  protocol: string;
  betaPath: string;
  prodPath: string;
  gcpProject?: string;
  vmName?: string;
  zone?: string;
};

export type DeployMeta = {
  target: string;
  sha: string;
  pr: number | null;
  deployedAt: string | null;
  source: 'deploy.json' | 'bundle-commit' | 'none';
};

export type ResolvedTarget = {
  target: 'beta' | 'prod' | 'local' | 'custom';
  clientUrl: string;
  remote: boolean;
  runtime: RuntimeConfig | null;
  deploy: DeployMeta;
  alignment: AlignmentReport | null;
};

export type AlignmentReport = {
  expectedKind: 'pr' | 'sha' | 'none';
  expected: string | null;
  expectedFull: string | null;
  live: string | null;
  liveFull: string | null;
  match: boolean | null;
  detail: string;
};

export function readRuntimeConfig(configPath = RUNTIME_PATH): RuntimeConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Missing ${configPath}. This file is the canonical host for beta/prod URLs — ` +
        'restore it from git or recreate it (see docs/deploy-your-vm.md).',
    );
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<RuntimeConfig>;
  if (!raw.host || !raw.protocol || !raw.betaPath || !raw.prodPath) {
    throw new Error(`${configPath} is missing required fields host/protocol/betaPath/prodPath`);
  }
  return {
    host: raw.host,
    protocol: raw.protocol,
    betaPath: normalizePath(raw.betaPath),
    prodPath: normalizePath(raw.prodPath),
    ...(raw.gcpProject ? { gcpProject: raw.gcpProject } : {}),
    ...(raw.vmName ? { vmName: raw.vmName } : {}),
    ...(raw.zone ? { zone: raw.zone } : {}),
  };
}

export function buildEnvUrl(runtime: RuntimeConfig, which: 'beta' | 'prod'): string {
  const basePath = which === 'beta' ? runtime.betaPath : runtime.prodPath;
  return `${runtime.protocol}://${runtime.host}${basePath}`;
}

export function isRemoteClientUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]';
  } catch {
    return false;
  }
}

function normalizePath(p: string): string {
  let out = p.startsWith('/') ? p : `/${p}`;
  if (!out.endsWith('/')) out = `${out}/`;
  return out;
}

function shortSha(sha: string | null | undefined): string | null {
  if (!sha) return null;
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function shaMatches(live: string | null, expected: string | null): boolean | null {
  if (!live || !expected) return null;
  const a = live.toLowerCase();
  const b = expected.toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

async function fetchText(url: string, timeoutMs = 10000): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Read /deploy.json written by apply-artifacts.sh. */
export async function fetchDeployMeta(baseUrl: string): Promise<DeployMeta> {
  const url = new URL('deploy.json', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
  const body = await fetchText(url);
  // Missing file often falls through nginx try_files to index.html (200 + HTML).
  if (!body || /^\s*</.test(body)) {
    return { target: 'unknown', sha: '', pr: null, deployedAt: null, source: 'none' };
  }
  try {
    const parsed = JSON.parse(body) as { target?: string; sha?: string; pr?: number | null; deployedAt?: string };
    if (!parsed.sha) {
      return { target: parsed.target ?? 'unknown', sha: '', pr: parsed.pr ?? null, deployedAt: parsed.deployedAt ?? null, source: 'none' };
    }
    return {
      target: parsed.target ?? 'unknown',
      sha: parsed.sha,
      pr: typeof parsed.pr === 'number' ? parsed.pr : null,
      deployedAt: parsed.deployedAt ?? null,
      source: 'deploy.json',
    };
  } catch {
    return { target: 'unknown', sha: '', pr: null, deployedAt: null, source: 'none' };
  }
}

/**
 * Fallback when deploy.json is missing: scrape the short commit baked into
 * the join dialog via __BUILD_COMMIT__ / buildInfo.commit.
 */
export async function fetchBundleCommit(baseUrl: string): Promise<string | null> {
  const indexUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const html = await fetchText(indexUrl);
  if (!html) return null;

  // Prefer an absolute /beta/assets/... or /assets/... script src.
  const scriptMatch =
    html.match(/src="([^"]*assets\/index-[^"]+\.js)"/) ??
    html.match(/src="([^"]+\.js)"/);
  if (!scriptMatch) return null;

  let scriptSrc = scriptMatch[1];
  if (scriptSrc.startsWith('/')) {
    const origin = new URL(indexUrl).origin;
    scriptSrc = `${origin}${scriptSrc}`;
  } else if (!/^https?:/i.test(scriptSrc)) {
    scriptSrc = new URL(scriptSrc, indexUrl).toString();
  }

  const js = await fetchText(scriptSrc, 30000);
  if (!js) return null;

  // Vite injects buildInfo as {commit:`abc1234`,mode:`production`} (backticks
  // after minification) or with " / ' depending on bundler version.
  const m =
    js.match(/commit:`([0-9a-f]{7,40})`/) ??
    js.match(/commit:"([0-9a-f]{7,40})"/i) ??
    js.match(/commit:'([0-9a-f]{7,40})'/i) ??
    js.match(/\{commit:([0-9a-f]{7,40})/);
  return m ? m[1] : null;
}

export async function probeLiveDeploy(baseUrl: string): Promise<DeployMeta> {
  const fromFile = await fetchDeployMeta(baseUrl);
  if (fromFile.source === 'deploy.json' && fromFile.sha) return fromFile;

  const bundle = await fetchBundleCommit(baseUrl);
  if (bundle) {
    return {
      target: fromFile.target !== 'unknown' ? fromFile.target : 'unknown',
      sha: bundle,
      pr: fromFile.pr,
      deployedAt: fromFile.deployedAt,
      source: 'bundle-commit',
    };
  }
  return fromFile;
}

function ghJson<T>(args: string[]): T | null {
  try {
    const out = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
    });
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

export function resolvePrHead(pr: number, repo?: string): { sha: string; url: string; title: string } | null {
  const args = ['pr', 'view', String(pr), '--json', 'headRefOid,url,title'];
  if (repo) args.push('--repo', repo);
  const data = ghJson<{ headRefOid: string; url: string; title: string }>(args);
  if (!data?.headRefOid) return null;
  return { sha: data.headRefOid, url: data.url, title: data.title };
}

export function defaultGithubRepo(): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'public'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/i);
    if (m) return m[1].replace(/\.git$/, '');
  } catch {
    /* fall through */
  }
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/i);
    if (m) return m[1].replace(/\.git$/, '');
  } catch {
    /* ignore */
  }
  return undefined;
}

export type ResolveOptions = {
  /** Explicit client URL wins over --beta/--prod. */
  clientUrl?: string;
  /** beta | prod | local. Default local when nothing else set. */
  target?: 'beta' | 'prod' | 'local';
  /** Require live deploy SHA to match this PR's head. */
  pr?: number;
  /** Require live deploy SHA to match this commit (full or short). */
  expectSha?: string;
  /** Skip live HTTP probes (print configured URL only). */
  offline?: boolean;
  repo?: string;
};

export async function resolveTarget(opts: ResolveOptions = {}): Promise<ResolvedTarget> {
  const explicit = opts.clientUrl?.trim();
  if (explicit) {
    const remote = isRemoteClientUrl(explicit);
    const deploy = opts.offline || !remote
      ? { target: 'custom', sha: '', pr: null, deployedAt: null, source: 'none' as const }
      : await probeLiveDeploy(explicit);
    const alignment = buildAlignment(deploy, opts);
    return {
      target: 'custom',
      clientUrl: explicit,
      remote,
      runtime: null,
      deploy,
      alignment,
    };
  }

  const which = opts.target ?? 'local';
  if (which === 'local') {
    return {
      target: 'local',
      clientUrl: 'http://localhost:5173',
      remote: false,
      runtime: null,
      deploy: { target: 'local', sha: '', pr: null, deployedAt: null, source: 'none' },
      alignment: null,
    };
  }

  const runtime = readRuntimeConfig();
  const clientUrl = buildEnvUrl(runtime, which);
  const deploy = opts.offline ? { target: which, sha: '', pr: null, deployedAt: null, source: 'none' as const } : await probeLiveDeploy(clientUrl);
  // Prefer PR from deploy.json when caller didn't pass --pr.
  const effectiveOpts: ResolveOptions = {
    ...opts,
    pr: opts.pr ?? (deploy.pr ?? undefined),
  };
  const alignment = buildAlignment(deploy, effectiveOpts);

  return {
    target: which,
    clientUrl,
    remote: true,
    runtime,
    deploy,
    alignment,
  };
}

function buildAlignment(deploy: DeployMeta, opts: ResolveOptions): AlignmentReport | null {
  if (opts.pr == null && !opts.expectSha) {
    if (deploy.pr != null && deploy.sha) {
      // Informational: deploy claims a PR; verify if gh is available.
      const head = resolvePrHead(deploy.pr, opts.repo ?? defaultGithubRepo());
      if (!head) {
        return {
          expectedKind: 'pr',
          expected: `#${deploy.pr}`,
          expectedFull: null,
          live: shortSha(deploy.sha),
          liveFull: deploy.sha,
          match: null,
          detail: `deploy.json says PR #${deploy.pr}; could not resolve PR head via gh`,
        };
      }
      const match = shaMatches(deploy.sha, head.sha);
      return {
        expectedKind: 'pr',
        expected: `#${deploy.pr} ${shortSha(head.sha)}`,
        expectedFull: head.sha,
        live: shortSha(deploy.sha),
        liveFull: deploy.sha,
        match,
        detail: match
          ? `live deploy matches PR #${deploy.pr} head`
          : `RED FLAG: live ${shortSha(deploy.sha)} ≠ PR #${deploy.pr} head ${shortSha(head.sha)}`,
      };
    }
    return null;
  }

  if (opts.expectSha) {
    const match = shaMatches(deploy.sha, opts.expectSha);
    return {
      expectedKind: 'sha',
      expected: shortSha(opts.expectSha),
      expectedFull: opts.expectSha,
      live: shortSha(deploy.sha),
      liveFull: deploy.sha || null,
      match,
      detail:
        match === true
          ? 'live deploy matches expected SHA'
          : match === false
            ? `RED FLAG: live ${shortSha(deploy.sha) ?? '(unknown)'} ≠ expected ${shortSha(opts.expectSha)}`
            : 'could not read live deploy SHA',
    };
  }

  // --pr N
  const pr = opts.pr!;
  const head = resolvePrHead(pr, opts.repo ?? defaultGithubRepo());
  if (!head) {
    return {
      expectedKind: 'pr',
      expected: `#${pr}`,
      expectedFull: null,
      live: shortSha(deploy.sha),
      liveFull: deploy.sha || null,
      match: null,
      detail: `could not resolve PR #${pr} head via gh (auth/repo?)`,
    };
  }
  const match = shaMatches(deploy.sha, head.sha);
  return {
    expectedKind: 'pr',
    expected: `#${pr} ${shortSha(head.sha)}`,
    expectedFull: head.sha,
    live: shortSha(deploy.sha),
    liveFull: deploy.sha || null,
    match,
    detail:
      match === true
        ? `live deploy matches PR #${pr} head`
        : match === false
          ? `RED FLAG: live ${shortSha(deploy.sha) ?? '(unknown)'} ≠ PR #${pr} head ${shortSha(head.sha)}`
          : 'could not read live deploy SHA to compare with PR head',
  };
}

export function formatResolvedTarget(resolved: ResolvedTarget): string {
  const lines: string[] = [];
  lines.push(`target:     ${resolved.target}`);
  lines.push(`clientUrl:  ${resolved.clientUrl}`);
  lines.push(`qaUrl:      ${withQaParam(resolved.clientUrl)}`);
  if (resolved.runtime) {
    lines.push(`host:       ${resolved.runtime.host}  (from deploy/runtime.json)`);
    if (resolved.runtime.gcpProject) {
      lines.push(`gcp:        ${resolved.runtime.vmName ?? 'mog-server'} / ${resolved.runtime.zone ?? '?'} / ${resolved.runtime.gcpProject}`);
    }
  }
  if (resolved.remote) {
    lines.push(
      `deploy:     source=${resolved.deploy.source}` +
        (resolved.deploy.sha ? ` sha=${resolved.deploy.sha}` : ' sha=(unknown)') +
        (resolved.deploy.pr != null ? ` pr=#${resolved.deploy.pr}` : '') +
        (resolved.deploy.deployedAt ? ` at=${resolved.deploy.deployedAt}` : ''),
    );
  }
  if (resolved.alignment) {
    const a = resolved.alignment;
    const flag = a.match === false ? 'RED FLAG' : a.match === true ? 'OK' : 'UNKNOWN';
    lines.push(`alignment:  [${flag}] ${a.detail}`);
    if (a.expected) lines.push(`  expected: ${a.expected}`);
    if (a.live) lines.push(`  live:     ${a.liveFull ?? a.live}`);
  }
  lines.push('');
  lines.push(`# shell: set QA_CLIENT_URL then run the harness`);
  lines.push(`# PowerShell:  $env:QA_CLIENT_URL='${resolved.clientUrl}'; npm run qa:harness -- --beta`);
  lines.push(`# bash:        QA_CLIENT_URL='${resolved.clientUrl}' npm run qa:harness -- --beta`);
  return lines.join('\n');
}

export function withQaParam(clientUrl: string): string {
  const u = new URL(clientUrl);
  if (!u.searchParams.has('qa')) u.searchParams.set('qa', '');
  // URLSearchParams turns bare ?qa into ?qa= — both enable the gate; strip trailing = for readability.
  return u.toString().replace(/\?qa=$/, '?qa').replace(/([?&])qa=&/, '$1qa&');
}

/** Parse argv flags used by qa:beta and run-harness. */
export function parseTargetArgs(argv: string[]): {
  beta: boolean;
  prod: boolean;
  pr?: number;
  expectSha?: string;
  offline: boolean;
  requireAlign: boolean;
} {
  let beta = argv.includes('--beta') || process.env.QA_TARGET === 'beta';
  let prod = argv.includes('--prod') || process.env.QA_TARGET === 'prod';
  let offline = argv.includes('--offline');
  let requireAlign = argv.includes('--require-align') || process.env.QA_REQUIRE_ALIGN === '1';
  let pr: number | undefined;
  let expectSha: string | undefined;

  const prEnv = process.env.QA_PR;
  if (prEnv && /^\d+$/.test(prEnv)) pr = Number(prEnv);
  if (process.env.QA_EXPECT_SHA) expectSha = process.env.QA_EXPECT_SHA;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pr' && argv[i + 1]) {
      pr = Number(argv[++i]);
      if (!Number.isFinite(pr)) throw new Error(`--pr expects a number, got ${argv[i]}`);
    } else if (a.startsWith('--pr=')) {
      pr = Number(a.slice('--pr='.length));
      if (!Number.isFinite(pr)) throw new Error(`--pr expects a number, got ${a}`);
    } else if (a === '--expect-sha' && argv[i + 1]) {
      expectSha = argv[++i];
    } else if (a.startsWith('--expect-sha=')) {
      expectSha = a.slice('--expect-sha='.length);
    }
  }

  if (beta && prod) throw new Error('pass only one of --beta / --prod');
  return { beta, prod, pr, expectSha, offline, requireAlign };
}
