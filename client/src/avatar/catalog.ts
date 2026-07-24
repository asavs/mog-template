import { publicAssetPath } from '../publicAssets';
import { SOCKET_BONE_CANDIDATES } from './rig';
import {
  DEFAULT_PRESET_ID,
  LOADOUT_AUTHORITY,
  LOADOUT_DERIVED,
  isAuthorityEquipSlot,
  isBodyId,
  isItemId,
  isLoadoutPresetId,
} from './loadoutAuthority.generated';
import type {
  AbilityId,
  AvatarCapabilities,
  AvatarCatalog,
  BodyDef,
  BodyId,
  ClipSource,
  EquipSlot,
  ItemDef,
  ItemId,
  ItemSlot,
  LoadoutPreset,
  LoadoutPresetId,
  PlayerAppearance,
  ResolvedAppearance,
  ResolvedClip,
  ResolvedItem,
  SocketBinding,
  SocketId,
  WizardSpell,
} from './types';

/**
 * Default catalog.
 *
 * **Authority** (ids, slots, grants, presets, utility equipment) comes from
 * `shared/avatar-loadout.json` via `loadoutAuthority.generated.ts` (issue #46).
 * Regenerate: `node scripts/gen-avatar-loadout.mjs`
 *
 * **Presentation** (meshKeys, sockets TRS, clips) stays here until modular art.
 * Rig contract: `mog_humanoid` (see rig.ts).
 */

const SHARED_FOOTSTEPS = {
  walk: 'walk_footsteps' as const,
  run: 'run_footsteps' as const,
};

const SOCKETS: Record<string, SocketBinding> = {
  right_hand: {
    id: 'right_hand',
    boneNames: SOCKET_BONE_CANDIDATES.right_hand,
    position: [0, 0.1, 0.07],
    rotation: [1.05, 0.4708, 4.3],
    scale: 1.85,
  },
  left_hand: {
    id: 'left_hand',
    boneNames: SOCKET_BONE_CANDIDATES.left_hand,
    position: [0.01, 0.21, -0.08],
    rotation: [4.45, 3.3792, -0.3],
    scale: 0.57,
  },
};

/** Presentation mesh fields keyed by authority body id. */
const BODY_PRESENTATION: Record<string, Omit<BodyDef, 'id'>> = {
  // Transitional: full character FBX acts as "body" until modular meshes exist.
  body_m: {
    meshKey: 'models/paladin/paladin.fbx',
    referenceHeight: 2.0,
    yOffset: 0.85,
    footstepSounds: SHARED_FOOTSTEPS,
  },
  body_f: {
    meshKey: 'models/wizard2/wizard2.fbx',
    referenceHeight: 2.0,
    yOffset: 0.85,
    footstepSounds: SHARED_FOOTSTEPS,
  },
};

function buildBodiesFromAuthority(): Record<string, BodyDef> {
  const out: Record<string, BodyDef> = {};
  for (const id of Object.keys(LOADOUT_AUTHORITY.bodies)) {
    if (!isBodyId(id)) {
      throw new Error(`Authority body key is not a known BodyId: ${id}`);
    }
    const presentation = BODY_PRESENTATION[id];
    if (!presentation) {
      throw new Error(
        `Missing BODY_PRESENTATION for authority body "${id}" — add meshKey in catalog.ts`,
      );
    }
    out[id] = { id, ...presentation };
  }
  return out;
}

const BODIES: Record<string, BodyDef> = buildBodiesFromAuthority();

/** Presentation-only fields keyed by authority item id. */
const ITEM_PRESENTATION: Record<
  string,
  Omit<ItemDef, 'id' | 'slot' | 'grants'>
> = {
  sword_1h: {
    meshKey: 'models/weapons/low_poly_weapons_pack_rigged_blender.glb',
    attach: 'socket',
    socketId: 'right_hand',
    objectNames: ['Baked one handed sword', 'One handed sword'],
  },
  shield: {
    meshKey: 'models/weapons/low_poly_weapons_pack_rigged_blender.glb',
    attach: 'socket',
    socketId: 'left_hand',
    objectNames: ['Baked shield 1', 'Shield 1'],
  },
  wand: {
    meshKey: 'models/weapons/low_poly_weapons_pack_rigged_blender.glb',
    attach: 'socket',
    socketId: 'right_hand',
    objectNames: ['Baked wand', 'Wand'],
  },
  dagger: {
    meshKey: 'models/weapons/low_poly_weapons_pack_rigged_blender.glb',
    attach: 'socket',
    socketId: 'right_hand',
    objectNames: ['Baked dagger', 'Dagger'],
  },
  potion: {
    meshKey: 'models/items/red-potion.glb',
    attach: 'socket',
    socketId: 'left_hand',
    position: [19, 7, 0],
    rotation: [-1.5708, 0.1, 1.75],
    scale: 122.5031,
    normalizeHeight: 0.28,
    visibleByDefault: false,
  },
};

