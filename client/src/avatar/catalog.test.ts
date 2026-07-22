import { describe, expect, it } from 'vitest';
import {
  appearanceFromPreset,
  assetUrlsForAppearance,
  createAvatarCatalog,
  defaultAvatarCatalog,
  presetIdFromLegacyClass,
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
});
