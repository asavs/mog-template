/**
 * Set dressing for the dark-fantasy arena — placement data only.
 *
 * Props resolve through the content seam (`resolveProp`). Architecture lives in
 * `arenaArchitecture.ts`; this file is just where things stand.
 */

import { PROP_KEYS, SCENERY_KEYS } from '../content';

export type WorldPlacement = {
  key: string;
  at: readonly [number, number, number];
  /** Degrees, full euler — for held props used as set dressing. */
  rotate?: readonly [number, number, number];
  /** Degrees, yaw only — for scenery standing on its base. */
  turn?: number;
  scale?: number;
};

/**
 * A weapon stand with sword, axe, and shield mounted on it.
 *
 * Offsets are relative to the stand and rotated with its yaw, so moving the
 * rack takes the weapons along. Numbers match the stage `weaponRack` helper
 * (grip heights measured off the actual meshes).
 */
function weaponRack(
  at: readonly [number, number, number],
  turn: number,
): readonly WorldPlacement[] {
  const radians = (turn * Math.PI) / 180;
  const from = (dx: number, dy: number, dz: number): readonly [number, number, number] => [
    at[0] + dx * Math.cos(radians) + dz * Math.sin(radians),
    at[1] + dy,
    at[2] - dx * Math.sin(radians) + dz * Math.cos(radians),
  ];

  return [
    { key: SCENERY_KEYS.weaponStand, at, turn },
    // Blade up; grip ~0.38 off the floor clears the pommel of the ground.
    { key: PROP_KEYS.sword, at: from(-0.34, 0.38, 0.1), rotate: [5, turn, -8] },
    // Axe haft runs along local X — roll ~90° to stand it upright.
    { key: PROP_KEYS.axe, at: from(0.2, 0.66, 0.08), rotate: [4, turn, 86] },
    // Leaning against the frame, boss outward.
    { key: PROP_KEYS.shield, at: from(0.62, 0.33, 0.28), rotate: [-14, turn + 10, 0] },
  ];
}

/**
 * Asymmetric dressing for a used dueling court: clusters against a few wall
 * stretches and pillar bases, central floor left clear for the fight.
 *
 * Collider-aware: |x|,|z| well under 19; ≥1.5 from spawns at (0,±14)/(±14,0);
 * ≥1.4 from pillar centres at (±10,±10).
 */
export const ARENA_DRESSING: readonly WorldPlacement[] = [
  // --- SW: main weapon rack + sharpening station ---
  ...weaponRack([-15.2, 0, -15.8], 28),
  { key: SCENERY_KEYS.whetstone, at: [-13.4, 0, -14.6], turn: -12 },
  { key: SCENERY_KEYS.barrel, at: [-16.8, 0, -13.9] },
  { key: SCENERY_KEYS.sack, at: [-14.6, 0, -17.0], turn: 40 },
  { key: SCENERY_KEYS.rope, at: [-12.8, 0, -16.5], turn: 55 },

  // --- SE: supply clutter (uneven ones and twos) ---
  { key: SCENERY_KEYS.crate, at: [12.4, 0, -16.2], turn: -18 },
  { key: SCENERY_KEYS.barrel, at: [13.8, 0, -15.4] },
  { key: SCENERY_KEYS.chest, at: [15.1, 0, -16.8], turn: 12 },
  { key: SCENERY_KEYS.sack, at: [11.5, 0, -15.1], turn: -35 },
  { key: SCENERY_KEYS.farmCrate, at: [14.6, 0, -14.2], turn: 22 },

  // --- N wall stretch: training dummy + spare rack ---
  { key: SCENERY_KEYS.dummy, at: [7.2, 0, 16.6], turn: 195 },
  ...weaponRack([16.0, 0, 8.4], -78),
  { key: SCENERY_KEYS.pot, at: [14.8, 0, 6.2], turn: 15 },

  // --- NW: more supply, uneven against the wall ---
  { key: SCENERY_KEYS.crate, at: [-16.2, 0, 11.4], turn: 32 },
  { key: SCENERY_KEYS.barrel, at: [-17.0, 0, 9.8] },
  { key: SCENERY_KEYS.chest, at: [-15.0, 0, 13.1], turn: -25 },

  // --- Near SW pillar base: freestanding light fixture ---
  { key: SCENERY_KEYS.candelabra, at: [-11.9, 0, -12.4], turn: 8 },

  // --- Wall fixtures (elevated y; hang near the inner wall faces) ---
  { key: SCENERY_KEYS.torchSconce, at: [-7.5, 2.4, 18.3], turn: 180 },
  { key: SCENERY_KEYS.torchSconce, at: [4.8, 2.2, 18.3], turn: 180 },
  { key: SCENERY_KEYS.torchSconce, at: [18.3, 2.3, -6.0], turn: -90 },
  { key: SCENERY_KEYS.lanternSconce, at: [18.2, 1.95, 4.5], turn: -90 },
  { key: SCENERY_KEYS.lanternSconce, at: [-18.2, 2.05, -3.5], turn: 90 },
  { key: SCENERY_KEYS.pegRack, at: [-3.2, 1.55, 18.35], turn: 180 },
];
