import type { OverlayWidth } from './mask';

export type AnimationLayer = 'base' | 'upper' | 'full';
export type MotionLoop = 'repeat' | 'once';
export type InterruptionPolicy = 'always' | 'recovery' | 'never';

export type MotionRule = {
  layer: AnimationLayer;
  loop: MotionLoop;
  priority: number;
  interruption: InterruptionPolicy;
  enterBlendSeconds: number;
  exitBlendSeconds: number;
  clampWhenFinished: boolean;
  retrigger: boolean;
  /**
   * How much of the body an upper-layer motion claims. `torso` takes the lower
   * spine too, which reads better but fights a walk; `arms` leaves the spine to
   * locomotion. Ignored by base and full-body rules.
   */
  overlayWidth?: OverlayWidth;
};

/**
 * Layer policy is centralized here so motion selection remains data-driven.
 * The controller never changes playback rate to make authored clips fit these windows.
 */
export const MOTION_RULES = {
  locomotion: {
    layer: 'base',
    loop: 'repeat',
    priority: 0,
    interruption: 'always',
    enterBlendSeconds: 0.175,
    exitBlendSeconds: 0.175,
    clampWhenFinished: false,
    retrigger: false,
  },
  /**
   * A held pose that stands in for locomotion's upper body while a loadout is
   * equipped. Loops forever and is never "finished"; anything with an opinion
   * about the arms simply outranks it.
   */
  stance: {
    layer: 'base',
    loop: 'repeat',
    priority: 10,
    interruption: 'always',
    enterBlendSeconds: 0.2,
    exitBlendSeconds: 0.2,
    clampWhenFinished: false,
    retrigger: false,
    // No overlayWidth: each of a stance's poses names the bands it holds, since
    // a composed stance holds different bands with different clips.
  },
  ability: {
    layer: 'upper',
    loop: 'once',
    priority: 100,
    interruption: 'recovery',
    enterBlendSeconds: 0.08,
    exitBlendSeconds: 0.08,
    clampWhenFinished: true,
    retrigger: false,
    // Default for a rooted action. Callers that permit movement narrow it.
    overlayWidth: 'torso',
  },
  guardEnter: {
    layer: 'upper',
    loop: 'once',
    priority: 110,
    interruption: 'always',
    enterBlendSeconds: 0.08,
    exitBlendSeconds: 0.08,
    clampWhenFinished: true,
    retrigger: false,
    overlayWidth: 'arms',
  },
  guardHeld: {
    layer: 'upper',
    loop: 'repeat',
    priority: 110,
    interruption: 'always',
    enterBlendSeconds: 0.08,
    exitBlendSeconds: 0.08,
    clampWhenFinished: false,
    retrigger: false,
    overlayWidth: 'arms',
  },
  guardExit: {
    layer: 'upper',
    loop: 'once',
    priority: 110,
    interruption: 'always',
    enterBlendSeconds: 0.08,
    exitBlendSeconds: 0.08,
    clampWhenFinished: true,
    retrigger: false,
    overlayWidth: 'arms',
    expectedDurationSeconds: 0.25,
  },
  reactHit: {
    layer: 'upper',
    loop: 'once',
    priority: 200,
    interruption: 'always',
    enterBlendSeconds: 0.08,
    exitBlendSeconds: 0.08,
    clampWhenFinished: true,
    retrigger: true,
    overlayWidth: 'torso',
  },
  jump: {
    layer: 'full',
    loop: 'once',
    priority: 300,
    interruption: 'always',
    enterBlendSeconds: 0.08,
    exitBlendSeconds: 0.15,
    clampWhenFinished: true,
    retrigger: false,
  },
  land: {
    layer: 'full',
    loop: 'once',
    priority: 310,
    interruption: 'always',
    enterBlendSeconds: 0.08,
    exitBlendSeconds: 0.15,
    clampWhenFinished: true,
    retrigger: false,
  },
  fullBodyAbility: {
    layer: 'full',
    loop: 'once',
    priority: 400,
    interruption: 'recovery',
    enterBlendSeconds: 0.08,
    exitBlendSeconds: 0.15,
    clampWhenFinished: true,
    retrigger: false,
  },
  reactDeath: {
    layer: 'full',
    loop: 'once',
    priority: 1_000,
    interruption: 'never',
    enterBlendSeconds: 0.08,
    exitBlendSeconds: 0,
    clampWhenFinished: true,
    retrigger: false,
  },
} as const satisfies Record<string, MotionRule | (MotionRule & { expectedDurationSeconds: number })>;

export type MotionRuleName = keyof typeof MOTION_RULES;

export const DEFAULT_GUARD_MOTIONS = {
  enter: 'guard_enter',
  held: 'guard_held',
  exit: 'guard_exit',
} as const;

export const DEFAULT_REACTION_MOTIONS = {
  hit: 'react_hit',
  death: 'react_death',
} as const;
