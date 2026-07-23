import { describe, expect, it } from 'vitest';
import { loadHeightmapFromArrayBuffer, sampleHeight } from './heightmap';

describe('heightmap binary loader', () => {
  it('rejects buffers shorter than the HM01 header', () => {
    expect(() => loadHeightmapFromArrayBuffer(new ArrayBuffer(8))).toThrow(/too short/);
  });

  it('rejects wrong magic', () => {
    const buf = new ArrayBuffer(32);
    new Uint8Array(buf).set([0x00, 0x00, 0x00, 0x00]);
    expect(() => loadHeightmapFromArrayBuffer(buf)).toThrow(/Bad heightmap magic/);
  });

  it('still samples after vitest setup loaded the real bin', () => {
    const h = sampleHeight(0, 0);
    expect(Number.isFinite(h)).toBe(true);
    expect(h).toBeGreaterThan(0);
  });
});
