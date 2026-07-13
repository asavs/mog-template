/**
 * Environment-requirements preflight engine (Stage A).
 *
 * ONE runtime, ZERO npm dependencies — this must run before (and without) any
 * `npm install`, so it uses only Node's built-in modules. It is dual-use:
 *
 *   - CLI:    node tools/env-requirements/preflight.mjs <id> [<id>...]
 *             node tools/env-requirements/preflight.mjs --list | --docs | --json
 *   - Module: import { checkRequirements } from './preflight.mjs'
 *
 * The registry (requirements.json) is the single source of truth. Probes are
 * declarative (a fixed set of probe types); `command-succeeds` is the one
 * free-form escape hatch and the docs renderer marks entries that use it.
 *
 * Stage B will add environment fingerprints and DERIVE a tool x environment
 * support matrix from this registry. So probe results are kept structured and
 * ids stable; no environment/cell logic lives here yet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(__dirname, 'requirements.json');

/** Probe types the engine knows how to evaluate. */
export const PROBE_TYPES = Object.freeze([
  'binary-on-path',
  'env-var',
  'file-min-size',
  'node-modules-platform',
  'display-headed',
  'not-plink-transport',
  'command-succeeds',
]);

/** The one free-form probe type; the docs renderer flags entries that use it. */
export const ESCAPE_HATCH_PROBE = 'command-succeeds';

// ---------------------------------------------------------------------------
// Registry loading
// ---------------------------------------------------------------------------

/** Load and return the registry object ({ requirements: { id: {...} } }). */
export function loadRegistry(registryPath = REGISTRY_PATH) {
  const raw = fs.readFileSync(registryPath, 'utf8');
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Evaluation context (all IO injectable so probe logic is unit-testable)
// ---------------------------------------------------------------------------

function resolveOnPath(binary, ctx) {
  const pathVar = ctx.env.PATH ?? ctx.env.Path ?? '';
  const sep = ctx.platform === 'win32' ? ';' : ':';
  const dirs = pathVar.split(sep).filter(Boolean);
  const win = ctx.platform === 'win32';
  const exts = win ? (ctx.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  const alreadyExt = binary.includes('.');
  for (const dir of dirs) {
    const candidates = [];
    if (!win || alreadyExt) candidates.push(binary);
    if (win && !alreadyExt) for (const e of exts) candidates.push(binary + e);
    for (const c of candidates) {
      try {
        if (ctx.fs.existsSync(path.join(dir, c))) return true;
      } catch {
        /* unreadable PATH entry — keep scanning */
      }
    }
  }
  return false;
}

function defaultRun(command, args) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20000,
    });
    return { status: 0, stdout };
  } catch (err) {
    return { status: typeof err?.status === 'number' ? err.status : 1, stdout: err?.stdout ?? '' };
  }
}

export function makeContext(opts = {}) {
  const ctx = {
    env: opts.env ?? process.env,
    platform: opts.platform ?? process.platform,
    cwd: opts.cwd ?? REPO_ROOT,
    fs: opts.fs ?? fs,
    run: opts.run ?? defaultRun,
  };
  ctx.which = opts.which ?? ((binary) => resolveOnPath(binary, ctx));
  return ctx;
}

// ---------------------------------------------------------------------------
// Probes — each returns { pass: boolean, detail: string }
// ---------------------------------------------------------------------------

