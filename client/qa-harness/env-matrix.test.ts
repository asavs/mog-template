import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PREVIEW_VM_SENTINEL,
  checkRequirements,
  checkTool,
  deriveSupportMatrix,
  deriveToolSupport,
  fingerprintEnvironment,
  formatUnsupportedBanner,
  loadEnvironments,
  loadRegistry,
  renderMatrix,
  type EnvironmentCell,
  type Environments,
  type Registry,
  type ToolCheckContext,
} from '../../tools/env-requirements/preflight.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENVIRONMENTS_PATH = path.join(REPO_ROOT, 'tools', 'env-requirements', 'environments.json');
const MATRIX_DOCS_PATH = path.join(REPO_ROOT, 'docs', 'environment-matrix.md');

const registry = loadRegistry();
const environments = loadEnvironments();

// Cells every fingerprint branch can return — they must exist in
// environments.json or a detected environment would have no declaration.
const FINGERPRINTABLE_CELLS = ['windows-native', 'wsl', 'ci-runner', 'preview-vm'];

// A minimal injectable fs stub (mirrors the makeFs pattern in
// env-requirements.test.ts): existsSync answers from a path set, readFileSync
// from a content map, everything normalized to forward slashes.
function makeFs(opts: { exists?: string[]; files?: Record<string, string>; throwOn?: string[] } = {}) {
  const exists = new Set((opts.exists ?? []).map((p) => p.replace(/\\/g, '/')));
  const files = opts.files ?? {};
  const throwOn = new Set((opts.throwOn ?? []).map((p) => p.replace(/\\/g, '/')));
  return {
    existsSync: (p: string) => {
      const key = p.replace(/\\/g, '/');
      if (throwOn.has(key)) throw new Error('EACCES');
      return exists.has(key);
    },
    readFileSync: (p: string) => {
      const key = p.replace(/\\/g, '/');
      if (throwOn.has(key)) throw new Error('EACCES');
      if (key in files) return files[key];
      throw new Error('ENOENT');
    },
    statSync: () => ({ size: 0 }),
    readdirSync: () => [],
  };
}

describe('environments.json schema', () => {
  it('declares every fingerprintable cell with label/platform/description/capabilities', () => {
    const cells = environments.environments;
    for (const id of FINGERPRINTABLE_CELLS) {
      expect(cells[id], `cell ${id} declared`).toBeTruthy();
    }
    for (const [id, cell] of Object.entries(cells)) {
      expect(typeof cell.label, `${id}.label`).toBe('string');
      expect(cell.label.length, `${id}.label non-empty`).toBeGreaterThan(0);
      expect(typeof cell.description, `${id}.description`).toBe('string');
      expect(cell.description.length, `${id}.description non-empty`).toBeGreaterThan(0);
      expect(['win32', 'linux'], `${id}.platform`).toContain(cell.platform);
      expect(Array.isArray(cell.capabilities), `${id}.capabilities is an array`).toBe(true);
      expect(cell.capabilities.length, `${id}.capabilities non-empty`).toBeGreaterThan(0);
      expect(new Set(cell.capabilities).size, `${id}.capabilities has no duplicates`).toBe(cell.capabilities.length);
    }
  });

  it('every capability id references a requirement in requirements.json', () => {
    for (const [id, cell] of Object.entries(environments.environments)) {
      for (const cap of cell.capabilities) {
        expect(registry.requirements[cap], `${id} capability ${cap} exists in requirements.json`).toBeTruthy();
      }
    }
  });

  it('the on-disk environments file is valid JSON with an environments object', () => {
    const parsed = JSON.parse(fs.readFileSync(ENVIRONMENTS_PATH, 'utf8'));
    expect(parsed.environments).toBeTypeOf('object');
  });
});

describe('tools declarations (requirements.json `tools`)', () => {
  it('every tool has a label and a non-empty requires list', () => {
    const tools = registry.tools ?? {};
    expect(Object.keys(tools).length).toBeGreaterThan(0);
    for (const [id, tool] of Object.entries(tools)) {
      expect(typeof tool.label, `${id}.label`).toBe('string');
      expect(tool.label.length, `${id}.label non-empty`).toBeGreaterThan(0);
      expect(Array.isArray(tool.requires), `${id}.requires is an array`).toBe(true);
      expect(tool.requires.length, `${id}.requires non-empty`).toBeGreaterThan(0);
      expect(new Set(tool.requires).size, `${id}.requires has no duplicates`).toBe(tool.requires.length);
    }
  });

  it('every required id references a requirement in requirements.json', () => {
    for (const [id, tool] of Object.entries(registry.tools ?? {})) {
      for (const req of tool.requires) {
        expect(registry.requirements[req], `${id} requires ${req} which exists in requirements.json`).toBeTruthy();
      }
    }
  });

  it('the stage-A call sites kept their requirement semantics', () => {
    // These lists are load-bearing: run-harness.ts and preview-up/down.sh now
    // check by tool name, so a silent edit here silently changes what those
    // call sites verify. Update deliberately, with the call sites in mind.
    const tools = registry.tools!;
    expect(tools['qa-harness-pr'].requires).toEqual(['gh-cli', 'gh-auth', 'windows-node-modules']);
    expect(tools['qa-harness-local'].requires).toEqual(['headed-display', 'wsl-available', 'windows-node-modules']);
    expect(tools['preview-up'].requires).toEqual(['gcloud-cli', 'gcloud-auth', 'lfs-real-assets', 'openssh-not-plink']);
    expect(tools['preview-down'].requires).toEqual(['gcloud-cli', 'gcloud-auth']);
  });
});

