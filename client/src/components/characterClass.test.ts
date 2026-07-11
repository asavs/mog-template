import { describe, expect, it } from 'vitest';
import {
  getCharacterCapabilities,
  normalizeCharacterClass,
} from './characterConfig';

describe('normalizeCharacterClass legacy remapping', () => {
  it('maps legacy paladin identifiers to paladin', () => {
    expect(normalizeCharacterClass('paladin')).toBe('paladin');
    expect(normalizeCharacterClass('pally')).toBe('paladin');
  });

  it('maps legacy wizard identifiers to wizard', () => {
    expect(normalizeCharacterClass('wizard2')).toBe('wizard');
    expect(normalizeCharacterClass('wizard')).toBe('wizard');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(normalizeCharacterClass('  PALADIN ')).toBe('paladin');
    expect(normalizeCharacterClass('Wizard2')).toBe('wizard');
  });

  it('defaults unknown, null, and undefined values to wizard', () => {
    expect(normalizeCharacterClass('knight')).toBe('wizard');
    expect(normalizeCharacterClass('')).toBe('wizard');
    expect(normalizeCharacterClass(null)).toBe('wizard');
    expect(normalizeCharacterClass(undefined)).toBe('wizard');
  });
});

describe('class capabilities', () => {
  it('gives paladin melee + block + potion but no spells', () => {
    const paladin = getCharacterCapabilities('paladin');
    expect(paladin.melee).toBe(true);
    expect(paladin.block).toBe(true);
    expect(paladin.drinkPotion).toBe(true);
    expect(paladin.spells.length).toBe(0);
  });

  it('gives wizard both spells + potion but no melee/block', () => {
    const wizard = getCharacterCapabilities('wizard');
    expect(wizard.melee).toBe(false);
    expect(wizard.block).toBe(false);
    expect(wizard.drinkPotion).toBe(true);
    expect([...wizard.spells]).toEqual(['fireball', 'lightning']);
  });

  it('lets both classes drink potions', () => {
    expect(getCharacterCapabilities('paladin').drinkPotion).toBe(true);
    expect(getCharacterCapabilities('wizard').drinkPotion).toBe(true);
  });

  it('resolves legacy stored classes through the same table', () => {
    expect(getCharacterCapabilities('paladin').melee).toBe(true);
    expect(getCharacterCapabilities('wizard2').spells.length).toBe(2);
  });
});
