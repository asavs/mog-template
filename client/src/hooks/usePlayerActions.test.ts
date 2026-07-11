import { describe, expect, it } from 'vitest';
import type { InputState } from '../generated/types';
import { prepareClientTickForSend } from './usePlayerActions';

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
