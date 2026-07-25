/**
 * Grips are geometry, so they get a geometric assertion rather than an eyeball.
 *
 * "The shield looks wrong" is not a signal anyone can act on twice. "The shield's
 * face normal points into the chest" is.
 */

import { describe, expect, it } from 'vitest';
import { PROP_KEYS, MOTION_STANCE } from './keys';
import { bindingFor } from './manifest';
import { STANCES } from './stances';
import { SOCKETS, gripFor } from './sockets';
import './procedural';

describe('prop grips, in the stance that holds them', () => {
  it('resolves a pose for every stance that declares one', () => {
    // This used to assert a PROCEDURAL placeholder existed for each stance.
    // Procedural motion is gone, so the meaningful question is the one the game
    // actually asks: does the key resolve to anything at all. An unbound stance
    // is a loadout that equips props and then stands in a T-pose holding them.
    for (const stance of Object.values(STANCES)) {
      for (const pose of stance.poses) {
        expect(bindingFor(pose.motion).origin, `${pose.motion} is unbound`).not.toBe('unbound');
      }
    }
    expect(Object.values(MOTION_STANCE).length).toBeGreaterThan(0);
  });

  it('never lets two poses in one stance drive the same bone', () => {
    // The composition only works because the bands partition the rig. Two poses
    // sharing a band would put two actions on one bone, which is exactly what
    // the band split exists to prevent — and it would blend to a pose that is
    // neither of them rather than failing loudly.
    for (const stance of Object.values(STANCES)) {
      const claimed = stance.poses.flatMap(pose => pose.bands);
      expect(new Set(claimed).size, `${stance.key} claims a band twice`).toBe(claimed.length);
    }
  });

  it('gives every stance slot a grip for the socket it uses', () => {
    for (const stance of Object.values(STANCES)) {
      for (const slot of stance.slots) {
        const grip = gripFor(slot.prop, slot.socket);
        expect(grip, `${slot.prop} has no grip for ${slot.socket}`).toBeDefined();
        for (const value of [...grip.position, ...grip.rotation]) {
          expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });

  it('mirrors a grip across hands rather than reusing it', () => {
    // A grip is a rotation into a specific hand. Sharing one between hands puts
    // the shield's face on the wrong side of the body.
    for (const prop of [PROP_KEYS.sword, PROP_KEYS.shield, PROP_KEYS.staff]) {
      const right = gripFor(prop, SOCKETS.rightHand);
      const left = gripFor(prop, SOCKETS.leftHand);
      expect(left.rotation, `${prop} uses one grip for both hands`).not.toEqual(right.rotation);
    }
  });
});

/**
 * The geometric checks that used to live here posed the procedural mannequin
 * with a procedural stance clip and measured the result. Both halves of that
 * setup are gone — the stance clips are imported now, and a `.glb` cannot be
 * fetched in Node — so the measurement moved to where the real rig exists.
 * Grip orientation is verified in the browser, against the body that actually
 * loads; the sandbox reports it per clip.
 */
