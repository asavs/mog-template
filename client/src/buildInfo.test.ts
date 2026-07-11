import { describe, expect, it } from 'vitest';
import { buildInfo } from './buildInfo';

describe('buildInfo', () => {
  it('exposes the injected build commit', () => {
    expect(buildInfo.commit).toBe(__BUILD_COMMIT__);
    expect(buildInfo.commit.trim().length).toBeGreaterThan(0);
  });
});
