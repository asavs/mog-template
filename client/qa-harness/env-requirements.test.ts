import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROBE_TYPES,
  checkRequirements,
  describeProbe,
  loadRegistry,
  renderDocs,
} from '../../tools/env-requirements/preflight.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'tools', 'env-requirements', 'requirements.json');
const DOCS_PATH = path.join(REPO_ROOT, 'docs', 'environment-requirements.md');

const registry = loadRegistry();

// A single-requirement registry so probe logic can be exercised in isolation
// with injected fs/env/platform stubs (no real filesystem or PATH access).
function oneReq(probe: Record<string, unknown>, severity: 'fail' | 'warn' = 'fail') {
  return { requirements: { x: { why: 'w', remedy: 'r', probe, severity } } };
}
function check(probe: Record<string, unknown>, opts: Record<string, unknown>, severity: 'fail' | 'warn' = 'fail') {
  return checkRequirements(['x'], { registry: oneReq(probe, severity), ...opts }).results[0];
}

describe('registry schema', () => {
  it('every entry has why/remedy/probe/severity with a known probe type', () => {
    const entries = Object.entries(registry.requirements);
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, req] of entries) {
      expect(typeof req.why, `${id}.why`).toBe('string');
      expect(req.why.length, `${id}.why non-empty`).toBeGreaterThan(0);
      expect(typeof req.remedy, `${id}.remedy`).toBe('string');
      expect(req.remedy.length, `${id}.remedy non-empty`).toBeGreaterThan(0);
      expect(['fail', 'warn'], `${id}.severity`).toContain(req.severity);
      expect(req.probe, `${id}.probe`).toBeTruthy();
      expect(PROBE_TYPES, `${id}.probe.type`).toContain(req.probe.type);
    }
  });

  it('the on-disk registry file is valid JSON with a requirements object', () => {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    expect(parsed.requirements).toBeTypeOf('object');
  });
});

describe('docs rendering', () => {
  it('is deterministic across calls', () => {
    expect(renderDocs(registry)).toBe(renderDocs(registry));
  });

  it('matches the committed generated doc (drift guard)', () => {
    const committed = fs.readFileSync(DOCS_PATH, 'utf8');
    expect(renderDocs()).toBe(committed);
  });

  it('marks command-succeeds (escape-hatch) rows and escapes table pipes', () => {
    const reg = {
      requirements: {
        z: { why: 'w', remedy: 'a | b', probe: { type: 'command-succeeds', command: 'gh', args: ['auth', 'status'] }, severity: 'fail' as const },
      },
    };
    const doc = renderDocs(reg);
    expect(doc).toContain('†'); // escape-hatch marker
    expect(doc).toContain('a \\| b'); // pipe escaped inside the table cell
  });
});

describe('describeProbe', () => {
  it('summarizes each probe type compactly', () => {
    expect(describeProbe({ type: 'binary-on-path', binary: 'gh' })).toBe('binary-on-path(gh)');
    expect(describeProbe({ type: 'env-var', name: 'FOO' })).toBe('env-var(FOO)');
    expect(describeProbe({ type: 'file-min-size', path: 'a.glb', minBytes: 5 })).toBe('file-min-size(a.glb >= 5)');
    expect(describeProbe({ type: 'display-headed' })).toBe('display-headed');
  });
});

describe('binary-on-path probe', () => {
  it('PASS when the resolver finds the binary', () => {
    const r = check({ type: 'binary-on-path', binary: 'gh' }, { which: () => true });
    expect(r.status).toBe('PASS');
  });
  it('FAIL when the resolver does not', () => {
    const r = check({ type: 'binary-on-path', binary: 'gh' }, { which: () => false });
    expect(r.status).toBe('FAIL');
  });
});

describe('env-var probe', () => {
  it('PASS when set and non-empty', () => {
    expect(check({ type: 'env-var', name: 'FOO' }, { env: { FOO: 'x' } }).status).toBe('PASS');
  });
  it('FAIL when unset or empty', () => {
    expect(check({ type: 'env-var', name: 'FOO' }, { env: {} }).status).toBe('FAIL');
    expect(check({ type: 'env-var', name: 'FOO' }, { env: { FOO: '' } }).status).toBe('FAIL');
  });
});

describe('file-min-size probe', () => {
  const fakeFs = (size: number | null) => ({
    existsSync: () => true,
    statSync: (_p: string) => {
      if (size === null) throw new Error('ENOENT');
      return { size };
    },
    readdirSync: () => [],
  });
  it('PASS when the file meets the minimum (real asset)', () => {
    const r = check({ type: 'file-min-size', path: 'a.glb', minBytes: 1000 }, { cwd: '/repo', fs: fakeFs(23_000_000) });
    expect(r.status).toBe('PASS');
  });
  it('FAIL for a pointer-sized file', () => {
    const r = check({ type: 'file-min-size', path: 'a.glb', minBytes: 1000 }, { cwd: '/repo', fs: fakeFs(130) });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('LFS pointer');
  });
  it('FAIL when the file is missing', () => {
    const r = check({ type: 'file-min-size', path: 'a.glb', minBytes: 1000 }, { cwd: '/repo', fs: fakeFs(null) });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('missing');
  });
});

