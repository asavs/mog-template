import { describe, expect, it } from 'vitest';
import { assetUrlsForAppearance, resolvePreset } from './catalog';
import {
  SERVER_LOADOUT_IDS,
  collectCatalogLoadoutIds,
  sortedStrings,
} from './loadoutParity';

/**
 * Authority parity (issues #46 / #47).
 * Ids come from shared/avatar-loadout.json via loadoutAuthority.generated.ts.
 */
describe('loadout id parity (client catalog ↔ shared authority)', () => {
  const client = collectCatalogLoadoutIds();

  it('exposes the same preset ids as the server', () => {
    expect(client.presets).toEqual(sortedStrings(SERVER_LOADOUT_IDS.presets));
  });

  it('exposes the same body ids as the server', () => {
    expect(client.bodies).toEqual(sortedStrings(SERVER_LOADOUT_IDS.bodies));
  });

  it('exposes the same item ids as the server (via preset resolve)', () => {
    expect(client.items).toEqual(sortedStrings(SERVER_LOADOUT_IDS.items));
  });

  it('exposes the same grant ids as the server (via preset resolve)', () => {
    expect(client.grants).toEqual(sortedStrings(SERVER_LOADOUT_IDS.grants));
  });

  it('matches server preset → body mapping', () => {
    for (const presetId of SERVER_LOADOUT_IDS.presets) {
      const resolved = resolvePreset(presetId);
      expect(resolved.body.id).toBe(SERVER_LOADOUT_IDS.presetBodies[presetId]);
      expect(resolved.presetId).toBe(presetId);
    }
  });

  it('matches server preset grant sets (order-independent)', () => {
    for (const presetId of SERVER_LOADOUT_IDS.presets) {
      const resolved = resolvePreset(presetId);
      expect(sortedStrings(resolved.grants)).toEqual(
        sortedStrings(SERVER_LOADOUT_IDS.presetGrants[presetId]),
      );
    }
  });

  it('matches server preset equipment item ids (order-independent)', () => {
    for (const presetId of SERVER_LOADOUT_IDS.presets) {
      const resolved = resolvePreset(presetId);
      expect(sortedStrings(resolved.equipped.map(item => item.id))).toEqual(
        sortedStrings(SERVER_LOADOUT_IDS.presetEquipmentItemIds[presetId]),
      );
    }
  });
});

/**
 * Asset diet checks related to issues #73 / #75 — single-preset fetch sets.
 */
describe('preset asset diet (preload / remote on-demand)', () => {
  it('wizard asset urls do not pull the paladin mesh pack', () => {
    const urls = assetUrlsForAppearance(resolvePreset('wizard'));
    expect(urls.some(url => url.includes('/paladin/'))).toBe(false);
    expect(urls.some(url => url.includes('wizard2'))).toBe(true);
  });

  it('paladin asset urls do not pull the wizard2 mesh pack', () => {
    const urls = assetUrlsForAppearance(resolvePreset('paladin'));
    expect(urls.some(url => url.includes('/wizard2/'))).toBe(false);
    expect(urls.some(url => url.includes('paladin'))).toBe(true);
  });

  it('each preset still loads multiple clip files (Phase A — not shared library yet)', () => {
    // Guardrail for #73: if clip count spikes further, cold-load pressure grows.
    // Shared anim library (#68) should bring these down later.
    const wizardClips = resolvePreset('wizard').clips.length;
    const paladinClips = resolvePreset('paladin').clips.length;
    expect(wizardClips).toBeGreaterThan(5);
    expect(paladinClips).toBeGreaterThan(5);
    expect(wizardClips).toBeLessThan(40);
    expect(paladinClips).toBeLessThan(40);
  });
});
