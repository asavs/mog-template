import { describe, expect, it } from 'vitest';
import { CASTLE_MIN_WALKABLE_NORMAL_Y } from './castleController';

describe('castle controller constants', () => {
  it('uses the same 60-degree walkable threshold everywhere in the client controller', () => {
    expect(CASTLE_MIN_WALKABLE_NORMAL_Y).toBeCloseTo(Math.cos((60 * Math.PI) / 180), 7);
  });
});
