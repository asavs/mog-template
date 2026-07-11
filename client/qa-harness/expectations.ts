import {
  GRAVITY,
  JUMP_FORCE,
  PLAYER_SPEED,
  SPRINT_MULTIPLIER,
} from '../src/locomotion.ts';

export const EXPECTED_WALK_SPEED = PLAYER_SPEED;
export const EXPECTED_SPRINT_MULTIPLIER = SPRINT_MULTIPLIER;
export const EXPECTED_SPRINT_SPEED = PLAYER_SPEED * SPRINT_MULTIPLIER;
export const EXPECTED_JUMP_AIRTIME_SECONDS = 2 * JUMP_FORCE / Math.abs(GRAVITY);

export type InvariantExpectations = {
  walkSpeed: number;
  sprintMultiplier: number;
  sprintSpeed: number;
};

export const DEFAULT_INVARIANT_EXPECTATIONS: InvariantExpectations = {
  walkSpeed: EXPECTED_WALK_SPEED,
  sprintMultiplier: EXPECTED_SPRINT_MULTIPLIER,
  sprintSpeed: EXPECTED_SPRINT_SPEED,
};
