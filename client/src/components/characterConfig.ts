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
import type { AvatarCapabilities, ResolvedAppearance, WizardSpell } from '../avatar/types';

export type { WizardSpell };

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

export type NormalizedCharacterClass = 'paladin' | 'wizard';

/** @deprecated Prefer getCharacterPresentation; retained for QA capability matrix. */
export type CharacterConfigKey = NormalizedCharacterClass;

/**
 * Capability-only table for harness phase generation.
 * Full mesh/clip data lives in the avatar catalog — do not re-grow this object.
 */
export const CHARACTER_CONFIGS: Record<
  CharacterConfigKey,
  { capabilities: ClassCapabilities }
> = {
  paladin: { capabilities: resolvePreset('paladin').capabilities },
  wizard: { capabilities: resolvePreset('wizard').capabilities },
};

export type CharacterPresentation = {
  presetId: string;
  resolved: ResolvedAppearance;
  yOffset: number;
  targetHeight: number;
  capabilities: ClassCapabilities;
  footstepSounds: ResolvedAppearance['body']['footstepSounds'];
  equipmentIds: readonly string[];
};

// Single copy of the legacy class remap table on the client. Remote players'
// DB rows may still carry legacy values until they rejoin, and localStorage may
// hold a legacy stored class; normalize both through here.
export function normalizeCharacterClass(
  characterClass: string | null | undefined,
): NormalizedCharacterClass {
  const presetId = presetIdFromLegacyClass(characterClass);
  return presetId === 'paladin' ? 'paladin' : 'wizard';
}

export function presentationFromResolved(resolved: ResolvedAppearance): CharacterPresentation {
  return {
    presetId: resolved.presetId ?? 'wizard',
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

export function getCharacterCapabilities(characterClass: string | undefined): ClassCapabilities {
  return getCharacterPresentation(characterClass).capabilities;
}

export function listLoadoutPresetIds(): readonly string[] {
  return defaultAvatarCatalog.listPresets().map(preset => preset.id);
}
