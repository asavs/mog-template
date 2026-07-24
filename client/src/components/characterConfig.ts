/**
 * Thin gameplay adapters over the avatar catalog.
 *
 * Mesh paths, attachments, and clip lists live in `src/avatar/`.
 * This module keeps ANIMATIONS keys and legacy class → preset helpers used by
 * controls, prediction, and join UI.
 */

import {
  defaultAvatarCatalog,
  presetIdFromLegacyClass,
  resolveFromServerState,
  resolvePreset,
  type NetworkAppearanceRow,
  type NetworkEquipmentRow,
} from '../avatar/catalog';
import {
  AUTHORITY_EQUIP_SLOTS,
  AUTHORITY_UTILITY_SLOTS,
  DEFAULT_PRESET_ID,
  ITEM_IDS,
  LOADOUT_AUTHORITY,
  isAuthorityUtilitySlot,
  isLoadoutPresetId,
  type LoadoutPresetId,
} from '../avatar/loadoutAuthority.generated';
import type { AvatarCapabilities, ResolvedAppearance, WizardSpell } from '../avatar/types';

export type { WizardSpell, LoadoutPresetId };
export { DEFAULT_PRESET_ID, isLoadoutPresetId };

export const ANIMATIONS = {
  IDLE: 'idle',
  WALK: 'walk',
  WALK_BACK: 'walk_back',
  WALK_LEFT: 'walk_left',
  WALK_RIGHT: 'walk_right',
  RUN: 'run',
  RUN_BACK: 'run_back',
  RUN_LEFT: 'run_left',
  RUN_RIGHT: 'run_right',
  JUMP: 'jump',
  SLASH: 'slash',
  BLOCK: 'block',
  CAST: 'cast',
  DRINKING: 'drinking',
  DEATH: 'death',
} as const;

/** @deprecated Prefer clip.trim* on catalog ClipSource. Kept for any stray imports. */
export const DRINKING_ANIMATION_TRIM_START_SECONDS = 2.5;
/** @deprecated Prefer clip.trim* on catalog ClipSource. */
export const DRINKING_ANIMATION_TRIM_END_SECONDS = 2.5;

export type ClassCapabilities = AvatarCapabilities;

/**
 * Normalized join/loadout preset id after legacy remap.
 * Open string so new presets (e.g. acolyte) work without closed-union churn.
 */
export type NormalizedCharacterClass = string;

/** @deprecated Prefer getCharacterPresentation; retained for QA capability matrix. */
export type CharacterConfigKey = string;

/**
 * Capability-only table for harness phase generation.
 * Built from catalog presets so new loadout rows appear automatically.
 * Full mesh/clip data lives in the avatar catalog — do not re-grow this object.
 */
function buildCharacterConfigs(): Record<string, { capabilities: ClassCapabilities }> {
  const out: Record<string, { capabilities: ClassCapabilities }> = {};
  for (const preset of defaultAvatarCatalog.listPresets()) {
    out[preset.id] = { capabilities: resolvePreset(preset.id).capabilities };
  }
  return out;
}

export const CHARACTER_CONFIGS: Record<
  string,
  { capabilities: ClassCapabilities }
> = buildCharacterConfigs();

export type CharacterPresentation = {
  presetId: string;
  resolved: ResolvedAppearance;
  yOffset: number;
  targetHeight: number;
  capabilities: ClassCapabilities;
  footstepSounds: ResolvedAppearance['body']['footstepSounds'];
  equipmentIds: readonly string[];
};

export type LoadoutPresetOption = {
  id: LoadoutPresetId;
  label: string;
};

export type CatalogEquipItem = {
  itemId: string;
  /** Authority slot this item equips into. */
  slot: string;
  /** paper-doll exclusive vs utility attach */
  group: 'equipment' | 'utility';
  label: string;
};

