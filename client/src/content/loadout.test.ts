/**
 * The default loadout is the one seam an equipment system replaces —
 * `PlayerBody` reads it and does nothing else to decide what a player is
 * holding. The meaningful assertion is not "the value is X" but "whatever it
 * points at is a stance that actually equips something visible and resolves
 * cleanly", so this stays true if the default is ever repointed.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_LOADOUT } from './loadout';
import { bindingFor } from './manifest';
import { SOCKETS } from './sockets';
import { PROP_KEYS } from './keys';
import { STANCES } from './stances';
import './procedural';

describe('DEFAULT_LOADOUT', () => {
  it('points at a stance that exists', () => {
    expect(STANCES[DEFAULT_LOADOUT.stance]).toBeDefined();
  });

  it('equips something in at least one hand, not an empty pose', () => {
    const stance = STANCES[DEFAULT_LOADOUT.stance];
    expect(stance.slots.length).toBeGreaterThan(0);
  });

  it('every slot it equips resolves to real content, not a dangling key', () => {
    const stance = STANCES[DEFAULT_LOADOUT.stance];
    for (const slot of stance.slots) {
      expect(bindingFor(slot.prop).origin, `${slot.prop} is unbound`).not.toBe('unbound');
    }
  });

  it('ships sword in the right hand and shield in the left', () => {
    // Today's default. This particular assertion is expected to change the
    // day the default loadout changes — that is the point of pinning it: a
    // silent repoint (e.g. an accidental edit leaving both props in one hand)
    // fails loudly instead of only showing up on video review.
    const stance = STANCES[DEFAULT_LOADOUT.stance];
    expect(stance.slots).toContainEqual({ prop: PROP_KEYS.sword, socket: SOCKETS.rightHand });
    expect(stance.slots).toContainEqual({ prop: PROP_KEYS.shield, socket: SOCKETS.leftHand });
  });
});