const PROBES = {
  'binary-on-path'(probe, ctx) {
    const ok = ctx.which(probe.binary);
    return { pass: ok, detail: ok ? `${probe.binary} found on PATH` : `${probe.binary} not found on PATH` };
  },

  'env-var'(probe, ctx) {
    const val = ctx.env[probe.name];
    const ok = typeof val === 'string' && val.length > 0;
    return { pass: ok, detail: ok ? `${probe.name} is set` : `${probe.name} is not set` };
  },

  'file-min-size'(probe, ctx) {
    const abs = path.isAbsolute(probe.path) ? probe.path : path.join(ctx.cwd, probe.path);
    let size;
    try {
      size = ctx.fs.statSync(abs).size;
    } catch {
      return { pass: false, detail: `${probe.path} is missing` };
    }
    const ok = size >= probe.minBytes;
    return {
      pass: ok,
      detail: ok
        ? `${probe.path} is ${size} bytes (>= ${probe.minBytes})`
        : `${probe.path} is only ${size} bytes (< ${probe.minBytes}) — likely an unresolved Git LFS pointer`,
    };
  },

  'node-modules-platform'(probe, ctx) {
    const nm = path.join(ctx.cwd, probe.dir, 'node_modules');
    if (!ctx.fs.existsSync(nm)) {
      return { pass: false, detail: `${probe.dir}/node_modules is missing — run \`npm ci\`` };
    }
    // Windows: npm writes *.cmd (and *.ps1) shims into .bin. A .bin populated
    // by a Linux install has none, which is the classic "vite-node is not
    // recognized" failure. An empty/absent .bin is not conclusive, so skip.
    if (ctx.platform === 'win32') {
      const bin = path.join(nm, '.bin');
      try {
        const entries = ctx.fs.readdirSync(bin);
        if (entries.length > 0 && !entries.some((e) => e.toLowerCase().endsWith('.cmd'))) {
          return { pass: false, detail: `${probe.dir}/node_modules/.bin has no *.cmd shims — looks Linux-native` };
        }
      } catch {
        /* no .bin dir — fall through to the esbuild check */
      }
    }
    // Cross-platform: esbuild ships its native binary as an optional package
    // named <platform>-<arch>. If @esbuild is installed but has no subdir for
    // the current platform, the install came from a different OS.
    const token = { win32: 'win32', linux: 'linux', darwin: 'darwin' }[ctx.platform];
    const esbuildDir = path.join(nm, '@esbuild');
    if (token && ctx.fs.existsSync(esbuildDir)) {
      try {
        const subs = ctx.fs.readdirSync(esbuildDir);
        if (subs.length > 0 && !subs.some((s) => s.startsWith(token))) {
          return {
            pass: false,
            detail: `${probe.dir}/node_modules/@esbuild has no ${token}-* package — installed for a different OS`,
          };
        }
      } catch {
        /* unreadable — treat as inconclusive */
      }
    }
    return { pass: true, detail: `${probe.dir}/node_modules matches ${ctx.platform}` };
  },

  'display-headed'(probe, ctx) {
    if (ctx.platform === 'win32' || ctx.platform === 'darwin') {
      return { pass: true, detail: `${ctx.platform} always has a display` };
    }
    const ok = typeof ctx.env.DISPLAY === 'string' && ctx.env.DISPLAY.length > 0;
    return { pass: ok, detail: ok ? `DISPLAY=${ctx.env.DISPLAY}` : 'no DISPLAY set (headed Chromium needs one; use xvfb-run)' };
  },

  'not-plink-transport'(probe, ctx) {
    // "Passes" everywhere except win32, where gcloud ssh uses plink and the
    // heredoc-over-ssh publish path breaks. severity=warn, so this never fails
    // a run — it just surfaces the hazard.
    const win = ctx.platform === 'win32';
    return {
      pass: !win,
      detail: win
        ? 'win32: gcloud ssh uses PuTTY/plink — heredoc-over-ssh will break'
        : `${ctx.platform}: OpenSSH transport`,
    };
  },

  'command-succeeds'(probe, ctx) {
    const { status, stdout } = ctx.run(probe.command, probe.args ?? []);
    const label = `${probe.command} ${(probe.args ?? []).join(' ')}`.trim();
    if (status !== 0) return { pass: false, detail: `\`${label}\` exited ${status}` };
    if (probe.expectOutputMatch) {
      const re = new RegExp(probe.expectOutputMatch);
      if (!re.test(stdout)) return { pass: false, detail: `\`${label}\` succeeded but output did not match /${probe.expectOutputMatch}/` };
    }
    return { pass: true, detail: `\`${label}\` succeeded` };
  },
};

/** Evaluate a single probe object. Returns { pass, detail }. */
export function runProbe(probe, ctx = makeContext()) {
  const fn = PROBES[probe?.type];
  if (!fn) return { pass: false, detail: `unknown probe type: ${probe?.type}` };
  return fn(probe, ctx);
}

// ---------------------------------------------------------------------------
// Requirement checking
// ---------------------------------------------------------------------------

/**
 * Check the given requirement ids against the environment.
 * @param {string[]} ids
 * @param {object} [opts] - { env, platform, cwd, fs, run, which, registry }
 * @returns {{ ok: boolean, results: Array<{
 *   id, status: 'PASS'|'FAIL'|'WARN', severity, why, remedy, probe, detail
 * }> }}
 */
export function checkRequirements(ids, opts = {}) {
  const registry = opts.registry ?? loadRegistry();
  const reqs = registry.requirements ?? {};
  const ctx = makeContext(opts);
  const results = [];

  for (const id of ids) {
    const req = reqs[id];
    if (!req) {
      results.push({
        id,
        status: 'FAIL',
        severity: 'fail',
        why: `unknown requirement id: ${id}`,
        remedy: `Check tools/env-requirements/requirements.json for valid ids (or run with --list).`,
        probe: { type: 'unknown' },
        detail: 'not in registry',
      });
      continue;
    }
    const { pass, detail } = runProbe(req.probe, ctx);
    const status = pass ? 'PASS' : req.severity === 'warn' ? 'WARN' : 'FAIL';
    results.push({ id, status, severity: req.severity, why: req.why, remedy: req.remedy, probe: req.probe, detail });
  }

  return { ok: results.every((r) => r.status !== 'FAIL'), results };
}

