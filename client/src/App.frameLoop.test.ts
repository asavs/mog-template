import { describe, expect, it } from 'vitest';
import { frameLoopAdvanceTimeSeconds } from './frameLoop';

describe('frameLoopAdvanceTimeSeconds', () => {
  it('starts the manual R3F clock at zero seconds', () => {
    expect(frameLoopAdvanceTimeSeconds(12_345, 12_345)).toBe(0);
  });

  it('converts requestAnimationFrame milliseconds to relative seconds', () => {
    expect(frameLoopAdvanceTimeSeconds(12_361.667, 12_345)).toBeCloseTo(0.016667);
    expect(frameLoopAdvanceTimeSeconds(13_345, 12_345)).toBe(1);
  });

  it('does not produce negative clock time for an out-of-order timestamp', () => {
    expect(frameLoopAdvanceTimeSeconds(12_000, 12_345)).toBe(0);
  });
});
