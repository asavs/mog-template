import { describe, expect, it } from 'vitest';
import type { InputState } from '../generated/types';
import {
  DEFAULT_LOCOMOTION_CONFIG,
  DELTA_TIME,
  JUMP_FORCE,
  settleLocomotionAfterMove,
  transitionLocomotion,
  type LocomotionContext,
  type LocomotionState,
} from './locomotion';

function input(fields: Partial<InputState> = {}): InputState {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    jump: false,
    sequence: 0,
    clientTick: 0,
    ...fields,
  };
}

function state(fields: Partial<LocomotionState> = {}): LocomotionState {
  return {
    phase: 'grounded_idle',
    horizontalVelocity: { x: 0, z: 0 },
    verticalVelocity: 0,
    sprintActive: false,
    wasJumpPressed: false,
    ...fields,
  };
}

function context(isGrounded: boolean): LocomotionContext {
  return {
    isGrounded,
    wasGrounded: isGrounded,
    rotationY: 0,
    deltaSeconds: DELTA_TIME,
  };
}

describe('locomotion FSM parity', () => {
  it('follows grounded idle, walk, and sprint input transitions', () => {
    const idle = transitionLocomotion(state(), input(), context(true));
    expect(idle.phase).toBe('grounded_idle');

    const walk = transitionLocomotion(
      idle,
      input({ forward: true }),
      context(true),
    );
    expect(walk.phase).toBe('grounded_walk');
    expect(walk.sprintActive).toBe(false);

    const sprint = transitionLocomotion(
      walk,
      input({ forward: true, sprint: true }),
      context(true),
    );
    expect(sprint.phase).toBe('grounded_sprint');
    expect(sprint.sprintActive).toBe(true);
  });

  it('enters airborne jump on a grounded jump edge', () => {
    const next = transitionLocomotion(
      state(),
      input({ jump: true }),
      context(true),
    );

    expect(next.phase).toBe('airborne_jump');
    expect(next.verticalVelocity).toBe(JUMP_FORCE);
    expect(next.wasJumpPressed).toBe(true);
  });

  it('becomes airborne fall at or after the apex', () => {
    const next = transitionLocomotion(
      state({ phase: 'airborne_jump', verticalVelocity: 0.01 }),
      input(),
      context(false),
    );

    expect(next.phase).toBe('airborne_fall');
    expect(next.verticalVelocity).toBeLessThanOrEqual(0);
  });

  it('enters airborne fall after walking off a ledge', () => {
    const next = transitionLocomotion(
      state(),
      input({ forward: true }),
      context(false),
    );

    expect(next.phase).toBe('airborne_fall');
  });

  it('maps landing to the grounded phase for current input', () => {
    const landed = settleLocomotionAfterMove(
      state({ phase: 'airborne_fall', verticalVelocity: -1 }),
      input({ forward: true }),
      true,
    );

    expect(landed.phase).toBe('grounded_walk');
  });

  it('activates held sprint on the landing tick', () => {
    const landed = settleLocomotionAfterMove(
      state({
        phase: 'airborne_fall',
        verticalVelocity: -1,
        sprintActive: false,
      }),
      input({ forward: true, sprint: true }),
      true,
    );

    expect(landed.sprintActive).toBe(true);
    expect(landed.phase).toBe('grounded_sprint');
  });

  it('deactivates released sprint on the landing tick', () => {
    const landed = settleLocomotionAfterMove(
      state({
        phase: 'airborne_fall',
        verticalVelocity: -1,
        sprintActive: true,
      }),
      input({ forward: true }),
      true,
    );

    expect(landed.sprintActive).toBe(false);
    expect(landed.phase).toBe('grounded_walk');
  });

  it('does not activate sprint from a midair press', () => {
    const pressedMidair = transitionLocomotion(
      state(),
      input({ forward: true, sprint: true }),
      context(false),
      DEFAULT_LOCOMOTION_CONFIG,
    );

    expect(pressedMidair.sprintActive).toBe(false);
  });

  it('preserves active sprint after a midair release until grounded', () => {
    const releasedMidair = transitionLocomotion(
      state({ sprintActive: true }),
      input({ forward: true }),
      context(false),
      DEFAULT_LOCOMOTION_CONFIG,
    );

    expect(releasedMidair.sprintActive).toBe(true);
  });
});
