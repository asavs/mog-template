import { describe, expect, it } from 'vitest';
import { shouldSuppressGameKeyDefault, spellForSelectHotkey } from './useInputManager';

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

describe('spellForSelectHotkey', () => {
  it('disables Digit1/Digit2 when no spells are granted', () => {
    expect(spellForSelectHotkey('Digit1', [])).toBeNull();
    expect(spellForSelectHotkey('Digit2', [])).toBeNull();
  });

  it('maps Digit1/Digit2 only for granted spells', () => {
    expect(spellForSelectHotkey('Digit1', ['fireball', 'lightning'])).toBe('fireball');
    expect(spellForSelectHotkey('Digit2', ['fireball', 'lightning'])).toBe('lightning');
  });

  it('gates each hotkey by membership, not a class-wide flag', () => {
    expect(spellForSelectHotkey('Digit1', ['lightning'])).toBeNull();
    expect(spellForSelectHotkey('Digit2', ['lightning'])).toBe('lightning');
    expect(spellForSelectHotkey('Digit1', ['fireball'])).toBe('fireball');
    expect(spellForSelectHotkey('Digit2', ['fireball'])).toBeNull();
  });

  it('ignores non-spell keys', () => {
    expect(spellForSelectHotkey('KeyW', ['fireball', 'lightning'])).toBeNull();
    expect(spellForSelectHotkey('Digit4', ['fireball'])).toBeNull();
  });
});
