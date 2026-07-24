import { describe, expect, it } from 'vitest';
import {
  canSelectSpell,
  CHARACTER_CONFIGS,
  getCharacterCapabilities,
  hasSpellSelectHotkeys,
  joinPresetButtonLabel,
  listLoadoutPresetIds,
  normalizeCharacterClass,
  resolvePlayerCapabilities,
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

  it('defaults unknown, null, and undefined values to default preset', () => {
    expect(normalizeCharacterClass('knight')).toBe('wizard');
    expect(normalizeCharacterClass('')).toBe('wizard');
    expect(normalizeCharacterClass(null)).toBe('wizard');
    expect(normalizeCharacterClass(undefined)).toBe('wizard');
  });

  it('preserves every catalog loadout preset id (no collapse to wizard/paladin only)', () => {
    for (const id of listLoadoutPresetIds()) {
      expect(normalizeCharacterClass(id)).toBe(id);
    }
  });
});

describe('catalog-driven character configs (QA matrix)', () => {
  it('includes every catalog preset with capabilities', () => {
    const ids = listLoadoutPresetIds();
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) {
      expect(CHARACTER_CONFIGS[id]?.capabilities).toBeDefined();
    }
  });

  it('joinPresetButtonLabel uses catalog labels', () => {
    expect(joinPresetButtonLabel('wizard')).toBe('Wizard');
    expect(joinPresetButtonLabel('paladin')).toBe('Paladin');
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

describe('resolvePlayerCapabilities (HUD / hotkey path)', () => {
  it('paladin class string with no cast grants → no spell hotkeys', () => {
    const caps = resolvePlayerCapabilities({
      legacyClass: 'paladin',
      appearance: { bodyId: 'body_m', scale: 1, loadoutPreset: 'paladin' },
      equipment: [
        { slot: 'main_hand', itemId: 'sword_1h' },
        { slot: 'off_hand', itemId: 'shield' },
        { slot: 'utility_potion', itemId: 'potion' },
      ],
    });
    expect(caps.melee).toBe(true);
    expect(caps.block).toBe(true);
    expect(caps.spells.length).toBe(0);
    expect(hasSpellSelectHotkeys(caps)).toBe(false);
    expect(canSelectSpell(caps, 'fireball')).toBe(false);
    expect(canSelectSpell(caps, 'lightning')).toBe(false);
  });

  it('wand equipment grants spells even when class string is paladin', () => {
    const caps = resolvePlayerCapabilities({
      legacyClass: 'paladin',
      appearance: { bodyId: 'body_m', scale: 1, loadoutPreset: 'paladin' },
      equipment: [
        { slot: 'main_hand', itemId: 'wand' },
        { slot: 'utility_potion', itemId: 'potion' },
      ],
    });
    // Grant-driven: wand cast_* abilities enable spell hotkeys regardless of class string.
    expect([...caps.spells]).toEqual(['fireball', 'lightning']);
    expect(hasSpellSelectHotkeys(caps)).toBe(true);
    expect(canSelectSpell(caps, 'fireball')).toBe(true);
    expect(canSelectSpell(caps, 'lightning')).toBe(true);
    // main_hand is wand, not sword — melee_slash is not granted from gear.
    expect(caps.melee).toBe(false);
  });

  it('wizard equipment-derived cast grants still enable spells', () => {
    const caps = resolvePlayerCapabilities({
      legacyClass: 'wizard',
      appearance: { bodyId: 'body_f', scale: 1, loadoutPreset: 'wizard' },
      equipment: [
        { slot: 'main_hand', itemId: 'wand' },
        { slot: 'utility_potion', itemId: 'potion' },
      ],
    });
    expect([...caps.spells]).toEqual(['fireball', 'lightning']);
    expect(hasSpellSelectHotkeys(caps)).toBe(true);
    expect(caps.melee).toBe(false);
  });

  it('falls back to preset capabilities when equipment rows are missing', () => {
    const paladinFallback = resolvePlayerCapabilities({ legacyClass: 'paladin' });
    expect(paladinFallback.spells.length).toBe(0);
    expect(paladinFallback.melee).toBe(true);

    const wizardFallback = resolvePlayerCapabilities({ legacyClass: 'wizard' });
    expect(wizardFallback.spells.length).toBe(2);
  });

  it('sword-only loadout does not enable spell select regardless of loadoutPreset label', () => {
    // Appearance still says wizard, but live gear is melee-only.
    const caps = resolvePlayerCapabilities({
      legacyClass: 'wizard',
      appearance: { bodyId: 'body_f', scale: 1, loadoutPreset: 'wizard' },
      equipment: [
        { slot: 'main_hand', itemId: 'sword_1h' },
        { slot: 'off_hand', itemId: 'shield' },
      ],
    });
    expect(caps.melee).toBe(true);
    expect(caps.block).toBe(true);
    expect(caps.spells.length).toBe(0);
    expect(hasSpellSelectHotkeys(caps)).toBe(false);
  });
});