// ---------------------------------------------------------------------------
// Text formatting (shared by the CLI and by run-harness)
// ---------------------------------------------------------------------------

const GLYPH = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN' };

/** Format one result as human-readable lines (why/remedy shown on non-PASS). */
export function formatResult(r) {
  const lines = [`[${GLYPH[r.status] ?? r.status}] ${r.id} — ${r.detail}`];
  if (r.status !== 'PASS') {
    lines.push(`       why:    ${r.why}`);
    lines.push(`       remedy: ${r.remedy}`);
  }
  return lines.join('\n');
}

/** Format a full result set. */
export function formatResults(results) {
  return results.map(formatResult).join('\n');
}

// ---------------------------------------------------------------------------
// Docs rendering (deterministic — no timestamps, stable ordering)
// ---------------------------------------------------------------------------

/** One-line description of a probe for the docs table. */
export function describeProbe(probe) {
  switch (probe.type) {
    case 'binary-on-path':
      return `binary-on-path(${probe.binary})`;
    case 'env-var':
      return `env-var(${probe.name})`;
    case 'file-min-size':
      return `file-min-size(${probe.path} >= ${probe.minBytes})`;
    case 'node-modules-platform':
      return `node-modules-platform(${probe.dir})`;
    case 'display-headed':
      return 'display-headed';
    case 'not-plink-transport':
      return 'not-plink-transport';
    case 'command-succeeds':
      return `command-succeeds(${probe.command} ${(probe.args ?? []).join(' ')})`.trim();
    default:
      return String(probe.type);
  }
}

function escapeCell(text) {
  return String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/** Render the full generated markdown doc for the registry. Deterministic. */
export function renderDocs(registry = loadRegistry()) {
  const reqs = registry.requirements ?? {};
  const ids = Object.keys(reqs).sort();
  let usesEscapeHatch = false;

  const rows = ids.map((id) => {
    const req = reqs[id];
    if (req.probe?.type === ESCAPE_HATCH_PROBE) usesEscapeHatch = true;
    const mark = req.probe?.type === ESCAPE_HATCH_PROBE ? ' †' : '';
    return `| \`${id}\` | ${escapeCell(req.why)} | ${escapeCell(req.remedy)} | ${req.severity} | \`${escapeCell(describeProbe(req.probe))}\`${mark} |`;
  });

  const lines = [
    '# Environment requirements',
    '',
    '<!-- GENERATED FILE — do not edit by hand.',
    '     Source of truth: tools/env-requirements/requirements.json',
    '     Regenerate:      node tools/env-requirements/preflight.mjs --docs > docs/environment-requirements.md',
    '     CI fails if this file drifts from the registry (.github/workflows/ci.yml). -->',
    '',
    'Each row is a declarative environment probe the QA harness and deploy',
    'scripts check before doing real work, so a missing tool surfaces as a',
    'clear `why` + `remedy` instead of a cryptic downstream error. Check any',
    'subset from the CLI:',
    '',
    '```sh',
    'node tools/env-requirements/preflight.mjs gh-cli gcloud-cli',
    '```',
    '',
    '| id | why | remedy | severity | probe |',
    '|----|-----|--------|----------|-------|',
    ...rows,
  ];

  if (usesEscapeHatch) {
    lines.push('');
    lines.push('† `command-succeeds` is the free-form escape-hatch probe type; prefer a declarative probe type where one fits.');
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function runCli(argv) {
  if (argv.includes('--list')) {
    const registry = loadRegistry();
    for (const id of Object.keys(registry.requirements ?? {}).sort()) process.stdout.write(`${id}\n`);
    return 0;
  }
  if (argv.includes('--docs')) {
    process.stdout.write(renderDocs());
    return 0;
  }

  const jsonMode = argv.includes('--json');
  const ids = argv.filter((a) => !a.startsWith('--'));
  if (ids.length === 0) {
    process.stderr.write('usage: node preflight.mjs <id> [<id>...] | --list | --docs | --json\n');
    return 2;
  }

  const { ok, results } = checkRequirements(ids);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok, results }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatResults(results)}\n`);
  }
  return ok ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = runCli(process.argv.slice(2));
}
