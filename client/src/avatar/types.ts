/**
 * Avatar / equipment contracts.
 *
 * Doctrine: wiki design/avatar-equipment.md (Projects/mog/.wiki).
 * Bodies are skins, gear is modular, abilities are data, classes are presets.
 *
 * Authority id unions (BodyId, ItemId, AbilityId, LoadoutPresetId) are
 * generated from shared/avatar-loadout.json — do not hand-edit those lists.
 */

import type { SoundId } from '../audio/soundRegistry';
import type {
  AbilityId as GeneratedAbilityId,
  AuthorityEquipSlot,
  AuthorityUtilitySlot,
  BodyId as GeneratedBodyId,
  ItemId as GeneratedItemId,
  LoadoutPresetId,
} from './loadoutAuthority.generated';

export type {
  AbilityId,
  AuthorityEquipSlot,
  AuthorityItemSlot,
  AuthorityUtilitySlot,
  BodyId,
  ItemId,
  LoadoutPresetId,
} from './loadoutAuthority.generated';
export {
  ABILITY_IDS,
  AUTHORITY_EQUIP_SLOTS,
  AUTHORITY_UTILITY_SLOTS,
  BODY_IDS,
  DEFAULT_PRESET_ID,
  ITEM_IDS,
  LOADOUT_PRESET_IDS,
  isAbilityId,
  isAuthorityEquipSlot,
  isAuthorityItemSlot,
  isAuthorityUtilitySlot,
  isBodyId,
  isItemId,
  isLoadoutPresetId,
} from './loadoutAuthority.generated';

// Local aliases so the rest of this file can use short names without cycles.
type AbilityId = GeneratedAbilityId;
type BodyId = GeneratedBodyId;
type ItemId = GeneratedItemId;

/**
 * Paper-doll / hand slots.
 * Includes armor slots not yet seeded in loadout authority (only main/off hand today).
 */
export type EquipSlot =
  | AuthorityEquipSlot
  | 'head'
  | 'chest'
  | 'arms'
  | 'legs'
  | 'feet'
  | 'back';

/** Utility / consumable attach slots (not exclusive against paper-doll). */
export type UtilitySlot = AuthorityUtilitySlot;

/** Any exclusive equipment attach id an item may declare. */
export type ItemSlot = EquipSlot | UtilitySlot;

/** Named attach point on the canonical skeleton. */
export type SocketId = 'right_hand' | 'left_hand' | 'spine_sheath' | (string & {});

export type Vec3 = readonly [number, number, number];

export type SocketBinding = {
  id: SocketId;
  /** Prefer list for Mixamo name variants. */
  boneNames: readonly string[];
  position: Vec3;
  rotation: Vec3;
  scale: number;
};

export type PlayerCosmetics = {
  skin?: string;
  hair?: string;
};

/**
 * Public-enough appearance to render local and remote avatars.
 * Server should eventually own bodyId, scale, and equipped item ids.
 */
export type PlayerAppearance = {
  bodyId: BodyId;
  /** 1.0 = reference adult height; authority capsule must track this. */
  scale: number;
  slots: Partial<Record<EquipSlot, ItemId>>;
  cosmetics?: PlayerCosmetics;
};

export type ItemAttachKind = 'skinned' | 'socket';

/**
 * Catalog row for a wearable or held item.
 * meshKey maps through AvatarCatalog to a runtime URL — never store URLs on the server tick path.
 */
export type ItemDef = {
  id: ItemId;
  /** Paper-doll equip slot or utility attach id from authority. */
  slot: ItemSlot;
  meshKey: string;
  attach: ItemAttachKind;
  /** Required when attach === 'socket'. */
  socketId?: SocketId;
  /** Optional object names inside a multi-mesh GLB (transitional packs only). */
  objectNames?: readonly string[];
  /** Ability ids granted while this item is equipped. */
  grants: readonly AbilityId[];
  normalizeHeight?: number;
  /** Local TRS override after socket defaults (weapons). */
  position?: Vec3;
  rotation?: Vec3;
  scale?: number;
  visibleByDefault?: boolean;
  /**
   * Grants-only placeholder: no mesh attach and no asset fetch.
   * Use until a real meshKey exists (e.g. transitional staff).
   */
  grantsOnly?: boolean;
};

export type BodyDef = {
  id: BodyId;
  meshKey: string;
  /** World-units height at scale 1.0 — drives normalize + capsule later. */
  referenceHeight: number;
  /** Vertical offset of the visual root under the gameplay capsule. */
  yOffset: number;
  footstepSounds?: {
    walk: SoundId;
    run: SoundId;
  };
};

/** Runtime AnimationMixer action key (matches ANIMATIONS.* values). */
export type AnimActionKey = string;

/**
 * One clip file (transitional) or a named clip inside a library GLB (Phase B).
 * meshKey is the asset to fetch; actionKey is how gameplay refers to it.
 */
export type ClipSource = {
  actionKey: AnimActionKey;
  meshKey: string;
  /** Upper-body overlay while locomoting (cast/slash). */
  upperBodyOnly?: boolean;
  /** Trim ends for clips like drinking (seconds). */
  trimStartSeconds?: number;
  trimEndSeconds?: number;
};

export type AnimLibraryDef = {
  locomotionMeshKey?: string;
  combatMeshKey?: string;
  clips: readonly ClipSource[];
};

export type WizardSpell = 'fireball' | 'lightning';

/** Derived presentation capabilities (Phase A; later purely from grants). */
export type AvatarCapabilities = {
  melee: boolean;
  block: boolean;
  spells: readonly WizardSpell[];
  drinkPotion: boolean;
};

/**
 * Character-select / join preset. Not a permanent combat class branch.
 * wizard/paladin are rows here, not mesh-pack identities.
 */
export type LoadoutPreset = {
  id: LoadoutPresetId;
  label: string;
  appearance: PlayerAppearance;
  /** Transitional per-preset clip files until shared anim library GLBs land. */
  clips: readonly ClipSource[];
  /** Explicit grants when items are not yet data-complete. */
  extraGrants?: readonly AbilityId[];
};

export type ResolvedBody = BodyDef & {
  url: string;
};

export type ResolvedItem = ItemDef & {
  url: string;
  socket?: SocketBinding;
};

export type ResolvedClip = ClipSource & {
  url: string;
};

export type ResolvedAppearance = {
  body: ResolvedBody;
  scale: number;
  equipped: readonly ResolvedItem[];
  grants: readonly AbilityId[];
  capabilities: AvatarCapabilities;
  clips: readonly ResolvedClip[];
  presetId?: LoadoutPresetId;
};

export type AvatarCatalog = {
  getBody(bodyId: BodyId): BodyDef | undefined;
  getItem(itemId: ItemId): ItemDef | undefined;
  getSocket(socketId: SocketId): SocketBinding | undefined;
  getPreset(presetId: string): LoadoutPreset | undefined;
  listPresets(): readonly LoadoutPreset[];
  /** meshKey → runtime URL (public/ CDN path). */
  urlForMeshKey(meshKey: string): string;
  resolve(
    appearance: PlayerAppearance,
    options?: {
      presetId?: LoadoutPresetId | string;
      /** Default true. Set false when equipment rows already include utility. */
      includePresetUtility?: boolean;
    },
  ): ResolvedAppearance;
};
