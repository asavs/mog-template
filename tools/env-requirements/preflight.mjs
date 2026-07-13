/**
 * Environment-requirements preflight engine.
 *
 * ONE runtime, ZERO npm dependencies — this must run before (and without) any
 * `npm install`, so it uses only Node's built-in modules. It is dual-use:
 *
 *   - CLI:    node tools/env-requirements/preflight.mjs <id> [<id>...]
 *             node tools/env-requirements/preflight.mjs --tool <name>
 *             node tools/env-requirements/preflight.mjs --list | --docs |
 *                       --matrix | --fingerprint
 *             node tools/env-requirements/preflight.mjs --help
 *             (--json gives the machine-readable form of --tool,
 *              --fingerprint, or a bare id list)
 *   - Module: import { checkRequirements, checkTool, fingerprintEnvironment }
 *             from './preflight.mjs'
 *
 * See tools/env-requirements/README.md for the architecture and the recipes
 * for adding a requirement, a tool, or an environment.
 *
 * ONE declaration axis — everything else derived:
 *   - requirements.json `requirements` — the probe registry (why/remedy/probe/
 *     severity, optionally `platforms` for host-specific requirements).
 *   - requirements.json `tools` — each runnable tool's `requires` id list.
 *   - environments.json `environments` — the environment cells and which
 *     requirement ids each CAN satisfy (`capabilities`).
 * A tool is supported in a cell iff every fail-severity requirement it needs
 * is satisfiable there; the tool x environment matrix
 * (docs/environment-matrix.md) and the runtime "not supported in <cell>"
 * verdicts are all derived from those declarations, never hand-maintained.
 *
 * Probes are declarative (a fixed set of probe types); `command-succeeds` is
 * the one free-form escape hatch and the docs renderer marks entries using it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(__dirname, 'requirements.json');
const ENVIRONMENTS_PATH = path.join(__dirname, 'environments.json');

/**
 * Sentinel dropped by scripts/preview-bootstrap.sh once a preview VM is
 * provisioned; its presence is what fingerprints a box as `preview-vm`.
 */
export const PREVIEW_VM_SENTINEL = '/var/lib/mog-preview/provisioned';

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

/** Load and return the registry object ({ requirements, tools }). */
export function loadRegistry(registryPath = REGISTRY_PATH) {
  const raw = fs.readFileSync(registryPath, 'utf8');
  return JSON.parse(raw);
}

