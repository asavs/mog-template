import { describe, expect, it } from 'vitest';
import {
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
    expect(resolved.capabilities.melee).toBe(false);
    expect(resolved.capabilities.block).toBe(false);
    expect([...resolved.capabilities.spells]).toEqual(['fireball', 'lightning']);
    expect(resolved.clips.some(clip => clip.actionKey === 'cast' && clip.upperBodyOnly)).toBe(true);
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
      equipment: [{ slot: 'main_hand', itemId: 'staff' }],
      legacyClass: 'wizard',
    });
    expect(resolved.body.id).toBe('body_f');
    expect(resolved.capabilities.spells).toEqual(['fireball', 'lightning']);
  });

  it('skips grantsOnly items in asset url lists', () => {
    const urls = assetUrlsForAppearance(resolvePreset('wizard'));
    // Staff is grantsOnly — must not pull a second body-pack URL as "gear".
    const staff = resolvePreset('wizard').equipped.find(item => item.id === 'staff');
    expect(staff?.grantsOnly).toBe(true);
    // Body url may still be wizard2; gear must not re-list staff meshKey separately as attach.
    expect(staff && urls.filter(url => url === staff.url).length).toBeLessThanOrEqual(1);
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

  it('follows mid-session equipment rows without re-injecting preset utility', () => {
    const withStaff = resolveFromServerState({
      appearance: { bodyId: 'body_m', scale: 1, loadoutPreset: 'paladin' },
      equipment: [
        { slot: 'main_hand', itemId: 'staff' },
        { slot: 'off_hand', itemId: 'shield' },
      ],
      legacyClass: 'paladin',
    });
    expect(withStaff.equipped.map(item => item.id).sort()).toEqual(['shield', 'staff']);
    expect([...withStaff.capabilities.spells]).toEqual(['fireball', 'lightning']);
    expect(withStaff.capabilities.melee).toBe(false);
    expect(withStaff.capabilities.drinkPotion).toBe(true); // baseline

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
