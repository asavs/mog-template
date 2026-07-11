import { describe, expect, it } from 'vitest';
import type { InputState } from './generated/types';
import {
  DEFAULT_LOCOMOTION_CONFIG,
  JUMP_FORCE,
  type LocomotionState,
  settleLocomotionAfterMove,
  transitionLocomotion,
} from './locomotion';

function defaultInput(fields: Partial<InputState> = {}): InputState {
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

function baseState(fields: Partial<LocomotionState> = {}): LocomotionState {
  return {
    phase: 'grounded_idle',
    horizontalVelocity: { x: 0, z: 0 },
    verticalVelocity: 0,
    sprintActive: false,
    wasJumpPressed: false,
    ...fields,
  };
}

function context(isGrounded: boolean) {
  return {
    isGrounded,
    wasGrounded: isGrounded,
    rotationY: 0,
    deltaSeconds: 1 / 20,
  };
}

describe('locomotion transition', () => {
  it('transitions grounded idle, walk, and sprint from input', () => {
    const idle = transitionLocomotion(baseState(), defaultInput(), context(true));
    expect(idle.phase).toBe('grounded_idle');

    const walk = transitionLocomotion(idle, defaultInput({ forward: true }), context(true));
    expect(walk.phase).toBe('grounded_walk');
    expect(walk.sprintActive).toBe(false);

    const sprint = transitionLocomotion(walk, defaultInput({ forward: true, sprint: true }), context(true));
    expect(sprint.phase).toBe('grounded_sprint');
    expect(sprint.sprintActive).toBe(true);
  });

  it('enters airborne jump on a grounded jump edge', () => {
    const next = transitionLocomotion(baseState(), defaultInput({ jump: true }), context(true));

    expect(next.phase).toBe('airborne_jump');
    expect(next.verticalVelocity).toBe(JUMP_FORCE);
    expect(next.wasJumpPressed).toBe(true);
  });

  it('turns airborne jump into fall at the apex', () => {
    const next = transitionLocomotion(
      baseState({ phase: 'airborne_jump', verticalVelocity: 0.01 }),
      defaultInput(),
      context(false),
    );

    expect(next.phase).toBe('airborne_fall');
    expect(next.verticalVelocity).toBeLessThanOrEqual(0);
  });

  it('enters airborne fall when walking off a ledge', () => {
    const next = transitionLocomotion(baseState(), defaultInput({ forward: true }), context(false));

    expect(next.phase).toBe('airborne_fall');
  });

  it('lands into the grounded state implied by current input', () => {
    const landed = settleLocomotionAfterMove(
      baseState({ phase: 'airborne_fall', verticalVelocity: -1 }),
      defaultInput({ forward: true }),
      true,
    );

    expect(landed.phase).toBe('grounded_walk');
  });

  it('activates sprint on the landing tick when sprint is held', () => {
    const landed = settleLocomotionAfterMove(
      baseState({ phase: 'airborne_fall', verticalVelocity: -1, sprintActive: false }),
      defaultInput({ forward: true, sprint: true }),
      true,
    );

    expect(landed.sprintActive).toBe(true);
    expect(landed.phase).toBe('grounded_sprint');
  });

  it('deactivates carried sprint on the landing tick when sprint is released', () => {
    const landed = settleLocomotionAfterMove(
      baseState({ phase: 'airborne_fall', verticalVelocity: -1, sprintActive: true }),
      defaultInput({ forward: true }),
      true,
    );

    expect(landed.sprintActive).toBe(false);
    expect(landed.phase).toBe('grounded_walk');
  });

  it('preserves existing midair sprint rules', () => {
    const pressedMidair = transitionLocomotion(
      baseState(),
      defaultInput({ forward: true, sprint: true }),
      context(false),
      DEFAULT_LOCOMOTION_CONFIG,
    );
    expect(pressedMidair.sprintActive).toBe(false);

    const releasedMidair = transitionLocomotion(
      baseState({ sprintActive: true }),
      defaultInput({ forward: true, sprint: false }),
      context(false),
      DEFAULT_LOCOMOTION_CONFIG,
    );
    expect(releasedMidair.sprintActive).toBe(true);
  });
});
