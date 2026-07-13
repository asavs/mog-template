import { describe, expect, it } from 'vitest';
import {
  buildEnvUrl,
  isRemoteClientUrl,
  parseTargetArgs,
  readRuntimeConfig,
  withQaParam,
} from './resolve-target';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimePath = path.resolve(fileURLToPath(import.meta.url), '../../../deploy/runtime.json');

describe('resolve-target', () => {
  it('reads deploy/runtime.json and builds beta/prod URLs', () => {
    const runtime = readRuntimeConfig(runtimePath);
    expect(runtime.host).toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect(buildEnvUrl(runtime, 'beta')).toBe(`${runtime.protocol}://${runtime.host}/beta/`);
    expect(buildEnvUrl(runtime, 'prod')).toBe(`${runtime.protocol}://${runtime.host}/`);
  });

  it('classifies localhost as non-remote', () => {
    expect(isRemoteClientUrl('http://localhost:5173')).toBe(false);
    expect(isRemoteClientUrl('http://127.0.0.1:5173')).toBe(false);
    expect(isRemoteClientUrl('http://130.211.221.100/beta/')).toBe(true);
  });

  it('adds the qa gate param without breaking paths', () => {
    expect(withQaParam('http://example.test/beta/')).toMatch(/[?&]qa/);
    expect(withQaParam('http://example.test/beta/')).toContain('/beta/');
  });

  it('parses --beta / --pr / --expect-sha flags', () => {
    const a = parseTargetArgs(['--beta', '--pr', '20', '--require-align']);
    expect(a.beta).toBe(true);
    expect(a.pr).toBe(20);
    expect(a.requireAlign).toBe(true);

    const b = parseTargetArgs(['--expect-sha=abc1234']);
    expect(b.expectSha).toBe('abc1234');
  });
});