function buildItemsFromAuthority(): Record<string, ItemDef> {
  const out: Record<string, ItemDef> = {};
  for (const [id, auth] of Object.entries(LOADOUT_AUTHORITY.items)) {
    if (!isItemId(id)) {
      throw new Error(`Authority item key is not a known ItemId: ${id}`);
    }
    const presentation = ITEM_PRESENTATION[id];
    if (!presentation) {
      throw new Error(
        `Missing ITEM_PRESENTATION for authority item "${id}" — add meshKey/attach in catalog.ts`,
      );
    }
    out[id] = {
      id,
      slot: auth.slot as ItemSlot,
      grants: [...auth.grants] as AbilityId[],
      ...presentation,
    };
  }
  return out;
}

const ITEMS: Record<string, ItemDef> = buildItemsFromAuthority();

const DRINKING_CLIP: ClipSource = {
  actionKey: 'drinking',
  meshKey: 'models/animations/drinking.fbx',
  trimStartSeconds: 2.5,
  trimEndSeconds: 2.5,
};

function paladinClips(): ClipSource[] {
  const names: [string, string][] = [
    ['idle', 'idle'],
    ['walk', 'walk-forward'],
    ['walk_back', 'walk-back'],
    ['walk_left', 'walk-left'],
    ['walk_right', 'walk-right'],
    ['run', 'run-forward'],
    ['run_back', 'run-back'],
    ['run_left', 'run-left'],
    ['run_right', 'run-right'],
    ['jump', 'jump'],
    ['slash', 'slash'],
    ['block', 'block'],
    ['death', 'death'],
  ];
  return [
    ...names.map(([actionKey, file]) => ({
      actionKey,
      meshKey: `models/paladin/paladin-${file}.fbx`,
    })),
    DRINKING_CLIP,
  ];
}

function wizardClips(): ClipSource[] {
  const files: Record<string, string> = {
    idle: 'wizard2-idle.fbx',
    walk: 'wizard2-walk-forward.fbx',
    walk_back: 'wizard2-walk-back.fbx',
    walk_left: 'wizard2-walk-left.fbx',
    walk_right: 'wizard2-walk-right.fbx',
    run: 'wizard2-run-forward.fbx',
    run_back: 'wizard2-run-back.fbx',
    run_left: 'wizard2-run-left.fbx',
    run_right: 'wizard2-run-right.fbx',
    jump: 'wizard2-jump.fbx',
    cast: 'wizard2-magic-attack.fbx',
  };
  return [
    ...Object.entries(files).map(([actionKey, file]) => ({
      actionKey,
      meshKey: `models/wizard2/${file}`,
      upperBodyOnly: actionKey === 'cast' ? true : undefined,
    })),
    DRINKING_CLIP,
  ];
}

/** Presentation clip lists keyed by preset id (not authority). */
const PRESET_CLIPS: Record<string, () => ClipSource[]> = {
  paladin: paladinClips,
  wizard: wizardClips,
  // Acolyte reuses wizard locomotion/cast clips (shared body_f monomesh).
  acolyte: wizardClips,
};

function buildPresetsFromAuthority(): Record<string, LoadoutPreset> {
  const out: Record<string, LoadoutPreset> = {};
  for (const [id, auth] of Object.entries(LOADOUT_AUTHORITY.presets)) {
    if (!isLoadoutPresetId(id)) {
      throw new Error(`Authority preset key is not a known LoadoutPresetId: ${id}`);
    }
    const clipsFn = PRESET_CLIPS[id];
    if (!clipsFn) {
      throw new Error(`Missing PRESET_CLIPS for authority preset "${id}"`);
    }
    if (!isBodyId(auth.bodyId)) {
      throw new Error(`Authority preset "${id}" has unknown bodyId: ${auth.bodyId}`);
    }
    out[id] = {
      id,
      label: auth.label,
      appearance: {
        bodyId: auth.bodyId,
        scale: auth.scale,
        slots: { ...(auth.slots as Partial<Record<EquipSlot, ItemId>>) },
      },
      clips: clipsFn(),
      extraGrants: [...(auth.extraGrants ?? [])] as AbilityId[],
    };
  }
  return out;
}

const PRESETS: Record<string, LoadoutPreset> = buildPresetsFromAuthority();