describe('fingerprintEnvironment', () => {
  it('GITHUB_ACTIONS=true wins on any platform', () => {
    expect(fingerprintEnvironment({ platform: 'linux', env: { GITHUB_ACTIONS: 'true' }, fs: makeFs() }).id).toBe('ci-runner');
    expect(fingerprintEnvironment({ platform: 'win32', env: { GITHUB_ACTIONS: 'true' }, fs: makeFs() }).id).toBe('ci-runner');
    // ...even over preview-vm and wsl markers
    const noisy = fingerprintEnvironment({
      platform: 'linux',
      env: { GITHUB_ACTIONS: 'true', WSL_DISTRO_NAME: 'Ubuntu' },
      fs: makeFs({ exists: [PREVIEW_VM_SENTINEL] }),
    });
    expect(noisy.id).toBe('ci-runner');
  });

  it('linux + the preview-bootstrap sentinel is preview-vm (and beats WSL markers)', () => {
    const r = fingerprintEnvironment({
      platform: 'linux',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      fs: makeFs({ exists: [PREVIEW_VM_SENTINEL] }),
    });
    expect(r.id).toBe('preview-vm');
    expect(r.detail).toContain('/var/lib/mog-preview/provisioned');
  });

  it('linux + WSL_DISTRO_NAME or a microsoft /proc/version is wsl', () => {
    expect(fingerprintEnvironment({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, fs: makeFs() }).id).toBe('wsl');
    const viaProc = fingerprintEnvironment({
      platform: 'linux',
      env: {},
      fs: makeFs({ files: { '/proc/version': 'Linux version 5.15.90.1-microsoft-standard-WSL2' } }),
    });
    expect(viaProc.id).toBe('wsl');
  });

  it('win32 is windows-native; unmarked linux and other platforms are unknown', () => {
    expect(fingerprintEnvironment({ platform: 'win32', env: {}, fs: makeFs() }).id).toBe('windows-native');
    const plainLinux = fingerprintEnvironment({
      platform: 'linux',
      env: {},
      fs: makeFs({ files: { '/proc/version': 'Linux version 6.1.0-generic' } }),
    });
    expect(plainLinux.id).toBe('unknown');
    expect(fingerprintEnvironment({ platform: 'darwin', env: {}, fs: makeFs() }).id).toBe('unknown');
  });

  it('never crashes on a throwing fs', () => {
    const r = fingerprintEnvironment({
      platform: 'linux',
      env: {},
      fs: makeFs({ throwOn: [PREVIEW_VM_SENTINEL, '/proc/version'] }),
    });
    expect(r.id).toBe('unknown');
  });

  it('every non-unknown fingerprint id has a declared cell', () => {
    for (const id of FINGERPRINTABLE_CELLS) {
      expect(environments.environments[id], `fingerprint target ${id} declared in environments.json`).toBeTruthy();
    }
  });
});

// Fabricated single-axis fixtures so the subset math is tested in isolation.
const fakeRegistry: Registry = {
  requirements: {
    a: { why: 'w', remedy: 'r', probe: { type: 'env-var', name: 'A' }, severity: 'fail' },
    b: { why: 'w', remedy: 'r', probe: { type: 'env-var', name: 'B' }, severity: 'fail' },
    'win-only': { why: 'w', remedy: 'r', probe: { type: 'env-var', name: 'W' }, severity: 'fail', platforms: ['win32'] },
    hazard: { why: 'w', remedy: 'r', probe: { type: 'env-var', name: 'H' }, severity: 'warn' },
  },
  tools: {
    t: { label: 't', requires: ['a', 'b', 'win-only', 'hazard'] },
  },
};
const linuxCell = (capabilities: string[]): EnvironmentCell => ({
  label: 'cell',
  platform: 'linux',
  description: 'd',
  capabilities,
});