/** Load and return the environments object ({ environments: { id: {...} } }). */
export function loadEnvironments(environmentsPath = ENVIRONMENTS_PATH) {
  const raw = fs.readFileSync(environmentsPath, 'utf8');
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
      // On Windows, CLIs like `gcloud`/`gh` are often .cmd/.ps1 shims, not
      // .exe. Node refuses to run a .cmd via execFile without a shell and
      // throws ENOENT even when the tool is present, so a probe would report
      // a false FAIL. Command + args here are static registry values (never
      // user input), so a shell is safe. Verified: `--format=value(account)`
      // survives cmd.exe unquoted.
      shell: process.platform === 'win32',
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
 * A requirement with a `platforms` list only applies on those platforms;
 * anywhere else it is vacuously satisfied (SKIP at check time, "covered" in
 * the derived support matrix). No `platforms` field = applies everywhere.
 */
export function isRequirementApplicable(req, platform) {
  return !Array.isArray(req?.platforms) || req.platforms.includes(platform);
}

/**
 * Check the given requirement ids against the environment.
 * @param {string[]} ids
 * @param {object} [opts] - { env, platform, cwd, fs, run, which, registry }
 * @returns {{ ok: boolean, results: Array<{
 *   id, status: 'PASS'|'FAIL'|'WARN'|'SKIP', severity, why, remedy, probe, detail
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
    if (!isRequirementApplicable(req, ctx.platform)) {
      results.push({
        id,
        status: 'SKIP',
        severity: req.severity,
        why: req.why,
        remedy: req.remedy,
        probe: req.probe,
        detail: `not applicable on ${ctx.platform} (applies to: ${req.platforms.join(', ')})`,
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
// Environment fingerprint — which cell of environments.json is this process
// running in? Fingerprint ids are STABLE: the planned per-environment QA
// baseline-profile system (issue #27) will reuse them as its environment
// profile ids, so renaming a cell is a breaking change there too.
// ---------------------------------------------------------------------------

/**
 * Detect the current environment cell. Never throws; returns
 * { id: '<cell-id>' | 'unknown', detail: '<what matched>' }.
 *
 * Detection order:
 *   1. GITHUB_ACTIONS=true            -> ci-runner (Actions sets it on every OS)
 *   2. linux + preview-VM sentinel    -> preview-vm
 *   3. linux + WSL markers            -> wsl (WSL_DISTRO_NAME, or 'microsoft'
 *                                       in /proc/version for older setups)
 *   4. win32                          -> windows-native
 *   5. anything else                  -> unknown
 */
export function fingerprintEnvironment(opts = {}) {
  const ctx = makeContext(opts);
  if (ctx.env.GITHUB_ACTIONS === 'true') {
    return { id: 'ci-runner', detail: 'GITHUB_ACTIONS=true' };
  }
  if (ctx.platform === 'linux') {
    try {
      if (ctx.fs.existsSync(PREVIEW_VM_SENTINEL)) {
        return { id: 'preview-vm', detail: `${PREVIEW_VM_SENTINEL} present` };
      }
    } catch {
      /* unreadable sentinel path — keep detecting */
    }
    if (typeof ctx.env.WSL_DISTRO_NAME === 'string' && ctx.env.WSL_DISTRO_NAME.length > 0) {
      return { id: 'wsl', detail: `WSL_DISTRO_NAME=${ctx.env.WSL_DISTRO_NAME}` };
    }
    try {
      if (/microsoft/i.test(ctx.fs.readFileSync('/proc/version', 'utf8'))) {
        return { id: 'wsl', detail: `'microsoft' in /proc/version` };
      }
    } catch {
      /* no /proc/version — keep detecting */
    }
    return { id: 'unknown', detail: 'linux without a ci/preview-vm/wsl marker' };
  }
  if (ctx.platform === 'win32') {
    return { id: 'windows-native', detail: 'platform win32' };
  }
  return { id: 'unknown', detail: `unrecognized platform: ${ctx.platform}` };
}

// ---------------------------------------------------------------------------
// Derivation — tool x environment support, computed from the declarations
// ---------------------------------------------------------------------------

/**
 * Is `tool` supported in `cell`? A requirement id is covered when it is in
 * the cell's capabilities, or when it does not apply to the cell's platform
 * at all (e.g. win32-only requirements in a linux cell). Missing fail-severity
 * ids make the cell unsupported; missing warn-severity ids keep it supported
 * but are surfaced as warnings (warns stay warns).
 * @returns {{ supported: boolean, missing: string[], warnings: string[] }}
 */
export function deriveToolSupport(tool, cell, registry = loadRegistry()) {
  const reqs = registry.requirements ?? {};
  const capabilities = new Set(cell.capabilities ?? []);
  const missing = [];
  const warnings = [];
  for (const id of tool.requires ?? []) {
    if (capabilities.has(id)) continue;
    const req = reqs[id];
    if (req && !isRequirementApplicable(req, cell.platform)) continue;
    if (req?.severity === 'warn') warnings.push(id);
    else missing.push(id);
  }
  return { supported: missing.length === 0, missing, warnings };
}

/**
 * The full derived matrix: { [toolId]: { [cellId]: deriveToolSupport(...) } }.
 */
export function deriveSupportMatrix(registry = loadRegistry(), environments = loadEnvironments()) {
  const tools = registry.tools ?? {};
  const cells = environments.environments ?? {};
  const matrix = {};
  for (const toolId of Object.keys(tools).sort()) {
    matrix[toolId] = {};
    for (const cellId of Object.keys(cells).sort()) {
      matrix[toolId][cellId] = deriveToolSupport(tools[toolId], cells[cellId], registry);
    }
  }
  return matrix;
}

/**
 * Check one named tool's requirements against the live environment, plus the
 * derived where-is-this-supported verdict for the fingerprinted cell.
 * `opts.omit` drops requirement ids a runtime flag makes irrelevant (e.g. the
 * harness omits headed-display under QA_HEADLESS=1).
 * @returns {{ ok, toolName, tool, fingerprint, support, supportedIn, results }}
 */
export function checkTool(toolName, opts = {}) {
  const registry = opts.registry ?? loadRegistry();
  const environments = opts.environments ?? loadEnvironments();
  const fingerprint = fingerprintEnvironment(opts);
  const tool = (registry.tools ?? {})[toolName];
  if (!tool) {
    return {
      ok: false,
      toolName,
      tool: null,
      fingerprint,
      support: null,
      supportedIn: [],
      results: [],
    };
  }
  const cells = environments.environments ?? {};
  const supportedIn = Object.keys(cells)
    .sort()
    .filter((cellId) => deriveToolSupport(tool, cells[cellId], registry).supported);
  const cell = cells[fingerprint.id];
  const support = cell ? deriveToolSupport(tool, cell, registry) : null;
  const omit = new Set(opts.omit ?? []);
  const ids = (tool.requires ?? []).filter((id) => !omit.has(id));
  const { ok, results } = checkRequirements(ids, { ...opts, registry });
  return { ok, toolName, tool, fingerprint, support, supportedIn, results };
}

/**
 * The derived "not supported here" banner, or null when it doesn't apply
 * (supported cell, unknown fingerprint, or warn-only gaps). Callers print it
 * BEFORE the per-probe output when the check failed.
 */
export function formatUnsupportedBanner(outcome) {
  const { toolName, fingerprint, support, supportedIn } = outcome;
  if (!support || support.supported) return null;
  return (
    `'${toolName}' is not supported in ${fingerprint.id} (missing: ${support.missing.join(', ')}); ` +
    `supported environments: ${supportedIn.length > 0 ? supportedIn.join(', ') : '(none)'}`
  );
}

// ---------------------------------------------------------------------------
// Text formatting (shared by the CLI and by run-harness)
// ---------------------------------------------------------------------------

const GLYPH = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', SKIP: 'SKIP' };

/** Format one result as human-readable lines (why/remedy shown on FAIL/WARN). */
export function formatResult(r) {
  const lines = [`[${GLYPH[r.status] ?? r.status}] ${r.id} — ${r.detail}`];
  if (r.status === 'FAIL' || r.status === 'WARN') {
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
    const severity = Array.isArray(req.platforms)
      ? `${req.severity} (${req.platforms.join('/')} only)`
      : req.severity;
    return `| \`${id}\` | ${escapeCell(req.why)} | ${escapeCell(req.remedy)} | ${severity} | \`${escapeCell(describeProbe(req.probe))}\`${mark} |`;
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
    'See [`tools/env-requirements/README.md`](../tools/env-requirements/README.md)',
    'for the architecture and the recipe for adding a requirement. The derived',
    'tool × environment support matrix lives in',
    '[`environment-matrix.md`](environment-matrix.md).',
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

/**
 * Render the generated tool x environment support matrix markdown.
 * Deterministic: sorted tool rows, sorted environment columns, no timestamps.
 */
export function renderMatrix(registry = loadRegistry(), environments = loadEnvironments()) {
  const tools = registry.tools ?? {};
  const cells = environments.environments ?? {};
  const toolIds = Object.keys(tools).sort();
  const cellIds = Object.keys(cells).sort();
  const matrix = deriveSupportMatrix(registry, environments);

  const mark = (support) => {
    if (!support.supported) return `✗ missing: ${support.missing.map((id) => `\`${id}\``).join(', ')}`;
    if (support.warnings.length > 0) return `⚠ warns: ${support.warnings.map((id) => `\`${id}\``).join(', ')}`;
    return '✓';
  };

  const rows = toolIds.map((toolId) => {
    const cols = cellIds.map((cellId) => escapeCell(mark(matrix[toolId][cellId])));
    return `| \`${toolId}\` | ${cols.join(' | ')} |`;
  });

  const lines = [
    '# Environment support matrix',
    '',
    '<!-- GENERATED FILE — do not edit by hand.',
    '     Source of truth: tools/env-requirements/requirements.json (requirements + tools)',
    '                      tools/env-requirements/environments.json (cells + capabilities)',
    '     Regenerate:      node tools/env-requirements/preflight.mjs --matrix > docs/environment-matrix.md',
    '     CI fails if this file drifts from the declarations (.github/workflows/ci.yml). -->',
    '',
    'Which tool runs where — DERIVED, never hand-maintained. There is ONE',
    'declaration axis: each environment declares the requirement ids it can',
    'satisfy (`capabilities` in environments.json) and each tool declares the',
    'requirement ids it needs (`requires` in requirements.json). A tool is',
    'supported in an environment iff every fail-severity requirement it needs',
    'is satisfiable there; requirements that do not apply to an environment\'s',
    'platform (e.g. win32-only ones on Linux) are vacuously satisfied. ⚠ marks',
    'warn-severity gaps: the tool runs there, with the documented hazard.',
    '',
    'Detect which environment you are in (the same ids will double as the',
    'environment profile ids for the planned per-environment QA baselines,',
    'issue #27):',
    '',
    '```sh',
    'node tools/env-requirements/preflight.mjs --fingerprint',
    'node tools/env-requirements/preflight.mjs --tool preview-up',
    '```',
    '',
    'See [`tools/env-requirements/README.md`](../tools/env-requirements/README.md)',
    'for the architecture and how to add a tool or an environment, the',
    'per-requirement `why`/`remedy` reference in',
    '[`environment-requirements.md`](environment-requirements.md), and where this',
    'preflight fits the deploy flow in [`dev-pipeline.md`](dev-pipeline.md).',
    '',
    `| tool | ${cellIds.map((id) => `\`${id}\``).join(' | ')} |`,
    `|------|${cellIds.map(() => '---').join('|')}|`,
    ...rows,
    '',
    '## Environments',
    '',
  ];

  for (const cellId of cellIds) {
    const cell = cells[cellId];
    lines.push(`- **\`${cellId}\`** — ${cell.label}. ${cell.description}${cell.notes ? ` _${cell.notes}_` : ''}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE =
  'usage: node preflight.mjs <id> [<id>...] | --tool <name> | --list | --docs | --matrix | --fingerprint | --json | --help\n';

const HELP = `Environment-requirements preflight — check that the tools this repo runs have
what they need before they do real work, and see which tool runs where.

