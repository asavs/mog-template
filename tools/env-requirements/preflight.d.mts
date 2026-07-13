/**
 * Type declarations for the zero-dependency preflight engine (preflight.mjs).
 * Hand-written so TypeScript consumers (the QA harness, vitest) can import the
 * plain-JS ESM engine with types without a build step.
 */

export type ProbeType =
  | 'binary-on-path'
  | 'env-var'
  | 'file-min-size'
  | 'node-modules-platform'
  | 'display-headed'
  | 'not-plink-transport'
  | 'command-succeeds';

export interface Probe {
  type: ProbeType | string;
  [param: string]: unknown;
}

export interface Requirement {
  why: string;
  remedy: string;
  probe: Probe;
  severity: 'fail' | 'warn';
}

export interface Registry {
  requirements: Record<string, Requirement>;
}

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN';

export interface CheckResult {
  id: string;
  status: CheckStatus;
  severity: 'fail' | 'warn';
  why: string;
  remedy: string;
  probe: Probe;
  detail: string;
}

export interface CheckOutcome {
  ok: boolean;
  results: CheckResult[];
}

export interface CheckContext {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  cwd?: string;
  fs?: unknown;
  run?: (command: string, args: string[]) => { status: number; stdout: string };
  which?: (binary: string) => boolean;
  registry?: Registry;
}

export const PROBE_TYPES: readonly ProbeType[];
export const ESCAPE_HATCH_PROBE: 'command-succeeds';

export function loadRegistry(registryPath?: string): Registry;
export function makeContext(opts?: CheckContext): Required<CheckContext>;
export function runProbe(probe: Probe, ctx?: CheckContext): { pass: boolean; detail: string };
export function checkRequirements(ids: string[], opts?: CheckContext): CheckOutcome;
export function formatResult(r: CheckResult): string;
export function formatResults(results: CheckResult[]): string;
export function describeProbe(probe: Probe): string;
export function renderDocs(registry?: Registry): string;
