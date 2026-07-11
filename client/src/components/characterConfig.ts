import { publicAssetPath } from '../publicAssets';
import type { SoundId } from '../audio/soundRegistry';

// Footstep audio is per-character so classes/armor sets/genders can diverge later.
// Every current class shares this placeholder pair; override per config when a
// character needs its own footsteps (e.g. a heavier paladin step).
const SHARED_FOOTSTEP_SOUNDS = {
  walk: 'walk_footsteps',
  run: 'run_footsteps',
} as const satisfies Record<'walk' | 'run', SoundId>;

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
};

const POTION_MODEL_URL = publicAssetPath('models/items/red-potion.glb');
const DRINKING_ANIMATION_URL = publicAssetPath('models/animations/drinking.fbx');
export const DRINKING_ANIMATION_TRIM_START_SECONDS = 2.5;
export const DRINKING_ANIMATION_TRIM_END_SECONDS = 2.5;
const POTION_POSITION = [19, 7, 0] as const;
const POTION_ROTATION = [-1.5708, 0.1, 1.75] as const;
const POTION_SCALE = 122.5031;

// Potion drinking is a BASE capability shared by every class. Both models use
// `mixamorig*` bone names, so the same left-hand attachment/offsets work for all.
export const POTION_ATTACHMENT = {
  id: 'potion',
  assetPath: POTION_MODEL_URL,
  boneNames: ['mixamorigLeftHand', 'mixamorig:LeftHand', 'LeftHand'],
  position: POTION_POSITION,
  rotation: POTION_ROTATION,
  scale: POTION_SCALE,
  normalizeHeight: 0.28,
  visibleByDefault: false,
} as const;

export type WizardSpell = 'fireball' | 'lightning';

export const CHARACTER_CONFIGS = {
  paladin: {
    modelPath: publicAssetPath('models/paladin/paladin.fbx'),
    animationPath: (name: string) =>
      name === 'drinking'
        ? DRINKING_ANIMATION_URL
        : publicAssetPath(`models/paladin/paladin-${name}.fbx`),
    animationNames: [
      'idle',
      'walk-forward',
      'walk-back',
      'walk-left',
      'walk-right',
      'run-forward',
      'run-back',
      'run-left',
      'run-right',
      'jump',
      'slash',
      'block',
      'death',
      'drinking',
    ],
    targetHeight: 2.0,
    yOffset: 0.85,
    capabilities: {
      melee: true,
      block: true,
      spells: [] as WizardSpell[],
      drinkPotion: true,
    },
    weaponAttachments: [
      {
        id: 'sword',
        assetPath: publicAssetPath('models/weapons/low_poly_weapons_pack_rigged_blender.glb'),
        objectNames: ['Baked one handed sword', 'One handed sword'],
        boneNames: ['mixamorigRightHand', 'mixamorig:RightHand', 'RightHand'],
        position: [0, 0.1, 0.07],
        rotation: [1.05, 0.4708, 4.3],
        scale: 1.85,
      },
      {
        id: 'shield',
        assetPath: publicAssetPath('models/weapons/low_poly_weapons_pack_rigged_blender.glb'),
        objectNames: ['Baked shield 1', 'Shield 1'],
        boneNames: ['mixamorigLeftHand', 'mixamorig:LeftHand', 'LeftHand'],
        position: [0.01, 0.21, -0.08],
        rotation: [4.45, 3.3792, -0.3],
        scale: 0.57,
      },
      POTION_ATTACHMENT,
    ],
    footstepSounds: SHARED_FOOTSTEP_SOUNDS,
  },
  wizard: {
    modelPath: publicAssetPath('models/wizard2/wizard2.fbx'),
    animationPath: (name: string) => {
      const files: Record<string, string> = {
        idle: 'wizard2-idle.fbx',
        'walk-forward': 'wizard2-walk-forward.fbx',
        'walk-back': 'wizard2-walk-back.fbx',
        'walk-left': 'wizard2-walk-left.fbx',
        'walk-right': 'wizard2-walk-right.fbx',
        'run-forward': 'wizard2-run-forward.fbx',
        'run-back': 'wizard2-run-back.fbx',
        'run-left': 'wizard2-run-left.fbx',
        'run-right': 'wizard2-run-right.fbx',
        jump: 'wizard2-jump.fbx',
        '1h-magic-attack-01': 'wizard2-magic-attack.fbx',
      };
      return name === 'drinking'
        ? DRINKING_ANIMATION_URL
        : publicAssetPath(`models/wizard2/${files[name] ?? files.idle}`);
    },
    animationNames: [
      'idle',
      'walk-forward',
      'walk-back',
      'walk-left',
      'walk-right',
      'run-forward',
      'run-back',
      'run-left',
      'run-right',
      'jump',
      '1h-magic-attack-01',
      'drinking',
    ],
    targetHeight: 2.0,
    yOffset: 0.85,
    capabilities: {
      melee: false,
      block: false,
      spells: ['fireball', 'lightning'] as WizardSpell[],
      drinkPotion: true,
    },
    weaponAttachments: [POTION_ATTACHMENT],
    footstepSounds: SHARED_FOOTSTEP_SOUNDS,
  },
} as const;

export type CharacterConfigKey = keyof typeof CHARACTER_CONFIGS;

export type CharacterConfig = (typeof CHARACTER_CONFIGS)[CharacterConfigKey];

export type ClassCapabilities = CharacterConfig['capabilities'];

export type NormalizedCharacterClass = CharacterConfigKey;

// Single copy of the legacy class remap table on the client. Remote players'
// DB rows may still carry legacy values until they rejoin, and localStorage may
// hold a legacy stored class; normalize both through here.
export function normalizeCharacterClass(
  characterClass: string | null | undefined,
): NormalizedCharacterClass {
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

export function getCharacterConfig(characterClass: string | undefined): CharacterConfig {
  return CHARACTER_CONFIGS[normalizeCharacterClass(characterClass)];
}

export function getCharacterCapabilities(characterClass: string | undefined): ClassCapabilities {
  return getCharacterConfig(characterClass).capabilities;
}

export function getAllCharacterConfigs(): readonly CharacterConfig[] {
  return Object.values(CHARACTER_CONFIGS);
}

