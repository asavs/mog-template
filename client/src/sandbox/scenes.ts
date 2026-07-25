/**
 * Places to stand while judging an animation.
 *
 * An empty grid is a bad test. A chopping loop swung at nothing looks fine and
 * reads completely differently next to a log; a sitting clip is unjudgeable
 * without something at the right height to sit on; a torch idle needs a room
 * dark enough to want one. Half of "does this animation work" is "does it work
 * HERE", and an empty scene quietly answers a different question.
 *
 * So each set is arranged around a kind of clip rather than around a fantasy.
 * The forge is where you judge chopping and kneeling and hammering; the tavern
 * is where you judge sitting, drinking and talking; the yard is where you judge
 * everything with a weapon in hand.
 *
 * Positions are world units with the body at the origin facing +Z. Scenery is
 * authored origin-at-base by the kit, so y is the floor unless something is
 * meant to sit on top of something else.
 */

import { PROP_KEYS, SCENERY_KEYS } from '../content';

export type Placement = {
  /** Content key — scenery or a held prop being used as set dressing. */
  key: string;
  at: readonly [number, number, number];
  /** Yaw in degrees. */
  turn?: number;
  scale?: number;
};

export type Scene = {
  id: string;
  label: string;
  /** What this set is for judging. */
  note: string;
  /** A backdrop, so wall fittings have something to hang on. */
  wall: boolean;
  place: readonly Placement[];
};

const WALL_Z = -2.6;

export const SCENES: readonly Scene[] = [
  {
    id: 'none',
    label: 'empty grid',
    note: 'Nothing but the body. Best for reading a silhouette.',
    wall: false,
    place: [],
  },

  {
    id: 'yard',
    label: 'training yard',
    note: 'Sword, shield, axe and unarmed work. The dummy gives a swing something to be aimed at.',
    wall: true,
    place: [
      // Far enough out that a swing has somewhere to travel; a target you are
      // already standing inside tells you nothing about reach.
      { key: SCENERY_KEYS.dummy, at: [2.3, 0, 1.7], turn: 205 },
      { key: SCENERY_KEYS.weaponStand, at: [-1.9, 0, -0.7], turn: 15 },
      { key: SCENERY_KEYS.crate, at: [2.6, 0, -1.4], turn: -20 },
      { key: SCENERY_KEYS.barrel, at: [-2.9, 0, 0.4] },
      { key: SCENERY_KEYS.rope, at: [2.1, 0, -0.1], turn: 40 },
      { key: SCENERY_KEYS.sack, at: [-2.4, 0, -1.6], turn: -35 },
      { key: SCENERY_KEYS.pegRack, at: [-0.9, 1.55, WALL_Z + 0.06] },
      { key: SCENERY_KEYS.torchSconce, at: [1.7, 1.5, WALL_Z + 0.06] },
    ],
  },

  {
    id: 'tavern',
    label: 'tavern corner',
    note: 'Sitting, drinking, talking and the emotes. Stools are the right height to test a sit against.',
    wall: true,
    place: [
      // A stool UNDER the body, not beside it. The sitting clips put the hips
      // around 0.5 and a stool is 0.59 tall, so this is the one placement that
      // makes a sit judgeable — everywhere else and the character sits on air,
      // which is exactly what the first version of this scene did.
      { key: SCENERY_KEYS.stool, at: [0, 0, -0.06] },
      { key: SCENERY_KEYS.table, at: [0.15, 0, -1.55], turn: 0 },
      { key: SCENERY_KEYS.bench, at: [0.15, 0, -2.3] },
      { key: SCENERY_KEYS.stool, at: [-1.5, 0, -0.55], turn: 25 },
      { key: SCENERY_KEYS.barrel, at: [-2.7, 0, -1.7] },
      { key: SCENERY_KEYS.pot, at: [-2.7, 0.9, -1.7] },
      { key: SCENERY_KEYS.candelabra, at: [0.75, 0.82, -1.5] },
      { key: PROP_KEYS.mug, at: [-0.3, 0.82, -1.35], turn: 30 },
      { key: PROP_KEYS.mug, at: [-0.05, 0.82, -1.7], turn: -60 },
      { key: SCENERY_KEYS.lanternSconce, at: [-1.6, 1.7, WALL_Z + 0.06] },
      { key: SCENERY_KEYS.torchSconce, at: [1.9, 1.5, WALL_Z + 0.06] },
    ],
  },

  {
    id: 'forge',
    label: 'forge',
    note: 'Chopping, kneeling repairs and carrying. The anvil and workbench put those clips at a believable height.',
    wall: true,
    place: [
      { key: SCENERY_KEYS.anvilLog, at: [1.3, 0, -0.7], turn: -25 },
      { key: SCENERY_KEYS.workbench, at: [-1.7, 0, -1.6], turn: 8 },
      { key: SCENERY_KEYS.whetstone, at: [2.6, 0, 0.6], turn: -55 },
      { key: SCENERY_KEYS.barrel, at: [-3.0, 0, -0.2] },
      { key: SCENERY_KEYS.crate, at: [2.5, 0, -1.8], turn: 15 },
      { key: SCENERY_KEYS.chest, at: [-3.1, 0, -1.9], turn: 22 },
      { key: SCENERY_KEYS.cauldron, at: [3.0, 0, -1.0], turn: 30 },
      { key: SCENERY_KEYS.torchSconce, at: [-0.2, 1.5, WALL_Z + 0.06] },
      { key: SCENERY_KEYS.torchSconce, at: [2.2, 1.5, WALL_Z + 0.06] },
    ],
  },

  {
    id: 'study',
    label: "alchemist's study",
    note: 'Spell and consume clips, and anything that wants a reason to be indoors.',
    wall: true,
    place: [
      { key: SCENERY_KEYS.cauldron, at: [0.9, 0, -1.3], turn: 20 },
      { key: SCENERY_KEYS.bookcase, at: [-2.3, 0, -2.2], turn: 12 },
      { key: SCENERY_KEYS.table, at: [1.9, 0, -2.1], turn: -8, scale: 0.7 },
      { key: SCENERY_KEYS.chest, at: [-1.0, 0, -0.9], turn: -40 },
      { key: SCENERY_KEYS.pot, at: [2.0, 0.82, -2.1] },
      { key: SCENERY_KEYS.candle, at: [1.5, 0.82, -2.0] },
      { key: PROP_KEYS.potion, at: [2.3, 0.82, -2.2], turn: 10 },
      { key: SCENERY_KEYS.candelabra, at: [-1.5, 0, 0.9], turn: -15 },
      { key: SCENERY_KEYS.lanternSconce, at: [0.6, 1.7, WALL_Z + 0.06] },
    ],
  },
];

export const DEFAULT_SCENE = SCENES[0];

export function sceneById(id: string): Scene {
  return SCENES.find(scene => scene.id === id) ?? DEFAULT_SCENE;
}

export { WALL_Z };
