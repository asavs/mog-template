import { describe, expect, it } from 'vitest';
import { shouldSuppressGameKeyDefault } from './useInputManager';

function keyboardEvent(code: string, target?: object): KeyboardEvent {
  return { code, target: target ?? null } as KeyboardEvent;
}

describe('shouldSuppressGameKeyDefault', () => {
  it('suppresses Space while controls are captured so jump does not scroll the page', () => {
    expect(shouldSuppressGameKeyDefault(keyboardEvent('Space'), true)).toBe(true);
  });

  it('does not suppress Space after controls are released', () => {
    expect(shouldSuppressGameKeyDefault(keyboardEvent('Space'), false)).toBe(false);
  });

  it('suppresses movement and hotbar game keys while controls are captured', () => {
    expect(shouldSuppressGameKeyDefault(keyboardEvent('KeyW'), true)).toBe(true);
    expect(shouldSuppressGameKeyDefault(keyboardEvent('KeyA'), true)).toBe(true);
    expect(shouldSuppressGameKeyDefault(keyboardEvent('Digit1'), true)).toBe(true);
  });

  it('does not suppress typing in editable fields', () => {
    expect(shouldSuppressGameKeyDefault(keyboardEvent('Space', { tagName: 'INPUT' }), true)).toBe(false);
    expect(shouldSuppressGameKeyDefault(keyboardEvent('KeyW', { tagName: 'TEXTAREA' }), true)).toBe(false);
    expect(shouldSuppressGameKeyDefault(keyboardEvent('Digit1', { isContentEditable: true }), true)).toBe(false);
  });

  it('does not suppress unrelated browser keys', () => {
    expect(shouldSuppressGameKeyDefault(keyboardEvent('ArrowDown'), true)).toBe(false);
  });
});
