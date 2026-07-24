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

export type Stance = {
  key: StanceKey;
  label: string;
  /** Held pose. Null means locomotion's own upper body is used unchanged. */
  motion: MotionKey | null;
  slots: readonly StanceSlot[];
};

export const STANCES: Record<StanceKey, Stance> = {
  [STANCE_KEYS.unarmed]: {
    key: STANCE_KEYS.unarmed,
    label: 'unarmed',
    motion: null,
    slots: [],
  },
  [STANCE_KEYS.staff]: {
    key: STANCE_KEYS.staff,
    label: 'staff',
    motion: MOTION_STANCE.staff,
    slots: [{ prop: PROP_KEYS.staff, socket: SOCKETS.rightHand }],
  },
  [STANCE_KEYS.swordShield]: {
    key: STANCE_KEYS.swordShield,
    label: 'sword + shield',
    motion: MOTION_STANCE.swordShield,
    slots: [
      { prop: PROP_KEYS.sword, socket: SOCKETS.rightHand },
      { prop: PROP_KEYS.shield, socket: SOCKETS.leftHand },
    ],
  },
};

export const ALL_STANCE_KEYS: readonly StanceKey[] = Object.values(STANCE_KEYS);
