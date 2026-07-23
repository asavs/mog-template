/**
 * Phase A dual-catalog guardrail helpers.
 *
 * Server source of truth for these string sets: `server/spacetimedb/src/loadout.rs`.
 * Client source: `catalog.ts` (default catalog). Keep both in the same PR until #46.
 */

import { defaultAvatarCatalog, resolvePreset } from './catalog';
import type { AvatarCatalog } from './types';

/** Ids declared on the server loadout module (must stay aligned with loadout.rs). */
export const SERVER_LOADOUT_IDS = {
  presets: ['paladin', 'wizard'] as const,
  bodies: ['body_m', 'body_f'] as const,
  items: ['sword_1h', 'shield', 'staff', 'potion'] as const,
  grants: [
    'melee_slash',
    'block',
    'cast_fireball',
    'cast_lightning',
    'drink_potion',
  ] as const,
  equipSlots: ['main_hand', 'off_hand'] as const,
  /** Non-EquipSlot attach names the server may seed (Phase A utility hack). */
  utilitySlots: ['utility_potion'] as const,
  presetBodies: {
    paladin: 'body_m',
    wizard: 'body_f',
  } as const,
  presetGrants: {
    paladin: ['melee_slash', 'block', 'drink_potion'],
    wizard: ['cast_fireball', 'cast_lightning', 'drink_potion'],
  } as const,
  presetEquipmentItemIds: {
    paladin: ['sword_1h', 'shield', 'potion'],
    wizard: ['staff', 'potion'],
  } as const,
} as const;

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Collect body / item / grant / preset ids reachable from the default (or injected) catalog.
 */
export function collectCatalogLoadoutIds(catalog: AvatarCatalog = defaultAvatarCatalog) {
  const presetIds: string[] = [];
  const bodyIds: string[] = [];
  const itemIds: string[] = [];
  const grantIds: string[] = [];

  for (const preset of catalog.listPresets()) {
    presetIds.push(preset.id);
    bodyIds.push(preset.appearance.bodyId);
    for (const grant of preset.extraGrants ?? []) {
      grantIds.push(grant);
    }

    const resolved = resolvePreset(preset.id, catalog);
    bodyIds.push(resolved.body.id);
    for (const grant of resolved.grants) {
      grantIds.push(grant);
    }
    for (const item of resolved.equipped) {
      itemIds.push(item.id);
      for (const grant of item.grants) {
        grantIds.push(grant);
      }
    }
  }

  return {
    presets: sortedUnique(presetIds),
    bodies: sortedUnique(bodyIds),
    items: sortedUnique(itemIds),
    grants: sortedUnique(grantIds),
  };
}

export function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort();
}
