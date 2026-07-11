import { describe, expect, it } from 'vitest';
import { assignPoolSlot } from './PlayerLightPool';

describe('assignPoolSlot', () => {
  it('assigns sequential slots to new keys in first-seen order', () => {
    const slotAssignments = new Map<string, number>();

    expect(assignPoolSlot('player-a', 3, slotAssignments)).toBe(0);
    expect(assignPoolSlot('player-b', 3, slotAssignments)).toBe(1);
    expect(assignPoolSlot('player-c', 3, slotAssignments)).toBe(2);
  });

  it('returns the same slot on repeated calls for an assigned key', () => {
    const slotAssignments = new Map<string, number>();

    expect(assignPoolSlot('player-a', 2, slotAssignments)).toBe(0);
    expect(assignPoolSlot('player-a', 2, slotAssignments)).toBe(0);
  });

  it('reuses a freed slot after the previous key is deleted', () => {
    const slotAssignments = new Map<string, number>();

    expect(assignPoolSlot('player-a', 2, slotAssignments)).toBe(0);
    expect(assignPoolSlot('player-b', 2, slotAssignments)).toBe(1);

    slotAssignments.delete('player-a');

    expect(assignPoolSlot('player-c', 2, slotAssignments)).toBe(0);
  });

  it('returns -1 once the pool is exhausted', () => {
    const slotAssignments = new Map<string, number>();

    expect(assignPoolSlot('player-a', 2, slotAssignments)).toBe(0);
    expect(assignPoolSlot('player-b', 2, slotAssignments)).toBe(1);
    expect(assignPoolSlot('player-c', 2, slotAssignments)).toBe(-1);
  });

  it('keeps a cached overflow key at -1 until that key is deleted', () => {
    const slotAssignments = new Map<string, number>();

    expect(assignPoolSlot('player-a', 1, slotAssignments)).toBe(0);
    expect(assignPoolSlot('player-overflow', 1, slotAssignments)).toBe(-1);

    slotAssignments.delete('player-a');

    expect(assignPoolSlot('player-overflow', 1, slotAssignments)).toBe(-1);
    slotAssignments.delete('player-overflow');
    expect(assignPoolSlot('player-overflow', 1, slotAssignments)).toBe(0);
  });
});