Invocations:
  <id> [<id>...]     Check specific requirement ids (see --list for the set).
  --tool <name>      Check every requirement a named tool needs, plus the
                     derived "supported here?" verdict for this environment.
  --list             List all requirement ids.
  --docs             Print the generated requirements reference (Markdown).
  --matrix           Print the generated tool x environment support matrix.
  --fingerprint      Print which environment cell this process is running in.
  --help, -h         Show this help.

Flags:
  --json             Machine-readable output, for --tool, --fingerprint, or a
                     bare id list.

Exit status: 0 all clear, 1 an unmet fail-severity requirement, 2 usage error.

Architecture and the "add a requirement / tool / environment" recipes:
  tools/env-requirements/README.md
`;

function runCli(argv) {
  const jsonMode = argv.includes('--json');

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  if (argv.includes('--list')) {
    const registry = loadRegistry();
    for (const id of Object.keys(registry.requirements ?? {}).sort()) process.stdout.write(`${id}\n`);
    return 0;
  }
  if (argv.includes('--docs')) {
    process.stdout.write(renderDocs());
    return 0;
  }
  if (argv.includes('--matrix')) {
    process.stdout.write(renderMatrix());
    return 0;
  }

  if (argv.includes('--fingerprint')) {
    const fingerprint = fingerprintEnvironment();
    if (!jsonMode) {
      process.stdout.write(`${fingerprint.id}\n`);
      return 0;
    }
    // Programmatic form: the fingerprint plus every tool's derived verdict
    // for this cell (supportedHere is null when the cell is unknown).
    const registry = loadRegistry();
    const environments = loadEnvironments();
    const matrix = deriveSupportMatrix(registry, environments);
    const tools = {};
    for (const toolId of Object.keys(matrix)) {
      const here = matrix[toolId][fingerprint.id] ?? null;
      tools[toolId] = {
        supportedHere: here ? here.supported : null,
        missingHere: here ? here.missing : [],
        warningsHere: here ? here.warnings : [],
        supportedIn: Object.keys(matrix[toolId]).filter((cellId) => matrix[toolId][cellId].supported),
      };
    }
    process.stdout.write(`${JSON.stringify({ fingerprint, tools }, null, 2)}\n`);
    return 0;
  }

  const toolFlag = argv.indexOf('--tool');
  if (toolFlag !== -1) {
    const toolName = argv[toolFlag + 1];
    if (!toolName || toolName.startsWith('--')) {
      process.stderr.write(USAGE);
      return 2;
    }
    const outcome = checkTool(toolName);
    if (!outcome.tool) {
      const known = Object.keys(loadRegistry().tools ?? {}).sort().join(', ');
      process.stderr.write(
        `unknown tool: ${toolName} (known tools: ${known}); tools are declared in tools/env-requirements/requirements.json\n`,
      );
      return 2;
    }
    if (jsonMode) {
      const { ok, toolName: name, fingerprint, support, supportedIn, results } = outcome;
      process.stdout.write(`${JSON.stringify({ ok, tool: name, fingerprint, support, supportedIn, results }, null, 2)}\n`);
    } else {
      // Name the fingerprinted environment first, so the derived "not supported
      // in <id>" verdict below reads in context (matches run-harness output).
      process.stdout.write(`${toolName} — environment: ${outcome.fingerprint.id} (${outcome.fingerprint.detail})\n`);
      // Derived verdict leads the failure output, before the per-probe lines.
      const banner = formatUnsupportedBanner(outcome);
      if (!outcome.ok && banner) process.stdout.write(`${banner}\n`);
      process.stdout.write(`${formatResults(outcome.results)}\n`);
    }
    return outcome.ok ? 0 : 1;
  }

  const ids = argv.filter((a) => !a.startsWith('--'));
  if (ids.length === 0) {
    process.stderr.write(USAGE);
    return 2;
  }

  const { ok, results } = checkRequirements(ids);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok, fingerprint: fingerprintEnvironment(), results }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatResults(results)}\n`);
  }
  return ok ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = runCli(process.argv.slice(2));
}
