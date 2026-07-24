/**
 * The content key vocabulary.
 *
 * Motion ids follow `docs/motion-vocabulary.md`: `<family>_<gesture>[_<qualifier>]`,
 * naming the GESTURE AND ITS MECHANICS — never a spell, class, or character.
 * `act_hurl_1h`, never `paladin_cast` or `fireball_anim`.
 *
 * The family names the LAYER the motion is played on, not the fiction it serves.
 * There is deliberately no `cast_` family: casting is a fiction a game system
 * imposes, and drawing a bow, priming a grenade, and channelling a spell are the
 * same problem for a skeleton. They are all `act_` — an action.
 *
 * Two consequences worth stating, because they are the point:
 *
 * - Ability -> motion is MANY-TO-ONE. Fireball and lightning both request
 *   `act_hurl_1h`; they differ in projectile, VFX, and timing data, not in
 *   skeleton motion.
 * - A gesture that was once a class signature becomes ordinary vocabulary. An
 *   overhead two-handed slam is `act_slam_2h`: any ability may request it
 *   deliberately, and none inherits it by accident from the body it runs on.
 *
 * A motion id is also the clip name inside a GLB, so shared libraries can hold
 * many named clips and loaders select by name.
 */

/** Continuous, looping ground movement. Selected by the locomotion layer. */
export const MOTION_LOCOMOTION = {
  idle: 'motion.loco_idle',
  walkForward: 'motion.loco_walk_f',
  walkBack: 'motion.loco_walk_b',
  walkLeft: 'motion.loco_walk_l',
  walkRight: 'motion.loco_walk_r',
  runForward: 'motion.loco_run_f',
  runBack: 'motion.loco_run_b',
  runLeft: 'motion.loco_run_l',
  runRight: 'motion.loco_run_r',
} as const;

/**
 * Airborne, split into three so hang time stretches with real physics instead
 * of one fixed-length clip guessing it.
 */
export const MOTION_AIR = {
  jump: 'motion.air_jump',
  fall: 'motion.air_fall',
  land: 'motion.air_land',
} as const;

/**
 * Voluntary gestures an ability performs. Any ability may bind to any of these.
 *
 * Named for the shape of the movement, so the same id serves a fireball, a
 * thrown axe, and a hurled net. The one-handed / two-handed qualifier is part of
 * the mechanics — it says what the other arm is doing, which is what makes a
 * gesture compatible or incompatible with a stance.
 */
export const MOTION_ACTION = {
  /** Overhand throw from the shoulder, one arm. Off-arm free. */
  hurl1h: 'motion.act_hurl_1h',
  /** Overhead raise and downward slam, both arms committed. */
  slam2h: 'motion.act_slam_2h',
  /** Lateral cut across the body, one arm. Off-arm free. */
  swing1h: 'motion.act_swing_1h',
  /** Braced defensive hold. Looping — held for as long as the input is held. */
  guardHold: 'motion.act_guard_hold',
  /** Raise to mouth and lower. */
  drink: 'motion.act_drink',
} as const;

/**
 * Held poses. A stance is what the upper body does when it is NOT doing
 * anything else: it replaces the idle/locomotion upper body for as long as the
 * loadout is equipped, so one pose covers idle, walk, and run alike rather than
 * multiplying every gait by every weapon.
 */
export const MOTION_STANCE = {
  staff: 'motion.stance_staff',
  swordShield: 'motion.stance_sword_shield',
} as const;

/** Involuntary responses to being acted upon. */
export const MOTION_REACTION = {
  hit: 'motion.react_hit',
  death: 'motion.react_death',
} as const;

export const MOTION_KEYS = {
  ...MOTION_LOCOMOTION,
  ...MOTION_AIR,
  ...MOTION_ACTION,
  ...MOTION_STANCE,
  ...MOTION_REACTION,
} as const;

/** Bodies are skeleton + skin. No class identity lives here. */
export const BODY_KEYS = {
  humanoid: 'body.humanoid',
} as const;

/** Held/attached props. Placeholder geometry today, real meshes later. */
export const PROP_KEYS = {
  staff: 'prop.staff',
  sword: 'prop.sword',
  shield: 'prop.shield',
  potion: 'prop.potion',
} as const;

export type MotionKey = (typeof MOTION_KEYS)[keyof typeof MOTION_KEYS];
export type BodyKey = (typeof BODY_KEYS)[keyof typeof BODY_KEYS];
export type PropKey = (typeof PROP_KEYS)[keyof typeof PROP_KEYS];

export const ALL_MOTION_KEYS: readonly MotionKey[] = Object.values(MOTION_KEYS);
export const ALL_PROP_KEYS: readonly PropKey[] = Object.values(PROP_KEYS);

/**
 * The motion id a key carries, i.e. the clip name to look for inside an asset.
 * `motion.act_hurl_1h` -> `act_hurl_1h`.
 */
export function motionIdFromKey(key: string): string {
  return key.replace(/^motion\./, '');
}
