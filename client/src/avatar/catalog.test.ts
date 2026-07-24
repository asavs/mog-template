import { describe, expect, it } from 'vitest';
import {
  appearanceBodyClipsKey,
  appearanceEquipmentKey,
  appearanceFromPreset,
  assetUrlsForAppearance,
  BASELINE_ABILITY_GRANTS,
  capabilitiesFromGrants,
  createAvatarCatalog,
  defaultAvatarCatalog,
  presentationAssemblyKey,
  presetIdFromLegacyClass,
  resolveFromServerState,
  resolvePreset,
} from './catalog';

describe('avatar catalog', () => {
  it('maps legacy class strings to presets', () => {
    expect(presetIdFromLegacyClass('paladin')).toBe('paladin');
    expect(presetIdFromLegacyClass('Pally')).toBe('paladin');
    expect(presetIdFromLegacyClass('wizard2')).toBe('wizard');
    expect(presetIdFromLegacyClass('acolyte')).toBe('acolyte');
    expect(presetIdFromLegacyClass(undefined)).toBe('wizard');
  });

  it('resolves paladin preset with sword/shield/potion grants', () => {
    const resolved = resolvePreset('paladin');
    expect(resolved.body.id).toBe('body_m');
    expect(resolved.equipped.map(item => item.id).sort()).toEqual(['potion', 'shield', 'sword_1h']);
    expect(resolved.capabilities.melee).toBe(true);
    expect(resolved.capabilities.block).toBe(true);
    expect(resolved.capabilities.spells).toEqual([]);
    expect(resolved.capabilities.drinkPotion).toBe(true);
    expect(resolved.clips.some(clip => clip.actionKey === 'slash')).toBe(true);
    expect(resolved.equipped.every(item => item.url.length > 0)).toBe(true);
  });

  it('resolves wizard preset with cast grants', () => {
    const resolved = resolvePreset('wizard');
    expect(resolved.body.id).toBe('body_f');
    expect(resolved.equipped.map(item => item.id).sort()).toEqual(['potion', 'wand']);
    expect(resolved.capabilities.melee).toBe(false);
    expect(resolved.capabilities.block).toBe(false);
    expect([...resolved.capabilities.spells]).toEqual(['fireball', 'lightning']);
    expect(resolved.clips.some(clip => clip.actionKey === 'cast' && clip.upperBodyOnly)).toBe(true);
    // Wand is a real weapons-pack mesh (not grantsOnly).
    const wand = resolved.equipped.find(item => item.id === 'wand');
    expect(wand?.grantsOnly).toBeFalsy();
    expect(wand?.meshKey).toContain('low_poly_weapons_pack');
  });

  it('resolves acolyte preset with wand and potion', () => {
    const resolved = resolvePreset('acolyte');
    expect(resolved.body.id).toBe('body_f');
    expect(resolved.equipped.map(item => item.id).sort()).toEqual(['potion', 'wand']);
    expect([...resolved.capabilities.spells]).toEqual(['fireball', 'lightning']);
    expect(resolved.capabilities.drinkPotion).toBe(true);
    expect(resolved.clips.some(clip => clip.actionKey === 'cast')).toBe(true);
  });

  it('rejects item in the wrong slot', () => {
    const appearance = appearanceFromPreset('wizard');
    appearance.slots.chest = 'sword_1h';
    expect(() => defaultAvatarCatalog.resolve(appearance)).toThrow(/belongs in slot/);
  });

  it('lists asset urls without requiring every class pack', () => {
    const wizardUrls = assetUrlsForAppearance(resolvePreset('wizard'));
    const paladinUrls = assetUrlsForAppearance(resolvePreset('paladin'));
    expect(wizardUrls.some(url => url.includes('wizard2'))).toBe(true);
    expect(paladinUrls.some(url => url.includes('paladin'))).toBe(true);
    // Wizard preload must not pull the paladin mesh pack.
    expect(wizardUrls.some(url => url.includes('/paladin/'))).toBe(false);
  });

  it('allows test catalogs without touching public assets paths', () => {
    const catalog = createAvatarCatalog({
      urlForMeshKey: key => `test://${key}`,
    });
    const resolved = resolvePreset('wizard', catalog);
    expect(resolved.body.url).toBe('test://models/wizard2/wizard2.fbx');
  });

  it('prefers server appearance/equipment over legacy class alone', () => {
    const resolved = resolveFromServerState({
      appearance: { bodyId: 'body_m', scale: 1, loadoutPreset: 'paladin' },
      equipment: [
        { slot: 'main_hand', itemId: 'sword_1h' },
        { slot: 'off_hand', itemId: 'shield' },
        { slot: 'utility_potion', itemId: 'potion' },
      ],
      legacyClass: 'wizard',
    });
    expect(resolved.body.id).toBe('body_m');
    expect(resolved.presetId).toBe('paladin');
    expect(resolved.equipped.map(item => item.id).sort()).toEqual(['potion', 'shield', 'sword_1h']);
    expect(resolved.capabilities.melee).toBe(true);
  });

  it('falls back to preset when appearance is missing', () => {
    const resolved = resolveFromServerState({ legacyClass: 'paladin' });
    expect(resolved.body.id).toBe('body_m');
    expect(resolved.capabilities.melee).toBe(true);
  });

  it('falls back to preset when server rows reference unknown catalog ids', () => {
    const resolved = resolveFromServerState({
      appearance: { bodyId: 'body_m', scale: 1, loadoutPreset: 'paladin' },
      equipment: [
        { slot: 'main_hand', itemId: 'sword_that_does_not_exist' },
        { slot: 'off_hand', itemId: 'shield' },
      ],
      legacyClass: 'paladin',
    });
    // Must not throw (React render path). Unknown item → full preset fallback.
    expect(resolved.body.id).toBe('body_m');
    expect(resolved.equipped.map(item => item.id).sort()).toEqual(['potion', 'shield', 'sword_1h']);
    expect(resolved.capabilities.melee).toBe(true);
  });

  it('falls back to preset when server bodyId is unknown', () => {
    const resolved = resolveFromServerState({
      appearance: { bodyId: 'body_from_the_future', scale: 1, loadoutPreset: 'wizard' },
      equipment: [{ slot: 'main_hand', itemId: 'wand' }],
      legacyClass: 'wizard',
    });
    expect(resolved.body.id).toBe('body_f');
    expect(resolved.capabilities.spells).toEqual(['fireball', 'lightning']);
  });

  it('includes wand weapons-pack url for wizard preload', () => {
    const urls = assetUrlsForAppearance(resolvePreset('wizard'));
    const wand = resolvePreset('wizard').equipped.find(item => item.id === 'wand');
    expect(wand?.grantsOnly).toBeFalsy();
    expect(urls.some(url => url.includes('low_poly_weapons_pack'))).toBe(true);
  });

  it('applies drink_potion as a baseline grant (aligned with server)', () => {
    expect(BASELINE_ABILITY_GRANTS).toContain('drink_potion');
    const caps = capabilitiesFromGrants(['melee_slash']);
    expect(caps.melee).toBe(true);
    expect(caps.drinkPotion).toBe(true);
    expect(caps.block).toBe(false);
  });

  it('uses a stable assembly key when preset and server seed match', () => {
    const fromPreset = resolvePreset('paladin');
    const fromServer = resolveFromServerState({
      appearance: { bodyId: 'body_m', scale: 1, loadoutPreset: 'paladin' },
      equipment: [
        { slot: 'main_hand', itemId: 'sword_1h' },
        { slot: 'off_hand', itemId: 'shield' },
        { slot: 'utility_potion', itemId: 'potion' },
      ],
      legacyClass: 'paladin',
    });
    expect(presentationAssemblyKey(fromPreset)).toBe(presentationAssemblyKey(fromServer));
  });

  it('changes assembly key when presentation actually differs', () => {
    const normal = resolveFromServerState({
      appearance: { bodyId: 'body_m', scale: 1, loadoutPreset: 'paladin' },
      equipment: [
        { slot: 'main_hand', itemId: 'sword_1h' },
        { slot: 'off_hand', itemId: 'shield' },
      ],
      legacyClass: 'paladin',
    });
    const scaled = resolveFromServerState({
      appearance: { bodyId: 'body_m', scale: 1.15, loadoutPreset: 'paladin' },
      equipment: [
        { slot: 'main_hand', itemId: 'sword_1h' },
        { slot: 'off_hand', itemId: 'shield' },
      ],
      legacyClass: 'paladin',
    });
    expect(presentationAssemblyKey(normal)).not.toBe(presentationAssemblyKey(scaled));
  });

  it('splits body/clips vs equipment keys for partial reassemble gating', () => {
    const withSword = resolveFromServerState({
      appearance: { bodyId: 'body_m', scale: 1, loadoutPreset: 'paladin' },
      equipment: [
        { slot: 'main_hand', itemId: 'sword_1h' },
        { slot: 'off_hand', itemId: 'shield' },
      ],
      legacyClass: 'paladin',
    });
    const withWand = resolveFromServerState({
      appearance: { bodyId: 'body_m', scale: 1, loadoutPreset: 'paladin' },
      equipment: [
        { slot: 'main_hand', itemId: 'wand' },
        { slot: 'off_hand', itemId: 'shield' },
      ],
      legacyClass: 'paladin',
    });
    const wizard = resolvePreset('wizard');

    expect(appearanceBodyClipsKey(withSword)).toBe(appearanceBodyClipsKey(withWand));
    expect(appearanceEquipmentKey(withSword)).not.toBe(appearanceEquipmentKey(withWand));
    expect(presentationAssemblyKey(withSword)).not.toBe(presentationAssemblyKey(withWand));

    expect(appearanceBodyClipsKey(withSword)).not.toBe(appearanceBodyClipsKey(wizard));
  });

  it('follows mid-session equipment rows without re-injecting preset utility', () => {
    const withWand = resolveFromServerState({
      appearance: { bodyId: 'body_m', scale: 1, loadoutPreset: 'paladin' },
      equipment: [
        { slot: 'main_hand', itemId: 'wand' },
        { slot: 'off_hand', itemId: 'shield' },
      ],
      legacyClass: 'paladin',
    });
    expect(withWand.equipped.map(item => item.id).sort()).toEqual(['shield', 'wand']);
    expect([...withWand.capabilities.spells]).toEqual(['fireball', 'lightning']);
    expect(withWand.capabilities.melee).toBe(false);
    expect(withWand.capabilities.drinkPotion).toBe(true); // baseline

    const unequippedMain = resolveFromServerState({
      appearance: { bodyId: 'body_m', scale: 1, loadoutPreset: 'paladin' },
      equipment: [{ slot: 'off_hand', itemId: 'shield' }],
      legacyClass: 'paladin',
    });
    expect(unequippedMain.equipped.map(item => item.id)).toEqual(['shield']);
    expect(unequippedMain.capabilities.spells).toEqual([]);
    expect(unequippedMain.capabilities.melee).toBe(false);
    expect(unequippedMain.capabilities.block).toBe(true);
  });

  it('treats empty equipment array as empty loadout (not preset fallback)', () => {
    const empty = resolveFromServerState({
      appearance: { bodyId: 'body_f', scale: 1, loadoutPreset: 'wizard' },
      equipment: [],
      legacyClass: 'wizard',
    });
    expect(empty.equipped).toEqual([]);
    expect(empty.capabilities.spells).toEqual([]);
    expect(empty.capabilities.drinkPotion).toBe(true);
  });
});
