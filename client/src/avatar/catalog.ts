import { publicAssetPath } from '../publicAssets';
import { SOCKET_BONE_CANDIDATES } from './rig';
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
  LoadoutPreset,
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
 * meshKeys still point at today's disposable FBX/GLB pile so presets resolve
 * without new art. Phase B swaps meshKeys for modular body/armor/weapon GLBs
 * and a shared animation library — types stay the same.
 *
 * Rig contract: `mog_humanoid` (see rig.ts). Not Mixamo-locked; Mixamo names
 * are transitional aliases only.
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

const BODIES: Record<string, BodyDef> = {
  // Transitional: full character FBX acts as "body" until modular meshes exist.
  body_m: {
    id: 'body_m',
    meshKey: 'models/paladin/paladin.fbx',
    referenceHeight: 2.0,
    yOffset: 0.85,
    footstepSounds: SHARED_FOOTSTEPS,
  },
  body_f: {
    id: 'body_f',
    meshKey: 'models/wizard2/wizard2.fbx',
    referenceHeight: 2.0,
    yOffset: 0.85,
    footstepSounds: SHARED_FOOTSTEPS,
  },
};

const ITEMS: Record<string, ItemDef> = {
  sword_1h: {
    id: 'sword_1h',
    slot: 'main_hand',
    meshKey: 'models/weapons/low_poly_weapons_pack_rigged_blender.glb',
    attach: 'socket',
    socketId: 'right_hand',
    objectNames: ['Baked one handed sword', 'One handed sword'],
    grants: ['melee_slash'],
    position: [0, 0.1, 0.07],
    rotation: [1.05, 0.4708, 4.3],
    scale: 1.85,
  },
  shield: {
    id: 'shield',
    slot: 'off_hand',
    meshKey: 'models/weapons/low_poly_weapons_pack_rigged_blender.glb',
    attach: 'socket',
    socketId: 'left_hand',
    objectNames: ['Baked shield 1', 'Shield 1'],
    grants: ['block'],
    position: [0.01, 0.21, -0.08],
    rotation: [4.45, 3.3792, -0.3],
    scale: 0.57,
  },
  staff: {
    id: 'staff',
    slot: 'main_hand',
    // Placeholder: no isolated staff mesh yet; grants only until art exists.
    meshKey: 'models/wizard2/wizard2.fbx',
    attach: 'socket',
    socketId: 'right_hand',
    grants: ['cast_fireball', 'cast_lightning'],
    visibleByDefault: false,
  },
  potion: {
    id: 'potion',
    slot: 'off_hand',
    meshKey: 'models/items/red-potion.glb',
    attach: 'socket',
    socketId: 'left_hand',
    grants: ['drink_potion'],
    position: [19, 7, 0],
    rotation: [-1.5708, 0.1, 1.75],
    scale: 122.5031,
    normalizeHeight: 0.28,
    visibleByDefault: false,
  },
};

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

const PRESETS: Record<string, LoadoutPreset> = {
  paladin: {
    id: 'paladin',
    label: 'Paladin',
    appearance: {
      bodyId: 'body_m',
      scale: 1,
      slots: {
        main_hand: 'sword_1h',
        // Potion is a utility item; shield occupies off_hand in the true paper-doll.
        // Phase A keeps potion attachable via extra equipment merge (see resolve).
      },
    },
    clips: paladinClips(),
    extraGrants: ['drink_potion'],
  },
  wizard: {
    id: 'wizard',
    label: 'Wizard',
    appearance: {
      bodyId: 'body_f',
      scale: 1,
      slots: {
        main_hand: 'staff',
        off_hand: 'potion',
      },
    },
    clips: wizardClips(),
    extraGrants: ['drink_potion'],
  },
};

/** Always-on utility attaches that are not exclusive paper-doll slots (Phase A). */
const UTILITY_ITEMS_BY_PRESET: Record<string, readonly ItemId[]> = {
  paladin: ['shield', 'potion'],
  wizard: [],
};

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

export function capabilitiesFromGrants(grants: readonly AbilityId[]): AvatarCapabilities {
  const set = new Set(grants);
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
    resolve(appearance: PlayerAppearance, resolveOptions?: { presetId?: string }): ResolvedAppearance {
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

      // Phase A: paladin needs shield + potion without a second off_hand slot model.
      const utilityIds = resolveOptions?.presetId
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

      return {
        body: { ...body, url: urlForMeshKey(body.meshKey) },
        scale: appearance.scale,
        equipped,
        grants,
        capabilities: capabilitiesFromGrants(grants),
        clips,
        presetId: resolveOptions?.presetId,
      };
    },
  };

  return catalog;
}

/** Default app catalog (transitional mesh keys). */
export const defaultAvatarCatalog: AvatarCatalog = createAvatarCatalog();

/**
 * Map legacy join class strings onto loadout preset ids.
 * Prefer presets going forward; keep this until character_class rows migrate.
 */
export function presetIdFromLegacyClass(characterClass: string | null | undefined): string {
  switch ((characterClass ?? '').trim().toLowerCase()) {
    case 'paladin':
    case 'pally':
      return 'paladin';
    case 'wizard':
    case 'wizard2':
      return 'wizard';
    default:
      return 'wizard';
  }
}

export function appearanceFromPreset(
  presetId: string,
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
  presetId: string,
  catalog: AvatarCatalog = defaultAvatarCatalog,
): ResolvedAppearance {
  const appearance = appearanceFromPreset(presetId, catalog);
  return catalog.resolve(appearance, { presetId });
}

/** Asset URLs needed to present this resolved appearance (body, gear, clips). */
export function assetUrlsForAppearance(resolved: ResolvedAppearance): string[] {
  const urls = new Set<string>();
  urls.add(resolved.body.url);
  for (const item of resolved.equipped) {
    if (item.visibleByDefault === false && item.id === 'staff') {
      // Staff is grants-only placeholder on the body mesh — skip duplicate body fetch.
      continue;
    }
    urls.add(item.url);
  }
  for (const clip of resolved.clips) {
    urls.add(clip.url);
  }
  return [...urls];
}
