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
  /** When present, the requirement only applies on these platforms; elsewhere it is vacuously satisfied (SKIP / covered). */
  platforms?: string[];
}

export interface ToolDef {
  label: string;
  requires: string[];
}

export interface Registry {
  requirements: Record<string, Requirement>;
  tools?: Record<string, ToolDef>;
}

export interface EnvironmentCell {
  label: string;
  platform: string;
  description: string;
  capabilities: string[];
  notes?: string;
}

export interface Environments {
  environments: Record<string, EnvironmentCell>;
}

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';

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

export interface Fingerprint {
  /** An environments.json cell id, or 'unknown'. Stable — reused as the environment profile id by the planned baseline-profile system (issue #27). */
  id: string;
  detail: string;
}

export interface ToolSupport {
  supported: boolean;
  missing: string[];
  warnings: string[];
}

export interface ToolCheckOutcome extends CheckOutcome {
  toolName: string;
  tool: ToolDef | null;
  fingerprint: Fingerprint;
  /** Derived verdict for the fingerprinted cell; null when the fingerprint is 'unknown'. */
  support: ToolSupport | null;
  /** Sorted cell ids where the tool is supported. */
  supportedIn: string[];
}

export interface ToolCheckContext extends CheckContext {
  environments?: Environments;
  /** Requirement ids to skip (runtime flags can make a requirement irrelevant, e.g. QA_HEADLESS=1 needs no display). */
  omit?: string[];
}

export const PROBE_TYPES: readonly ProbeType[];
export const ESCAPE_HATCH_PROBE: 'command-succeeds';
export const PREVIEW_VM_SENTINEL: string;

export function loadRegistry(registryPath?: string): Registry;
export function loadEnvironments(environmentsPath?: string): Environments;
export function makeContext(opts?: CheckContext): Required<CheckContext>;
export function runProbe(probe: Probe, ctx?: CheckContext): { pass: boolean; detail: string };
export function isRequirementApplicable(req: Requirement, platform: string): boolean;
export function checkRequirements(ids: string[], opts?: CheckContext): CheckOutcome;
export function fingerprintEnvironment(opts?: CheckContext): Fingerprint;
export function deriveToolSupport(tool: ToolDef, cell: EnvironmentCell, registry?: Registry): ToolSupport;
export function deriveSupportMatrix(registry?: Registry, environments?: Environments): Record<string, Record<string, ToolSupport>>;
export function checkTool(toolName: string, opts?: ToolCheckContext): ToolCheckOutcome;
export function formatUnsupportedBanner(outcome: ToolCheckOutcome): string | null;
export function formatResult(r: CheckResult): string;
export function formatResults(results: CheckResult[]): string;
export function describeProbe(probe: Probe): string;
export function renderDocs(registry?: Registry): string;
export function renderMatrix(registry?: Registry, environments?: Environments): string;
