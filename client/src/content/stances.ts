/**
 * Stances: what the body does with a loadout when it is not doing anything else.
 *
 * A stance is deliberately NOT a set of locomotion clips. It is one looping
 * upper-band pose that stands in for locomotion's own upper body, so equipping a
 * staff changes idle, walk, and run at once. The alternative — a gait set per
 * weapon — multiplies every new weapon by every direction and speed, and is the
 * kind of content debt that makes people stop adding weapons.
 *
 * Two things travel together because they are the same decision: the pose, and
 * what is in each hand while you hold it. Equipment will eventually name a
 * stance key; nothing here knows about classes.
 */

import type { AnimationBand } from '../anim/mask';
import { MOTION_STANCE, PROP_KEYS, type MotionKey, type PropKey } from './keys';
import { SOCKETS, type SocketId } from './sockets';

export const STANCE_KEYS = {
  unarmed: 'stance.unarmed',
  staff: 'stance.staff',
  swordShield: 'stance.sword_shield',
} as const;

export type StanceKey = (typeof STANCE_KEYS)[keyof typeof STANCE_KEYS];

export type StanceSlot = {
  prop: PropKey;
  socket: SocketId;
};

/**
 * One clip supplying one part of a held pose.
 *
 * A stance is a list of these rather than a single clip because the poses we
 * own are per-arm. Bands must not overlap within a stance — two poses driving
 * one bone is the thing the band split exists to prevent.
 */
export type StancePose = {
  motion: MotionKey;
  bands: readonly AnimationBand[];
};

export type Stance = {
  key: StanceKey;
  label: string;
  /** Held pose, in one or more parts. Empty means locomotion's upper body is used unchanged. */
  poses: readonly StancePose[];
  slots: readonly StanceSlot[];
};

export const STANCES: Record<StanceKey, Stance> = {
  [STANCE_KEYS.unarmed]: {
    key: STANCE_KEYS.unarmed,
    label: 'unarmed',
    poses: [],
    slots: [],
  },
  [STANCE_KEYS.staff]: {
    key: STANCE_KEYS.staff,
    label: 'staff',
    // A one-handed vertical grip, but the clip poses the whole upper body, so
    // it takes the whole upper body. Splitting it would leave the free arm to
    // locomotion, which is a different look and not one anyone has asked for.
    poses: [{ motion: MOTION_STANCE.staff, bands: ['core', 'armL', 'armR'] }],
    slots: [{ prop: PROP_KEYS.staff, socket: SOCKETS.rightHand }],
  },
  [STANCE_KEYS.swordShield]: {
    key: STANCE_KEYS.swordShield,
    label: 'sword + shield',
    // Composed, because no clip in the library is sword-and-board. The shield
    // pose takes `core` along with its arm: at 74 degrees off idle it is much
    // the more committed of the two, and the torso was authored to support it.
    poses: [
      { motion: MOTION_STANCE.shield, bands: ['core', 'armL'] },
      { motion: MOTION_STANCE.sword, bands: ['armR'] },
    ],
    slots: [
      { prop: PROP_KEYS.sword, socket: SOCKETS.rightHand },
      { prop: PROP_KEYS.shield, socket: SOCKETS.leftHand },
    ],
  },
};

export const ALL_STANCE_KEYS: readonly StanceKey[] = Object.values(STANCE_KEYS);
