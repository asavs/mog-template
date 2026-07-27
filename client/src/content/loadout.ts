/**
 * What a player starts wearing, until an equipment system decides otherwise.
 *
 * A loadout names a stance. That is deliberately the whole row: `stances.ts`
 * already pairs a held pose with the prop + socket it puts in each hand
 * (`Stance['slots']`), so naming a stance is naming prop keys and grip sides
 * too — a loadout does not repeat that table, it points at it.
 *
 * This is the one seam a real equipment system replaces. `game/PlayerBody.tsx`
 * reads `DEFAULT_LOADOUT` today; a future inventory/equip system swaps what a
 * player's loadout resolves to (per-player, server-driven, whatever it turns
 * out to be) without any consumer of `Stance['slots']` changing, because none
 * of them mount a prop directly — they all go through this one row.
 */

import { STANCE_KEYS, type StanceKey } from './stances';

export type Loadout = {
  stance: StanceKey;
};

/** Every player, until equipment exists: sword in the right hand, shield in the left. */
export const DEFAULT_LOADOUT: Loadout = {
  stance: STANCE_KEYS.swordShield,
};
