import { describe, expect, it } from 'vitest';
import {
  createIntentState,
  handleKeyDown,
  handleKeyUp,
  handleMouseDown,
  handleMouseUp,
  holdTicksFor,
  isEditableTarget,
  setPointerLocked,
  type IntentState,
} from './intents';

function locked(state: IntentState = createIntentState()): IntentState {
  return setPointerLocked(state, true).state;
}

describe('pointer-lock gating', () => {
  it('suppresses movement and slot edges while unlocked', () => {
    const state = createIntentState();
    const down = handleKeyDown(state, { code: 'KeyW' }, null, 0);
    expect(down.movement).toBeUndefined();
    expect(down.edges).toEqual([]);
    expect(down.state.movement.forward).toBe(false);

    const mouseDown = handleMouseDown(down.state, { button: 0 }, 0);
    expect(mouseDown.edges).toEqual([]);
  });

  it('still tracks physical key-down state while unlocked, so an eventual up is a no-op edge too', () => {
    const state = createIntentState();
    const down = handleKeyDown(state, { code: 'KeyW' }, null, 0);
    expect(down.state.downCodes.has('KeyW')).toBe(true);
    const up = handleKeyUp(down.state, { code: 'KeyW' }, null);
    expect(up.movement).toBeUndefined();
    expect(up.edges).toEqual([]);
  });

  it('allows movement and edges once locked', () => {
    const state = locked();
    const down = handleKeyDown(state, { code: 'KeyW' }, null, 0);
    expect(down.movement).toEqual({ forward: true, backward: false, left: false, right: false, jump: false });

    const primary = handleMouseDown(down.state, { button: 0 }, 0);
    expect(primary.edges).toEqual([{ slot: 'primary', edge: 'Press' }]);
  });

  it('releases held slots and clears movement when lock is lost', () => {
    let state = locked();
    state = handleKeyDown(state, { code: 'KeyW' }, null, 0).state;
    state = handleMouseDown(state, { button: 0 }, 5).state;
    expect(state.movement.forward).toBe(true);

    const result = setPointerLocked(state, false);
    expect(result.edges).toEqual([{ slot: 'primary', edge: 'Release' }]);
    expect(result.movement).toEqual({ forward: false, backward: false, left: false, right: false, jump: false });
    expect(result.state.heldSlotSince.size).toBe(0);
  });
});

describe('editable-target suppression', () => {
  it('ignores keydown when the event target is an input, regardless of lock state', () => {
    const down = handleKeyDown(locked(), { code: 'KeyW' }, { tagName: 'INPUT' }, 0);
    expect(down.movement).toBeUndefined();
    expect(down.state.downCodes.size).toBe(0);
  });

  it('ignores contenteditable targets', () => {
    expect(isEditableTarget({ isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true);
    expect(isEditableTarget({ tagName: 'div' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('edge de-duplication', () => {
  it('emits exactly one Press per physical key-down, ignoring browser auto-repeat', () => {
    let state = locked();
    const first = handleKeyDown(state, { code: 'KeyR' }, null, 0);
    state = first.state;
    expect(first.edges).toEqual([{ slot: 'potion', edge: 'Press' }]);

    const repeat = handleKeyDown(state, { code: 'KeyR', repeat: true }, null, 1);
    expect(repeat.edges).toEqual([]);

    const heldAgain = handleKeyDown(state, { code: 'KeyR' }, null, 2);
    expect(heldAgain.edges).toEqual([]);
  });

  it('emits exactly one Release per physical key-up', () => {
    let state = locked();
    state = handleKeyDown(state, { code: 'KeyR' }, null, 0).state;
    const up = handleKeyUp(state, { code: 'KeyR' }, null);
    expect(up.edges).toEqual([{ slot: 'potion', edge: 'Release' }]);

    const upAgain = handleKeyUp(up.state, { code: 'KeyR' }, null);
    expect(upAgain.edges).toEqual([]);
  });

  it('mouse buttons dedupe the same way', () => {
    let state = locked();
    const down = handleMouseDown(state, { button: 2 }, 0);
    state = down.state;
    expect(down.edges).toEqual([{ slot: 'block', edge: 'Press' }]);
    expect(handleMouseDown(state, { button: 2 }, 1).edges).toEqual([]);

    const up = handleMouseUp(state, { button: 2 });
    expect(up.edges).toEqual([{ slot: 'block', edge: 'Release' }]);
    expect(handleMouseUp(up.state, { button: 2 }).edges).toEqual([]);
  });
});

describe('movement vector', () => {
  it('combines simultaneous axes', () => {
    let state = locked();
    state = handleKeyDown(state, { code: 'KeyW' }, null, 0).state;
    state = handleKeyDown(state, { code: 'KeyD' }, null, 0).state;
    expect(state.movement).toEqual({ forward: true, backward: false, left: false, right: true, jump: false });

    state = handleKeyUp(state, { code: 'KeyW' }, null).state;
    expect(state.movement.forward).toBe(false);
    expect(state.movement.right).toBe(true);
  });

  it('tracks jump independently of movement axes', () => {
    let state = locked();
    const result = handleKeyDown(state, { code: 'Space' }, null, 0);
    expect(result.movement?.jump).toBe(true);
    state = handleKeyUp(result.state, { code: 'Space' }, null).state;
    expect(state.movement.jump).toBe(false);
  });
});

describe('holdTicksFor — client-side mirror only, never gates sending', () => {
  it('is zero for a slot that is not held', () => {
    expect(holdTicksFor(createIntentState(), 'primary', 10)).toBe(0);
  });

  it('counts ticks since the Press edge', () => {
    let state = locked();
    state = handleMouseDown(state, { button: 0 }, 4).state;
    expect(holdTicksFor(state, 'primary', 4)).toBe(0);
    expect(holdTicksFor(state, 'primary', 10)).toBe(6);
  });

  it('resets to zero once released', () => {
    let state = locked();
    state = handleMouseDown(state, { button: 0 }, 4).state;
    state = handleMouseUp(state, { button: 0 }).state;
    expect(holdTicksFor(state, 'primary', 10)).toBe(0);
  });
});
