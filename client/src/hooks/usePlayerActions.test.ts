import { describe, expect, it } from 'vitest';
import type { InputState } from '../generated/types';
import {
  inputNeedsForceResend,
  prepareClientTickForSend,
  shouldSendPlayerInput,
} from './usePlayerActions';

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

describe('shouldSendPlayerInput', () => {
  it('sends when input changed even if fully idle', () => {
    expect(shouldSendPlayerInput({
      force: false,
      input: input(),
      inputChanged: true,
    })).toBe(true);
  });

  it('does not force-send pure idle inputs', () => {
    expect(shouldSendPlayerInput({
      force: true,
      input: input(),
      inputChanged: false,
    })).toBe(false);
  });

  it('force-sends while movement keys are held', () => {
    expect(shouldSendPlayerInput({
      force: true,
      input: input({ forward: true }),
      inputChanged: false,
    })).toBe(true);
  });

  it('force-sends while jump is held', () => {
    expect(shouldSendPlayerInput({
      force: true,
      input: input({ jump: true }),
      inputChanged: false,
    })).toBe(true);
  });

  it('does not send when neither forced nor changed', () => {
    expect(shouldSendPlayerInput({
      force: false,
      input: input({ forward: true }),
      inputChanged: false,
    })).toBe(false);
  });
});

describe('inputNeedsForceResend', () => {
  it('is false for a fully idle input state', () => {
    expect(inputNeedsForceResend(input())).toBe(false);
  });

  it('is true for any movement or jump bit', () => {
    expect(inputNeedsForceResend(input({ left: true }))).toBe(true);
    expect(inputNeedsForceResend(input({ jump: true }))).toBe(true);
    expect(inputNeedsForceResend(input({ sprint: true }))).toBe(true);
  });
});

describe('prepareClientTickForSend', () => {
  it('lets an immediate keydown claim the next unsent client tick', () => {
    const current = input({ left: true, clientTick: 100 });

    const shouldSend = prepareClientTickForSend({
      acknowledgedClientTick: 90,
      input: current,
      inputChanged: true,
      lastSentClientTick: 100,
    });

    expect(shouldSend).toBe(true);
    expect(current.clientTick).toBe(101);
  });

  it('lets an immediate keyup claim the next unsent client tick', () => {
    const current = input({ left: false, clientTick: 100 });

    const shouldSend = prepareClientTickForSend({
      acknowledgedClientTick: 90,
      input: current,
      inputChanged: true,
      lastSentClientTick: 100,
    });

    expect(shouldSend).toBe(true);
    expect(current.clientTick).toBe(101);
  });

  it('does not send a forced duplicate old client tick', () => {
    const current = input({ forward: true, clientTick: 100 });

    expect(prepareClientTickForSend({
      acknowledgedClientTick: 90,
      input: current,
      inputChanged: false,
      lastSentClientTick: 100,
    })).toBe(false);
    expect(current.clientTick).toBe(100);
  });

  it('does not send a forced acknowledged client tick', () => {
    const current = input({ forward: true, clientTick: 100 });

    expect(prepareClientTickForSend({
      acknowledgedClientTick: 100,
      input: current,
      inputChanged: false,
      lastSentClientTick: 99,
    })).toBe(false);
  });

  it('does not lock input after prediction resets behind the previous sent tick', () => {
    const current = input({ right: true, clientTick: 101 });

    const shouldSend = prepareClientTickForSend({
      acknowledgedClientTick: 100,
      input: current,
      inputChanged: true,
      lastSentClientTick: 150,
    });

    expect(shouldSend).toBe(true);
    expect(current.clientTick).toBe(151);
  });

  it('allows the next forced send after prediction catches up from an immediate input send', () => {
    const current = input({ left: true, clientTick: 100 });

    expect(prepareClientTickForSend({
      acknowledgedClientTick: 90,
      input: current,
      inputChanged: true,
      lastSentClientTick: 100,
    })).toBe(true);
    expect(current.clientTick).toBe(101);

    expect(prepareClientTickForSend({
      acknowledgedClientTick: 90,
      input: current,
      inputChanged: false,
      lastSentClientTick: 101,
    })).toBe(false);

    current.clientTick = 102;
    expect(prepareClientTickForSend({
      acknowledgedClientTick: 90,
      input: current,
      inputChanged: false,
      lastSentClientTick: 101,
    })).toBe(true);
  });
});