/** Always-on utility attaches that are not exclusive paper-doll slots (Phase A). */
const UTILITY_ITEMS_BY_PRESET: Record<string, readonly ItemId[]> = Object.fromEntries(
  Object.entries(LOADOUT_DERIVED.utilityItemsByPreset).map(([presetId, items]) => [
    presetId,
    items as readonly ItemId[],
  ]),
);

const SLOT_ORDER: readonly EquipSlot[] = [
  'head',
  'chest',
  'arms',
  'legs',
  'feet',
  'back',
  'main_hand',
  'off_hand',
];

function uniqueGrants(parts: readonly (readonly AbilityId[])[]): AbilityId[] {
  const seen = new Set<AbilityId>();
  const out: AbilityId[] = [];
  for (const list of parts) {
    for (const id of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Grants every humanoid PC has even with empty equipment.
 * From shared/avatar-loadout.json → baselineGrants.
 */
export const BASELINE_ABILITY_GRANTS: readonly AbilityId[] = [
  ...LOADOUT_AUTHORITY.baselineGrants,
] as AbilityId[];

export function capabilitiesFromGrants(grants: readonly AbilityId[]): AvatarCapabilities {
  const set = new Set<AbilityId>([...BASELINE_ABILITY_GRANTS, ...grants]);
  const spells: WizardSpell[] = [];
  if (set.has('cast_fireball')) spells.push('fireball');
  if (set.has('cast_lightning')) spells.push('lightning');
  return {
    melee: set.has('melee_slash'),
    block: set.has('block'),
    spells,
    drinkPotion: set.has('drink_potion'),
  };
}

/**
 * Body + scale + clip identity. When this is stable, equipment-only changes can
 * partial-sync gear without reloading the skeleton or rebinding clips.
 */
export function appearanceBodyClipsKey(resolved: ResolvedAppearance): string {
  const clips = resolved.clips
    .map(clip => `${clip.actionKey}:${clip.meshKey}`)
    .sort()
    .join(',');
  return [
    resolved.presetId ?? '',
    resolved.body.id,
    resolved.body.meshKey,
    String(resolved.scale),
    clips,
  ].join('|');
}

/**
 * Equipped item set identity (slots / ids / mesh or grantsOnly). Used to gate
 * equipment-only partial re-attach.
 */
export function appearanceEquipmentKey(resolved: ResolvedAppearance): string {
  return resolved.equipped
    .map(item => `${item.slot}:${item.id}:${item.grantsOnly ? 'grantsOnly' : item.meshKey}`)
    .sort()
    .join(',');
}

/**
 * Stable key for full presentation identity. Same key ⇒ skip dispose/rebuild
 * (join race where preset fallback and seeded server rows resolve to the same
 * loadout). Composes body/clips + equipment + grants.
 */
export function presentationAssemblyKey(resolved: ResolvedAppearance): string {
  const grants = [...resolved.grants].sort().join(',');
  return [
    appearanceBodyClipsKey(resolved),
    appearanceEquipmentKey(resolved),
    grants,
  ].join('||');
}

export function createAvatarCatalog(options?: {
  bodies?: Record<string, BodyDef>;
  items?: Record<string, ItemDef>;
  sockets?: Record<string, SocketBinding>;
  presets?: Record<string, LoadoutPreset>;
  utilityItemsByPreset?: Record<string, readonly ItemId[]>;
  urlForMeshKey?: (meshKey: string) => string;
}): AvatarCatalog {
  const bodies = options?.bodies ?? BODIES;
  const items = options?.items ?? ITEMS;
  const sockets = options?.sockets ?? SOCKETS;
  const presets = options?.presets ?? PRESETS;
  const utilityItemsByPreset = options?.utilityItemsByPreset ?? UTILITY_ITEMS_BY_PRESET;
  const urlForMeshKey = options?.urlForMeshKey ?? ((meshKey: string) => publicAssetPath(meshKey));

  function resolveItem(itemId: ItemId): ResolvedItem {
    const def = items[itemId];
    if (!def) {
      throw new Error(`Unknown itemId: ${itemId}`);
    }
    const socket = def.socketId ? sockets[def.socketId] : undefined;
    if (def.attach === 'socket' && !socket) {
      throw new Error(`Item ${itemId} needs socket ${def.socketId}`);
    }
    return {
      ...def,
      url: urlForMeshKey(def.meshKey),
      socket,
    };
  }

  const catalog: AvatarCatalog = {
    getBody(bodyId: BodyId) {
      return bodies[bodyId];
    },
    getItem(itemId: ItemId) {
      return items[itemId];
    },
    getSocket(socketId: SocketId) {
      return sockets[socketId];
    },
    getPreset(presetId: string) {
      return presets[presetId];
    },
    listPresets() {
      return Object.values(presets);
    },
    urlForMeshKey,
    resolve(
      appearance: PlayerAppearance,
      resolveOptions?: {
        presetId?: string;
        /**
         * When true (default), inject preset utilityEquipment rows (join/preset resolve).
         * When false, only paper-doll `appearance.slots` are used — server equipment
         * rows already include utility attaches (issue #49 equip loop).
         */
        includePresetUtility?: boolean;
      },
    ): ResolvedAppearance {
      const body = bodies[appearance.bodyId];
      if (!body) {
        throw new Error(`Unknown bodyId: ${appearance.bodyId}`);
      }

      const equipped: ResolvedItem[] = [];
      const grantLists: (readonly AbilityId[])[] = [];
      const seenItemIds = new Set<ItemId>();

      for (const slot of SLOT_ORDER) {
        const itemId = appearance.slots[slot];
        if (!itemId) continue;
        const resolved = resolveItem(itemId);
        if (resolved.slot !== slot) {
          throw new Error(`Item ${itemId} belongs in slot ${resolved.slot}, not ${slot}`);
        }
        equipped.push(resolved);
        seenItemIds.add(itemId);
        grantLists.push(resolved.grants);
      }

      // Preset utility attaches (e.g. utility_potion). Skipped when resolving from
      // live server equipment rows so mid-session unequip is visible.
      const includeUtility = resolveOptions?.includePresetUtility !== false;
      const utilityIds =
        includeUtility && resolveOptions?.presetId
          ? utilityItemsByPreset[resolveOptions.presetId] ?? []
          : [];
      for (const itemId of utilityIds) {
        if (seenItemIds.has(itemId)) continue;
        const resolved = resolveItem(itemId);
        equipped.push(resolved);
        seenItemIds.add(itemId);
        grantLists.push(resolved.grants);
      }

      const preset = resolveOptions?.presetId ? presets[resolveOptions.presetId] : undefined;
      if (preset?.extraGrants) {
        grantLists.push(preset.extraGrants);
      }

      const grants = uniqueGrants(grantLists);
      const clips: ResolvedClip[] = (preset?.clips ?? []).map(clip => ({
        ...clip,
        url: urlForMeshKey(clip.meshKey),
      }));

      const resolvedPresetId = resolveOptions?.presetId;
      return {
        body: { ...body, url: urlForMeshKey(body.meshKey) },
        scale: appearance.scale,
        equipped,
        grants,
        capabilities: capabilitiesFromGrants(grants),
        clips,
        presetId:
          resolvedPresetId && isLoadoutPresetId(resolvedPresetId)
            ? resolvedPresetId
            : undefined,
      };
    },
  };

  return catalog;
}

/** Default app catalog (transitional mesh keys). */
export const defaultAvatarCatalog: AvatarCatalog = createAvatarCatalog();

/**
 * Map legacy join class strings onto loadout preset ids.
 * Table lives in shared/avatar-loadout.json → legacyClassToPreset.
 */
export function presetIdFromLegacyClass(
  characterClass: string | null | undefined,
): LoadoutPresetId {
  const key = (characterClass ?? '').trim().toLowerCase();
  const mapped =
    LOADOUT_AUTHORITY.legacyClassToPreset[
      key as keyof typeof LOADOUT_AUTHORITY.legacyClassToPreset
    ];
  return (mapped ?? DEFAULT_PRESET_ID) as LoadoutPresetId;
}

export function appearanceFromPreset(
  presetId: LoadoutPresetId | string,
  catalog: AvatarCatalog = defaultAvatarCatalog,
): PlayerAppearance {
  const preset = catalog.getPreset(presetId);
  if (!preset) {
    throw new Error(`Unknown loadout preset: ${presetId}`);
  }
  return {
    bodyId: preset.appearance.bodyId,
    scale: preset.appearance.scale,
    slots: { ...preset.appearance.slots },
    cosmetics: preset.appearance.cosmetics ? { ...preset.appearance.cosmetics } : undefined,
  };
}

export function resolvePreset(
  presetId: LoadoutPresetId | string,
  catalog: AvatarCatalog = defaultAvatarCatalog,
): ResolvedAppearance {
  const appearance = appearanceFromPreset(presetId, catalog);
  return catalog.resolve(appearance, {
    presetId: isLoadoutPresetId(presetId) ? presetId : presetIdFromLegacyClass(presetId),
  });
}

const PAPER_DOLL_SLOTS = new Set<string>(SLOT_ORDER);

export type NetworkAppearanceRow = {
  bodyId: string;
  scale: number;
  loadoutPreset: string;
};

export type NetworkEquipmentRow = {
  slot: string;
  itemId: string;
};

/**
 * Prefer authoritative appearance + equipment rows from SpacetimeDB.
 * Falls back to loadout preset when rows are missing (join race / legacy),
 * or when server ids are unknown to this client build (catalog drift).
 *
 * `equipment: undefined | null` → subscription race / no rows yet → preset fallback.
 * `equipment: []` → intentionally empty loadout (baseline grants only).
 */
export function resolveFromServerState(options: {
  appearance?: NetworkAppearanceRow | null;
  equipment?: readonly NetworkEquipmentRow[] | null;
  /** Legacy character_class / preset string when appearance is absent. */
  legacyClass?: string | null;
  catalog?: AvatarCatalog;
}): ResolvedAppearance {
  const catalog = options.catalog ?? defaultAvatarCatalog;

  const fallbackPresetId = (): LoadoutPresetId => {
    const fromAppearance = options.appearance?.loadoutPreset?.trim();
    if (fromAppearance && isLoadoutPresetId(fromAppearance) && catalog.getPreset(fromAppearance)) {
      return fromAppearance;
    }
    return presetIdFromLegacyClass(options.legacyClass ?? fromAppearance);
  };

  try {
    const appearance = options.appearance;
    if (!appearance) {
      return resolvePreset(fallbackPresetId(), catalog);
    }

    const rawPresetId = appearance.loadoutPreset || presetIdFromLegacyClass(options.legacyClass);
    const presetId: LoadoutPresetId = isLoadoutPresetId(rawPresetId)
      ? rawPresetId
      : fallbackPresetId();

    // Equipment not subscribed yet — keep preset presentation for join race.
    if (options.equipment == null) {
      return resolvePreset(presetId, catalog);
    }

    const slots: PlayerAppearance['slots'] = {};
    const extraItemIds: ItemId[] = [];

    for (const row of options.equipment) {
      if (!isItemId(row.itemId)) {
        // Unknown item from a newer server build — fail the whole resolve into fallback.
        throw new Error(`Unknown itemId from server: ${row.itemId}`);
      }
      if (PAPER_DOLL_SLOTS.has(row.slot) || isAuthorityEquipSlot(row.slot)) {
        slots[row.slot as EquipSlot] = row.itemId;
      } else {
        // utility_potion and future non-paper-doll attaches
        extraItemIds.push(row.itemId);
      }
    }

    if (!isBodyId(appearance.bodyId)) {
      throw new Error(`Unknown bodyId from server: ${appearance.bodyId}`);
    }

    // Do not re-inject preset utility — server equipment is authoritative mid-session.
    const base = catalog.resolve(
      {
        bodyId: appearance.bodyId,
        scale: appearance.scale,
        slots,
      },
      { presetId, includePresetUtility: false },
    );

    if (extraItemIds.length === 0) {
      return base;
    }

    // Append utility items not covered by EquipSlot (server stores them under utility slots).
    const seen = new Set(base.equipped.map(item => item.id));
    const extraEquipped = [...base.equipped];
    const grantLists: (readonly AbilityId[])[] = [base.grants];
    for (const itemId of extraItemIds) {
      if (seen.has(itemId)) continue;
      const def = catalog.getItem(itemId);
      if (!def) continue;
      const socket = def.socketId ? catalog.getSocket(def.socketId) : undefined;
      extraEquipped.push({
        ...def,
        url: catalog.urlForMeshKey(def.meshKey),
        socket,
      });
      seen.add(itemId);
      grantLists.push(def.grants);
    }

    const grants = uniqueGrants(grantLists);
    return {
      ...base,
      equipped: extraEquipped,
      grants,
      capabilities: capabilitiesFromGrants(grants),
    };
  } catch (error) {
    // Unknown bodyId / itemId / slot mismatch must not throw during React render
    // (stale client vs redeployed server). Same doctrine as missing-row fallback.
    console.warn(
      '[avatar] server appearance/equipment resolve failed; falling back to loadout preset',
      error,
    );
    return resolvePreset(fallbackPresetId(), catalog);
  }
}

/** Asset URLs needed to present this resolved appearance (body, gear, clips). */
export function assetUrlsForAppearance(resolved: ResolvedAppearance): string[] {
  const urls = new Set<string>();
  urls.add(resolved.body.url);
  for (const item of resolved.equipped) {
    if (item.grantsOnly) {
      // No mesh to fetch (grants-only placeholder).
      continue;
    }
    urls.add(item.url);
  }
  for (const clip of resolved.clips) {
    urls.add(clip.url);
  }
  return [...urls];
}
