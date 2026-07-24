import { describe, expect, it } from 'vitest';
import { ITEM_IDS, LOADOUT_PRESET_IDS } from '../avatar/loadoutAuthority.generated';
import {
  canSelectSpell,
  formatCatalogIdLabel,
  getCharacterCapabilities,
  hasSpellSelectHotkeys,
  listEquippableCatalogItems,
  listLoadoutPresetIds,
  listLoadoutPresetsForSelect,
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

  it('maps acolyte identifiers to acolyte (not wizard)', () => {
    expect(normalizeCharacterClass('acolyte')).toBe('acolyte');
    expect(normalizeCharacterClass('Acolyte')).toBe('acolyte');
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

  it('accepts every generated loadout preset id directly', () => {
    for (const presetId of LOADOUT_PRESET_IDS) {
      expect(normalizeCharacterClass(presetId)).toBe(presetId);
    }
  });
});

describe('catalog-driven join presets (#56)', () => {
  it('lists one select option per catalog preset with labels', () => {
    const options = listLoadoutPresetsForSelect();
    const ids = listLoadoutPresetIds();
    expect(options.map(o => o.id).sort()).toEqual([...ids].sort());
    expect(options.length).toBeGreaterThanOrEqual(2);
    for (const option of options) {
      expect(option.label.trim().length).toBeGreaterThan(0);
    }
    // Known presets today; new presets (acolyte) appear without UI hardcoding.
    expect(ids).toContain('wizard');
    expect(ids).toContain('paladin');
  });
});

describe('catalog-driven equippable items (#52)', () => {
  it('lists all authority item ids for equip UI', () => {
    const items = listEquippableCatalogItems();
    expect(items.map(i => i.itemId).sort()).toEqual([...ITEM_IDS].sort());
    expect(items.length).toBeGreaterThanOrEqual(1);
    for (const item of items) {
      expect(item.slot.length).toBeGreaterThan(0);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.group === 'equipment' || item.group === 'utility').toBe(true);
    }
  });

  it('groups utility potion separately from paper-doll gear when present', () => {
    const items = listEquippableCatalogItems();
    const potion = items.find(i => i.itemId === 'potion');
    if (potion) {
      expect(potion.group).toBe('utility');
      expect(potion.slot).toBe('utility_potion');
    }
    const mainHand = items.filter(i => i.slot === 'main_hand');
    expect(mainHand.every(i => i.group === 'equipment')).toBe(true);
  });

  it('formats catalog ids for display', () => {
    expect(formatCatalogIdLabel('sword_1h')).toBe('Sword 1h');
    expect(formatCatalogIdLabel('main_hand')).toBe('Main Hand');
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

  it('gives acolyte the same cast/potion caps as wizard', () => {
    const acolyte = getCharacterCapabilities('acolyte');
    expect(acolyte.melee).toBe(false);
    expect(acolyte.block).toBe(false);
    expect(acolyte.drinkPotion).toBe(true);
    expect([...acolyte.spells]).toEqual(['fireball', 'lightning']);
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
  it('paladin class string with no cast grants ΓåÆ no spell hotkeys', () => {
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
    // main_hand is wand, not sword ΓÇö melee_slash is not granted from gear.
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