describe('deriveToolSupport (subset math)', () => {
  const tool = fakeRegistry.tools!.t;

  it('supported when every applicable fail-severity requirement is a capability', () => {
    const r = deriveToolSupport(tool, linuxCell(['a', 'b', 'hazard']), fakeRegistry);
    expect(r).toEqual({ supported: true, missing: [], warnings: [] });
  });

  it('reports the missing fail-severity ids', () => {
    const r = deriveToolSupport(tool, linuxCell(['a', 'hazard']), fakeRegistry);
    expect(r.supported).toBe(false);
    expect(r.missing).toEqual(['b']);
  });

  it('platform-inapplicable requirements are vacuously covered', () => {
    // win-only is not in the linux cell's capabilities, yet does not count
    // as missing there — but on a win32 cell it does.
    const linux = deriveToolSupport(tool, linuxCell(['a', 'b', 'hazard']), fakeRegistry);
    expect(linux.missing).toEqual([]);
    const win = deriveToolSupport(
      tool,
      { ...linuxCell(['a', 'b', 'hazard']), platform: 'win32' },
      fakeRegistry,
    );
    expect(win.supported).toBe(false);
    expect(win.missing).toEqual(['win-only']);
  });

  it('missing warn-severity ids keep the cell supported but are surfaced (warns stay warns)', () => {
    const r = deriveToolSupport(tool, linuxCell(['a', 'b']), fakeRegistry);
    expect(r.supported).toBe(true);
    expect(r.warnings).toEqual(['hazard']);
  });
});

describe('platform-gated requirements at check time', () => {
  it('SKIP on an inapplicable platform, probed on an applicable one', () => {
    const skipped = checkRequirements(['win-only'], { registry: fakeRegistry, platform: 'linux', env: {} });
    expect(skipped.results[0].status).toBe('SKIP');
    expect(skipped.ok).toBe(true);

    const probed = checkRequirements(['win-only'], { registry: fakeRegistry, platform: 'win32', env: {} });
    expect(probed.results[0].status).toBe('FAIL');
    expect(probed.ok).toBe(false);
  });
});

describe('checkTool', () => {
  const fakeEnvironments: Environments = {
    environments: {
      'has-it': { ...linuxCell(['a', 'b', 'hazard']), label: 'has-it' },
      wsl: { ...linuxCell(['a']), label: 'lacks-b' },
    },
  };
  const opts: ToolCheckContext = {
    registry: fakeRegistry,
    environments: fakeEnvironments,
    platform: 'linux',
    fs: makeFs(),
  };

  it('combines probe results with the derived verdict for the fingerprinted cell', () => {
    const r = checkTool('t', { ...opts, env: { WSL_DISTRO_NAME: 'Ubuntu', A: '1' } });
    expect(r.fingerprint.id).toBe('wsl');
    expect(r.support?.supported).toBe(false);
    expect(r.support?.missing).toEqual(['b']);
    expect(r.supportedIn).toEqual(['has-it']);
    expect(r.ok).toBe(false); // B unset -> the b probe fails too
    const banner = formatUnsupportedBanner(r);
    expect(banner).toContain(`'t' is not supported in wsl`);
    expect(banner).toContain('missing: b');
    expect(banner).toContain('supported environments: has-it');
  });

  it('no banner for a supported or unknown cell; omit drops a requirement from the probe run', () => {
    const supported = checkTool('t', { ...opts, env: { GITHUB_ACTIONS: 'true', A: '1', B: '1' } });
    expect(supported.fingerprint.id).toBe('ci-runner');
    expect(supported.support).toBeNull(); // ci-runner not in the fake environments
    expect(formatUnsupportedBanner(supported)).toBeNull();

    const omitted = checkTool('t', { ...opts, env: { WSL_DISTRO_NAME: 'Ubuntu', A: '1' }, omit: ['b'] });
    expect(omitted.results.map((x) => x.id)).toEqual(['a', 'win-only', 'hazard']);
    expect(omitted.ok).toBe(true); // hazard is warn-severity, win-only SKIPs on linux
  });

  it('an unknown tool is reported, not thrown', () => {
    const r = checkTool('nope', opts);
    expect(r.ok).toBe(false);
    expect(r.tool).toBeNull();
    expect(r.results).toEqual([]);
  });
});

describe('every declared tool is supported somewhere (declaration regression)', () => {
  it('has at least one supporting cell in the real declarations', () => {
    const matrix = deriveSupportMatrix(registry, environments);
    for (const [toolId, cells] of Object.entries(matrix)) {
      const supportedIn = Object.entries(cells).filter(([, s]) => s.supported);
      expect(supportedIn.length, `${toolId} supported in at least one environment`).toBeGreaterThan(0);
    }
  });
});

describe('matrix rendering', () => {
  it('is deterministic across calls', () => {
    expect(renderMatrix(registry, environments)).toBe(renderMatrix(registry, environments));
  });

  it('matches the committed generated doc (drift guard)', () => {
    const committed = fs.readFileSync(MATRIX_DOCS_PATH, 'utf8');
    expect(renderMatrix()).toBe(committed);
  });

  it('unsupported cells list their missing ids, warn-gapped cells their warns', () => {
    const doc = renderMatrix(fakeRegistry, {
      environments: {
        full: { ...linuxCell(['a', 'b', 'hazard']), label: 'full' },
        partial: { ...linuxCell(['a']), label: 'partial' },
        warned: { ...linuxCell(['a', 'b']), label: 'warned' },
      },
    });
    expect(doc).toContain('✗ missing: `b`');
    expect(doc).toContain('⚠ warns: `hazard`');
    expect(doc).toContain('✓');
  });
});
