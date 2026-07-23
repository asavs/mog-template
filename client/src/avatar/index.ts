export type {
  AbilityId,
  AnimActionKey,
  AnimLibraryDef,
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
  appearanceFromPreset,
  assetUrlsForAppearance,
  capabilitiesFromGrants,
  createAvatarCatalog,
  defaultAvatarCatalog,
  presetIdFromLegacyClass,
  resolveFromServerState,
  resolvePreset,
} from './catalog';
export type { NetworkAppearanceRow, NetworkEquipmentRow } from './catalog';

export {
  assembleAvatar,
  findObjectByNames,
  normalizeModelScale,
  preloadResolvedAppearance,
} from './assembleAvatar';

export {
  boneNameCandidates,
  MOG_BONES,
  RIG_ID,
  SOCKET_BONE_CANDIDATES,
} from './rig';
export type { MogBoneId } from './rig';