describe('node-modules-platform probe', () => {
  const makeFs = (tree: Record<string, string[] | true>) => ({
    existsSync: (p: string) => Object.prototype.hasOwnProperty.call(tree, p.replace(/\\/g, '/')),
    statSync: () => ({ size: 0 }),
    readdirSync: (p: string) => {
      const v = tree[p.replace(/\\/g, '/')];
      return Array.isArray(v) ? v : [];
    },
  });
  it('FAIL when node_modules is absent', () => {
    const r = check({ type: 'node-modules-platform', dir: 'client' }, { cwd: '/repo', platform: 'win32', fs: makeFs({}) });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('missing');
  });
  it('FAIL on win32 when .bin has no *.cmd shims (Linux-native)', () => {
    const fsStub = makeFs({
      '/repo/client/node_modules': true,
      '/repo/client/node_modules/.bin': ['vite', 'eslint'],
    });
    const r = check({ type: 'node-modules-platform', dir: 'client' }, { cwd: '/repo', platform: 'win32', fs: fsStub });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('Linux-native');
  });
  it('PASS on win32 when .bin has *.cmd shims', () => {
    const fsStub = makeFs({
      '/repo/client/node_modules': true,
      '/repo/client/node_modules/.bin': ['vite', 'vite.cmd', 'eslint.cmd'],
    });
    const r = check({ type: 'node-modules-platform', dir: 'client' }, { cwd: '/repo', platform: 'win32', fs: fsStub });
    expect(r.status).toBe('PASS');
  });
  it('FAIL when @esbuild has no package for the current platform', () => {
    const fsStub = makeFs({
      '/repo/client/node_modules': true,
      '/repo/client/node_modules/@esbuild': ['linux-x64'],
    });
    const r = check({ type: 'node-modules-platform', dir: 'client' }, { cwd: '/repo', platform: 'win32', fs: fsStub });
    expect(r.status).toBe('FAIL');
    expect(r.detail).toContain('different OS');
  });
  it('PASS when @esbuild has the current platform package', () => {
    const fsStub = makeFs({
      '/repo/client/node_modules': true,
      '/repo/client/node_modules/@esbuild': ['linux-x64'],
    });
    const r = check({ type: 'node-modules-platform', dir: 'client' }, { cwd: '/repo', platform: 'linux', fs: fsStub });
    expect(r.status).toBe('PASS');
  });
});

describe('display-headed probe', () => {
  it('PASS on win32 regardless of DISPLAY', () => {
    expect(check({ type: 'display-headed' }, { platform: 'win32', env: {} }).status).toBe('PASS');
  });
  it('FAIL on linux without DISPLAY, PASS with it', () => {
    expect(check({ type: 'display-headed' }, { platform: 'linux', env: {} }).status).toBe('FAIL');
    expect(check({ type: 'display-headed' }, { platform: 'linux', env: { DISPLAY: ':99' } }).status).toBe('PASS');
  });
});

describe('not-plink-transport probe (warn)', () => {
  it('WARN on win32, PASS elsewhere', () => {
    expect(check({ type: 'not-plink-transport' }, { platform: 'win32' }, 'warn').status).toBe('WARN');
    expect(check({ type: 'not-plink-transport' }, { platform: 'linux' }, 'warn').status).toBe('PASS');
  });
});

describe('command-succeeds probe', () => {
  it('PASS on exit 0', () => {
    const r = check({ type: 'command-succeeds', command: 'gh', args: ['auth', 'status'] }, { run: () => ({ status: 0, stdout: '' }) });
    expect(r.status).toBe('PASS');
  });
  it('FAIL on non-zero exit', () => {
    const r = check({ type: 'command-succeeds', command: 'gh', args: ['auth', 'status'] }, { run: () => ({ status: 1, stdout: '' }) });
    expect(r.status).toBe('FAIL');
  });
  it('FAIL when expectOutputMatch is unmet even on exit 0', () => {
    const probe = { type: 'command-succeeds', command: 'gcloud', args: ['auth', 'list'], expectOutputMatch: '\\S' };
    expect(check(probe, { run: () => ({ status: 0, stdout: '   \n' }) }).status).toBe('FAIL');
    expect(check(probe, { run: () => ({ status: 0, stdout: 'me@example.com\n' }) }).status).toBe('PASS');
  });
});

describe('checkRequirements aggregate', () => {
  it('ok=false iff a fail-severity requirement fails; warns never flip ok', () => {
    const reg = {
      requirements: {
        good: { why: 'w', remedy: 'r', probe: { type: 'env-var', name: 'SET' }, severity: 'fail' as const },
        warnOnly: { why: 'w', remedy: 'r', probe: { type: 'env-var', name: 'MISSING' }, severity: 'warn' as const },
      },
    };
    const warned = checkRequirements(['good', 'warnOnly'], { registry: reg, env: { SET: '1' } });
    expect(warned.ok).toBe(true);
    expect(warned.results.map((r) => r.status)).toEqual(['PASS', 'WARN']);

    const failed = checkRequirements(['good'], { registry: reg, env: {} });
    expect(failed.ok).toBe(false);
  });

  it('unknown id is a FAIL, not a throw', () => {
    const r = checkRequirements(['nope'], { registry });
    expect(r.ok).toBe(false);
    expect(r.results[0].status).toBe('FAIL');
  });
});
