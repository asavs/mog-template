import { publicAssetPath } from '../publicAssets';

export type SoundId =
  | 'walk_footsteps'
  | 'run_footsteps'
  | 'fireball_cast_1'
  | 'fireball_cast_2'
  | 'fireball_cast_3'
  | 'lightning_strike'
  | 'potion_drinking';

export type SoundConfig = {
  url: string;
  volume: number;
  worldVolume?: number;
  refDistance?: number;
  maxDistance?: number;
  rolloffFactor?: number;
  distanceModel?: DistanceModelType;
};

export const SOUND_REGISTRY: Record<SoundId, SoundConfig> = {
  walk_footsteps: {
    url: publicAssetPath('audio/footsteps/female-footsteps-walking.mp3'),
    volume: 0.38,
    worldVolume: 1.25,
    refDistance: 1.5,
    maxDistance: 16,
    rolloffFactor: 2,
    distanceModel: 'inverse',
  },
  run_footsteps: {
    url: publicAssetPath('audio/footsteps/female-footsteps-running.mp3'),
    volume: 0.42,
    worldVolume: 1.4,
    refDistance: 1.8,
    maxDistance: 20,
    rolloffFactor: 2,
    distanceModel: 'inverse',
  },
  fireball_cast_1: {
    url: publicAssetPath('audio/spells/fireball-basic-attack-1.mp3'),
    volume: 2.8,
    refDistance: 3,
    maxDistance: 35,
    rolloffFactor: 1.2,
    distanceModel: 'inverse',
  },
  fireball_cast_2: {
    url: publicAssetPath('audio/spells/fireball-basic-attack-2.mp3'),
    volume: 2.8,
    refDistance: 3,
    maxDistance: 35,
    rolloffFactor: 1.2,
    distanceModel: 'inverse',
  },
  fireball_cast_3: {
    url: publicAssetPath('audio/spells/fireball-basic-attack-3.mp3'),
    volume: 2.8,
    refDistance: 3,
    maxDistance: 35,
    rolloffFactor: 1.2,
    distanceModel: 'inverse',
  },
  lightning_strike: {
    url: publicAssetPath('audio/spells/lightning-strike.mp3'),
    volume: 2.65,
    refDistance: 5,
    maxDistance: 60,
    rolloffFactor: 1,
    distanceModel: 'inverse',
  },
  potion_drinking: {
    url: publicAssetPath('audio/items/potion-drinking.mp3'),
    volume: 0.8,
  },
};
