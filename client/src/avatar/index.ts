export type {
  AbilityId,
  AnimActionKey,
  AnimLibraryDef,
  AuthorityEquipSlot,
  AvatarCapabilities,
  AvatarCatalog,
  BodyDef,
  BodyId,
  ClipSource,
  EquipSlot,
  ItemAttachKind,
  ItemDef,
  ItemId,
  LoadoutPreset,
  LoadoutPresetId,
  PlayerAppearance,
  PlayerCosmetics,
  ResolvedAppearance,
  ResolvedBody,
  ResolvedClip,
  ResolvedItem,
  SocketBinding,
  SocketId,
  Vec3,
  WizardSpell,
} from './types';
export {
  ABILITY_IDS,
  AUTHORITY_EQUIP_SLOTS,
  BODY_IDS,
  DEFAULT_PRESET_ID,
  ITEM_IDS,
  LOADOUT_PRESET_IDS,
  isAbilityId,
  isBodyId,
  isItemId,
  isLoadoutPresetId,
} from './types';

export {
  appearanceBodyClipsKey,
  appearanceEquipmentKey,
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
export type { NetworkAppearanceRow, NetworkEquipmentRow } from './catalog';

export {
  SERVER_LOADOUT_IDS,
  collectCatalogLoadoutIds,
} from './loadoutParity';

export {
  assembleAvatar,
  findObjectByNames,
  normalizeModelScale,
  preloadResolvedAppearance,
  syncAvatarEquipment,
} from './assembleAvatar';
export type { AssembledAvatar, AvatarLoaders, SyncAvatarEquipmentOptions } from './assembleAvatar';

export {
  boneNameCandidates,
  MOG_BONES,
  RIG_ID,
  SOCKET_BONE_CANDIDATES,
} from './rig';
export type { MogBoneId } from './rig';
