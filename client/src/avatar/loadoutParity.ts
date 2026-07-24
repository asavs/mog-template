/**
 * Guardrail: default catalog must match shared loadout authority (issue #46).
 *
 * Source of truth: `shared/avatar-loadout.json`
 * Generated: `loadoutAuthority.generated.ts` / `loadout_authority.generated.rs`
 * Regenerate: `node scripts/gen-avatar-loadout.mjs`
 */

import { defaultAvatarCatalog, resolvePreset } from './catalog';
import { LOADOUT_AUTHORITY, LOADOUT_DERIVED } from './loadoutAuthority.generated';
import type { AvatarCatalog } from './types';

/** Derived id tables from shared/avatar-loadout.json (via codegen). */
export const SERVER_LOADOUT_IDS = {
  presets: LOADOUT_DERIVED.presetIds,
  bodies: LOADOUT_DERIVED.bodyIds,
  items: LOADOUT_DERIVED.itemIds,
  grants: LOADOUT_DERIVED.grantIds,
  equipSlots: LOADOUT_AUTHORITY.equipSlots,
  utilitySlots: LOADOUT_AUTHORITY.utilitySlots,
  presetBodies: LOADOUT_DERIVED.presetBodies,
  presetGrants: LOADOUT_DERIVED.presetGrants,
  presetEquipmentItemIds: LOADOUT_DERIVED.presetEquipmentItemIds,
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
