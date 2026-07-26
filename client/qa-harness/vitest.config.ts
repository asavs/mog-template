/**
 * Separate vitest project for qa-harness's own unit tests (pure functions: scenario
 * generation, grid/invariant/net-proxy/preview-target/env-requirements math). Deliberately NOT
 * folded into the root vite.config.ts's `test.include` (that stays scoped to `src/**` — the
 * excision that dropped the old game's qa-harness scenarios also dropped these tests from the
 * client gate, see `npm test`/CI's `Run client tests` step). Run standalone with `npm run
 * qa:test`; this is unit tests only (Node, no browser/SpacetimeDB) — the harness's actual
 * browser-driving code is exercised live via `npm run qa:harness`, not here.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['qa-harness/**/*.test.ts'],
    root: '.',
  },
});