/** Human-readable label from a snake_case / id string. */
export function formatCatalogIdLabel(id: string): string {
  return id
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Join UI options: one entry per catalog loadout preset (labels from authority).
 * Driven by `defaultAvatarCatalog.listPresets()` — not a hardcoded class list.
 */
export function listLoadoutPresetsForSelect(
  catalog = defaultAvatarCatalog,
): readonly LoadoutPresetOption[] {
  return catalog.listPresets().map(preset => ({
    id: preset.id as LoadoutPresetId,
    label: preset.label || formatCatalogIdLabel(preset.id),
  }));
}

/**
 * Catalog items available to equip mid-session.
 * True inventory bags are future work — this is the authority item catalog.
 */
export function listEquippableCatalogItems(): readonly CatalogEquipItem[] {
  return ITEM_IDS.map(itemId => {
    const auth = LOADOUT_AUTHORITY.items[itemId];
    const slot = auth.slot;
    return {
      itemId,
      slot,
      group: isAuthorityUtilitySlot(slot) ? 'utility' : 'equipment',
      label: formatCatalogIdLabel(itemId),
    };
  });
}

/** Paper-doll equip slots from loadout authority (stable order). */
export function listAuthorityEquipSlots(): readonly string[] {
  return AUTHORITY_EQUIP_SLOTS;
}

/** Utility attach slots from loadout authority (stable order). */
export function listAuthorityUtilitySlots(): readonly string[] {
  return AUTHORITY_UTILITY_SLOTS;
}

// Single copy of the legacy class remap table on the client. Remote players'
// DB rows may still carry legacy values until they rejoin, and localStorage may
// hold a legacy stored class; normalize both through here.
export function normalizeCharacterClass(
  characterClass: string | null | undefined,
): NormalizedCharacterClass {
  const key = (characterClass ?? '').trim().toLowerCase();
  // Direct preset ids (including acolyte and future presets) pass through when
  // present in generated authority + catalog presentation.
  if (key && isLoadoutPresetId(key) && defaultAvatarCatalog.getPreset(key)) {
    return key;
  }
  return presetIdFromLegacyClass(characterClass);
}

/** Join-dialog button label for a loadout preset id (catalog `label`, else title case). */
export function joinPresetButtonLabel(presetId: string): string {
  const preset = defaultAvatarCatalog.getPreset(presetId);
  if (preset?.label) return preset.label;
  if (!presetId) return formatCatalogIdLabel(DEFAULT_PRESET_ID);
  return formatCatalogIdLabel(presetId);
}

export function presentationFromResolved(resolved: ResolvedAppearance): CharacterPresentation {
  return {
    presetId: resolved.presetId ?? DEFAULT_PRESET_ID,
    resolved,
    yOffset: resolved.body.yOffset,
    targetHeight: resolved.body.referenceHeight * resolved.scale,
    capabilities: resolved.capabilities,
    footstepSounds: resolved.body.footstepSounds,
    equipmentIds: resolved.equipped.map(item => item.id),
  };
}

export function getCharacterPresentation(characterClass: string | undefined): CharacterPresentation {
  const presetId = normalizeCharacterClass(characterClass);
  return presentationFromResolved(resolvePreset(presetId, defaultAvatarCatalog));
}

/**
 * Prefer SpacetimeDB appearance + equipment; fall back to character_class preset.
 */
export function getCharacterPresentationFromServer(options: {
  legacyClass?: string | null;
  appearance?: NetworkAppearanceRow | null;
  equipment?: readonly NetworkEquipmentRow[] | null;
}): CharacterPresentation {
  return presentationFromResolved(
    resolveFromServerState({
      appearance: options.appearance,
      equipment: options.equipment,
      legacyClass: options.legacyClass,
      catalog: defaultAvatarCatalog,
    }),
  );
}

/** @deprecated Use getCharacterPresentation — name kept for call-site churn control. */
export function getCharacterConfig(characterClass: string | undefined): CharacterPresentation {
  return getCharacterPresentation(characterClass);
}

/**
 * Preset-only capabilities from a class/loadout string.
 * Prefer {@link resolvePlayerCapabilities} for post-join HUD/input gating so
 * live appearance + equipment grants can update mid-session.
 */
export function getCharacterCapabilities(characterClass: string | undefined): ClassCapabilities {
  return getCharacterPresentation(characterClass).capabilities;
}

/**
 * Single path for local-player combat UI / hotkey affordances.
 * Prefer SpacetimeDB appearance + equipment; fall back to character_class
 * loadout preset when rows are missing (same contract as remotes/presentation).
 */
export function resolvePlayerCapabilities(options: {
  legacyClass?: string | null;
  appearance?: NetworkAppearanceRow | null;
  equipment?: readonly NetworkEquipmentRow[] | null;
}): ClassCapabilities {
  return getCharacterPresentationFromServer(options).capabilities;
}

/** True when Digit1/Digit2 spell-select hotkeys should be active. */
export function hasSpellSelectHotkeys(capabilities: ClassCapabilities): boolean {
  return capabilities.spells.length > 0;
}

/** Whether a specific spell may be selected via hotkey from resolved caps. */
export function canSelectSpell(
  capabilities: ClassCapabilities,
  spell: WizardSpell,
): boolean {
  return capabilities.spells.includes(spell);
}

export function listLoadoutPresetIds(): readonly string[] {
  return defaultAvatarCatalog.listPresets().map(preset => preset.id);
}
