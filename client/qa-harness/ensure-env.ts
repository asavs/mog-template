/**
 * Idempotent local-environment bootstrap for the movement/camera/combat QA harness.
 *
 * Brings up two things the harness needs, skipping anything already running:
 *  - a SpacetimeDB instance inside WSL2 Ubuntu, isolated from the production VM
 *    (scripts/qa-harness/start-local-stdb.sh)
 *  - the Vite dev server on this (Windows) machine, which proxies /v1 to
 *    127.0.0.1:3000 and so must reach the same loopback SpacetimeDB instance
 *    (WSL2 forwards localhost ports to Windows by default, which is what makes
 *    this work without any extra networking setup)
 *
 * Run standalone with `npm run qa:env:up`, or let run-harness.ts call it.
 */
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLIENT_DIR = path.resolve(__dirname, '..');

const STDB_PORT = 3000;
const VITE_PORT = 5173;
const PROBE_TIMEOUT_MS = 1500;
const READY_TIMEOUT_MS = 30000;

function probePort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForPort(port: number, timeoutMs: number, host = '127.0.0.1'): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probePort(port, host)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function toWslPath(winPath: string): string {
  const normalized = winPath.replace(/\\/g, '/');
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) throw new Error(`Cannot convert to a WSL path: ${winPath}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

/** @returns true if this call started the instance (fresh DB, needs a publish). */
async function ensureSpacetimeDb(): Promise<boolean> {
  if (await probePort(STDB_PORT)) {
    console.log(`[ensure-env] SpacetimeDB already reachable on 127.0.0.1:${STDB_PORT}`);
    return false;
  }

  console.log('[ensure-env] SpacetimeDB not reachable, starting it inside WSL2 Ubuntu...');
  runStdbScript([]);

  const ready = await waitForPort(STDB_PORT, READY_TIMEOUT_MS);
  if (!ready) {
    throw new Error(`SpacetimeDB did not become reachable on 127.0.0.1:${STDB_PORT} within ${READY_TIMEOUT_MS}ms`);
  }
  return true;
}

function runStdbScript(extraArgs: string[]) {
  const scriptPath = toWslPath(path.join(REPO_ROOT, 'scripts', 'qa-harness', 'start-local-stdb.sh'));
  execFileSync('wsl', ['-d', 'Ubuntu', '-u', 'root', '--', 'bash', scriptPath, ...extraArgs], { stdio: 'inherit' });
}

// ---------------------------------------------------------------------------
// Module staleness: a schema change on master without a local republish makes
// every row decode misaligned and joins die with a cryptic
// `RangeError: Offset is outside the bounds of the DataView` — nowhere near
// the actual cause. Detect it here instead: content-address the server source
// (git tree hash + dirty marker) and compare against what was last published.
// ---------------------------------------------------------------------------

const MODULE_MARKER_PATH = path.join(__dirname, 'runs', '.stdb-module-tree');

function currentModuleTree(): string {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const tree = git(['rev-parse', 'HEAD:server/spacetimedb']);
  // Uncommitted server edits mean the working tree differs from HEAD's hash;
  // marking it dirty forces a republish every run until committed — that's
  // correct (published module must track the source under test), just noisy.
  const dirty = git(['status', '--porcelain', '--', 'server/spacetimedb']) !== '';
  return dirty ? `${tree}-dirty-${Date.now()}` : tree;
}

function lastPublishedModuleTree(): string | null {
  try {
    return fs.readFileSync(MODULE_MARKER_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

async function ensureModuleFresh(freshInstance: boolean, explicitPublish: boolean) {
  // Staleness management is for the Windows + WSL2 dev setup only. Other
  // environments (CI's Linux runners) publish the module themselves as part
  // of their own bring-up and never have `wsl` to shell into.
  if (process.platform !== 'win32') return;
  const current = currentModuleTree();
  const published = lastPublishedModuleTree();
  const stale = current !== published;

  if (!freshInstance && !explicitPublish && !stale) return;

  const reason = explicitPublish
    ? '--publish requested'
    : freshInstance
      ? 'fresh SpacetimeDB instance'
      : `module stale (published ${published ?? 'unknown'}, source ${current})`;

  if (process.env.QA_AUTO_PUBLISH === '0' && !explicitPublish) {
    throw new Error(
      `[ensure-env] ${reason}, but QA_AUTO_PUBLISH=0 — refusing to run against a mismatched module. ` +
        'Republish (npm run qa:env:up -- --publish) or unset QA_AUTO_PUBLISH.',
    );
  }

  console.log(`[ensure-env] Publishing server module (${reason})...`);
  runStdbScript(['--publish']);
  fs.mkdirSync(path.dirname(MODULE_MARKER_PATH), { recursive: true });
  fs.writeFileSync(MODULE_MARKER_PATH, `${current}\n`);
  console.log('[ensure-env] Module published and marker updated.');
}

async function ensureViteServer() {
  // QA_WEB_MODE=preview serves the built bundle (`vite preview`) instead of
  // the dev server — what CI uses, so the gate tests the artifact that
  // actually deploys. Default stays `dev` for local iteration.
  const mode = process.env.QA_WEB_MODE === 'preview' ? 'preview' : 'dev';

  // Vite's default `host: 'localhost'` resolves to whatever the OS prefers
  // (this machine resolves it to the IPv6 loopback, ::1, not 127.0.0.1), so
  // probe by hostname rather than assuming an address family.
  if (await probePort(VITE_PORT, 'localhost')) {
    console.log(`[ensure-env] Vite server already reachable on localhost:${VITE_PORT}`);
    return;
  }

  if (mode === 'preview' && !fs.existsSync(path.join(CLIENT_DIR, 'dist', 'index.html'))) {
    throw new Error('QA_WEB_MODE=preview but client/dist/index.html is missing — run `npm run build` (or download the build artifact) first.');
  }

  console.log(`[ensure-env] Vite server not reachable, starting \`npm run ${mode}\`...`);
  const logPath = path.join(CLIENT_DIR, 'qa-harness', 'runs', `vite-${mode}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, 'a');

  const args = mode === 'preview'
    ? ['run', 'preview', '--', '--port', String(VITE_PORT), '--strictPort']
    : ['run', 'dev'];
  const child = spawn('npm', args, {
    cwd: CLIENT_DIR,
    detached: true,
    stdio: ['ignore', log, log],
    shell: true,
  });
  child.unref();

  const ready = await waitForPort(VITE_PORT, READY_TIMEOUT_MS, 'localhost');
  if (!ready) {
    throw new Error(`Vite ${mode} server did not become reachable on localhost:${VITE_PORT} within ${READY_TIMEOUT_MS}ms. Check ${logPath}`);
  }
}

export async function ensureEnv(options: { publish?: boolean } = {}) {
  const freshInstance = await ensureSpacetimeDb();
  await ensureModuleFresh(freshInstance, options.publish ?? false);
  await ensureViteServer();
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  const publish = process.argv.includes('--publish');
  ensureEnv({ publish }).then(() => {
    console.log('[ensure-env] Local QA environment is up.');
  }).catch((err) => {
    console.error('[ensure-env] Failed to bring up local QA environment:', err);
    process.exit(1);
  });
}
