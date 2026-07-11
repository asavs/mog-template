import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { configureAnimationPlayback } from './playerAnimation';
import {
  ANIMATIONS,
  DRINKING_ANIMATION_TRIM_END_SECONDS,
  DRINKING_ANIMATION_TRIM_START_SECONDS,
  getAllCharacterConfigs,
  type CharacterConfig,
} from './characterConfig';

THREE.Cache.enabled = true;
type WeaponAttachmentConfig = {
  id: string;
  assetPath: string;
  objectNames?: readonly string[];
  boneNames: readonly string[];
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
  scale: number;
  normalizeHeight?: number;
  visibleByDefault?: boolean;
};

export type LoadPlayerModelAssetOptions = {
  actionAnimationNames: {
    idle: string;
    jump: string;
    slash: string;
    block: string;
    cast: string;
    drinking: string;
    death: string;
  };
  characterConfig: CharacterConfig;
  currentAnimationRef: MutableRefObject<string>;
  desiredEquipmentVisibilityRef: MutableRefObject<Map<string, boolean>>;
  equipmentItemsRef: MutableRefObject<Map<string, THREE.Object3D>>;
  groupRef: MutableRefObject<THREE.Group>;
  lastPlayedAttackSeqRef: MutableRefObject<number | null>;
  onAnimationsLoaded: (animations: Record<string, THREE.AnimationAction>) => void;
  onMixerLoaded: (mixer: THREE.AnimationMixer | null) => void;
  onModelLoaded: (loaded: boolean) => void;
  visualModelRef: MutableRefObject<THREE.Group | null>;
};

type ModelAssetLoader = (url: string) => Promise<THREE.Group>;
type AnimationAssetLoader = (url: string) => Promise<readonly THREE.AnimationClip[]>;

const modelAssetCache = new Map<string, Promise<THREE.Group>>();
const animationAssetCache = new Map<string, Promise<readonly THREE.AnimationClip[]>>();

export async function getOrLoadModel(
  url: string,
  loadModel: ModelAssetLoader = loadModelAsset,
): Promise<THREE.Group> {
  const source = await getOrLoadModelSource(url, loadModel);
  const model = cloneSkeleton(source) as THREE.Group;
  cloneObjectRenderResources(model);
  return model;
}

export async function getOrLoadAnimations(
  url: string,
  loadAnimations: AnimationAssetLoader = loadAnimationAsset,
): Promise<readonly THREE.AnimationClip[]> {
  let promise = animationAssetCache.get(url);
  if (!promise) {
    promise = loadAnimations(url).catch(error => {
      animationAssetCache.delete(url);
      throw error;
    });
    animationAssetCache.set(url, promise);
  }
  return promise;
}

export function preloadAllCharacterModelAssets() {
  getAllCharacterConfigs().forEach(characterConfig => {
    void preloadCharacterModelAssets(characterConfig);
  });
}

export function clearPlayerModelAssetCacheForTests() {
  modelAssetCache.clear();
  animationAssetCache.clear();
}

export function loadPlayerModelAssets({
  actionAnimationNames,
  characterConfig,
  currentAnimationRef,
  desiredEquipmentVisibilityRef,
  equipmentItemsRef,
  groupRef,
  lastPlayedAttackSeqRef,
  onAnimationsLoaded,
  onMixerLoaded,
  onModelLoaded,
  visualModelRef,
}: LoadPlayerModelAssetOptions) {
  const { modelPath, animationPath, animationNames, targetHeight, yOffset } = characterConfig;
  let disposed = false;
  let loadedModel: THREE.Group | null = null;
  let loadedMixer: THREE.AnimationMixer | null = null;
  const loadedWeapons: THREE.Object3D[] = [];
  equipmentItemsRef.current.clear();

  onModelLoaded(false);
  onMixerLoaded(null);
  onAnimationsLoaded({});
  currentAnimationRef.current = ANIMATIONS.IDLE;
  lastPlayedAttackSeqRef.current = null;

  getOrLoadModel(modelPath).then((fbx) => {
    if (disposed) {
      disposeObjectMeshes(fbx);
      return;
    }

    normalizeModelScale(fbx, targetHeight);
    fbx.position.y = yOffset;
    visualModelRef.current = fbx;
    configureModelObject(fbx);

    loadedModel = fbx;
    groupRef.current?.add(fbx);
    onModelLoaded(true);

    const equipmentAttachments = characterConfig.weaponAttachments as readonly WeaponAttachmentConfig[] | undefined;
    equipmentAttachments?.forEach((attachment) => {
      getOrLoadModel(attachment.assetPath).then((assetRoot) => {
        if (disposed) {
          disposeObjectMeshes(assetRoot);
          return;
        }

        const sourceWeapon = attachment.objectNames
          ? findObjectByNames(assetRoot, attachment.objectNames)
          : assetRoot;
        const targetBone = findObjectByNames(fbx, attachment.boneNames);
        if (!sourceWeapon || !targetBone) {
          console.warn('Failed to attach player equipment', {
            sourceWeapon: sourceWeapon?.name ?? null,
            targetBone: targetBone?.name ?? null,
            assetPath: attachment.assetPath,
          });
          disposeObjectMeshes(assetRoot);
          return;
        }

        sourceWeapon.parent?.remove(sourceWeapon);
        if (sourceWeapon !== assetRoot) {
          disposeObjectMeshes(assetRoot);
        }

        const weapon = sourceWeapon;
        configureWeaponObject(weapon, attachment);
        weapon.visible = desiredEquipmentVisibilityRef.current.get(attachment.id) ?? weapon.visible;
        targetBone.add(weapon);
        loadedWeapons.push(weapon);
        equipmentItemsRef.current.set(attachment.id, weapon);
      }).catch((error) => {
        console.warn(`Failed to load ${attachment.assetPath}`, error);
      });
    });

    const nextMixer = new THREE.AnimationMixer(fbx);
    loadedMixer = nextMixer;
    onMixerLoaded(nextMixer);

    const loadedAnims: Record<string, THREE.AnimationAction> = {};
    let loadedCount = 0;
    const markAnimationAttempted = () => {
      loadedCount += 1;
      if (loadedCount === animationNames.length) {
        onAnimationsLoaded(loadedAnims);
        loadedAnims[ANIMATIONS.IDLE]?.play();
      }
    };

    animationNames.forEach(name => {
      const animationUrl = animationPath(name);
      getOrLoadAnimations(animationUrl).then((animationClips) => {
        if (disposed) return;

        if (animationClips.length === 0) {
          markAnimationAttempted();
          return;
        }

        const key = animationKeyForAssetName(name);
        const sourceClip = animationClips[0].clone();
        const trimmedClip = key === ANIMATIONS.DRINKING
          ? trimAnimationClipSeconds(
              sourceClip,
              DRINKING_ANIMATION_TRIM_START_SECONDS,
              DRINKING_ANIMATION_TRIM_END_SECONDS,
            )
          : sourceClip;
        const clip = makeAnimationInPlace(trimmedClip);
        const action = nextMixer.clipAction(clip);
        configureAnimationPlayback(key, action, actionAnimationNames);
        loadedAnims[key] = action;

        markAnimationAttempted();
      }).catch((error) => {
        console.warn(`Failed to load ${animationUrl}`, error);
        if (!disposed) {
          markAnimationAttempted();
        }
      });
    });
  }).catch((error) => {
    console.warn(`Failed to load ${modelPath}`, error);
  });

  const currentGroup = groupRef.current;
  return () => {
    disposed = true;
    visualModelRef.current = null;
    equipmentItemsRef.current.clear();
    if (loadedMixer) {
      loadedMixer.stopAllAction();
      loadedMixer.uncacheRoot(loadedMixer.getRoot());
    }
    if (loadedModel) {
      loadedWeapons.forEach(weapon => {
        disposeObjectMeshes(weapon);
        weapon.parent?.remove(weapon);
      });
      currentGroup?.remove(loadedModel);
      disposeObjectMeshes(loadedModel);
    }
  };
}

export function getOrLoadModelSource(
  url: string,
  loadModel: ModelAssetLoader = loadModelAsset,
): Promise<THREE.Group> {
  let promise = modelAssetCache.get(url);
  if (!promise) {
    promise = loadModel(url).catch(error => {
      modelAssetCache.delete(url);
      throw error;
    });
    modelAssetCache.set(url, promise);
  }
  return promise;
}

export async function preloadCharacterModelAssets(characterConfig: CharacterConfig) {
  const loads: Promise<unknown>[] = [
    getOrLoadModelSource(characterConfig.modelPath),
    ...characterConfig.animationNames.map(name => getOrLoadAnimations(characterConfig.animationPath(name))),
  ];

  characterConfig.weaponAttachments?.forEach(attachment => {
    loads.push(getOrLoadModelSource(attachment.assetPath));
  });

  await Promise.all(loads).catch(error => {
    console.warn('Failed to preload character assets', error);
  });
}

export function loadModelAsset(url: string): Promise<THREE.Group> {
  if (url.toLowerCase().endsWith('.glb') || url.toLowerCase().endsWith('.gltf')) {
    return new Promise((resolve, reject) => {
      new GLTFLoader().load(url, gltf => resolve(gltf.scene), undefined, reject);
    });
  }

  return new Promise((resolve, reject) => {
    new FBXLoader().load(url, resolve, undefined, reject);
  });
}

export function loadAnimationAsset(url: string): Promise<readonly THREE.AnimationClip[]> {
  return new Promise((resolve, reject) => {
    new FBXLoader().load(url, fbx => {
      const clips = fbx.animations.map(clip => clip.clone());
      disposeObjectMeshes(fbx);
      resolve(clips);
    }, undefined, reject);
  });
}

function animationKeyForAssetName(name: string) {
  return name === 'walk-forward' ? ANIMATIONS.WALK :
    name === 'walk-back' ? ANIMATIONS.WALK_BACK :
    name === 'walk-left' ? ANIMATIONS.WALK_LEFT :
    name === 'walk-right' ? ANIMATIONS.WALK_RIGHT :
    name === 'run-forward' ? ANIMATIONS.RUN :
    name === 'run-back' ? ANIMATIONS.RUN_BACK :
    name === 'run-left' ? ANIMATIONS.RUN_LEFT :
    name === 'run-right' ? ANIMATIONS.RUN_RIGHT :
    name === 'jump' ? ANIMATIONS.JUMP :
    name === 'slash' ? ANIMATIONS.SLASH :
    name === 'block' ? ANIMATIONS.BLOCK :
    name === '1h-magic-attack-01' ? ANIMATIONS.CAST :
    name === 'drinking' ? ANIMATIONS.DRINKING :
    name.includes('death') ? ANIMATIONS.DEATH :
    ANIMATIONS.IDLE;
}

function makeAnimationInPlace(clip: THREE.AnimationClip): THREE.AnimationClip {
  const positionTracks = clip.tracks.filter(track => track.name.endsWith('.position'));
  if (positionTracks.length === 0) return clip;

  const rootNames = ['Hips.position', 'mixamorigHips.position', 'root.position', 'Armature.position', 'Root.position'];
  const rootTrack = positionTracks.find(track =>
    rootNames.some(name => track.name.toLowerCase().includes(name.toLowerCase())),
  ) ?? positionTracks[0];

  const rootTrackBaseName = rootTrack.name.slice(0, rootTrack.name.length - '.position'.length);
  clip.tracks = clip.tracks.filter(track => track.name !== `${rootTrackBaseName}.position`);
  return clip;
}

function trimAnimationClipSeconds(
  clip: THREE.AnimationClip,
  trimStartSeconds: number,
  trimEndSeconds: number,
): THREE.AnimationClip {
  const start = THREE.MathUtils.clamp(trimStartSeconds, 0, clip.duration);
  const end = THREE.MathUtils.clamp(clip.duration - trimEndSeconds, start, clip.duration);
  if (end <= start) {
    console.warn('Animation trim removed the entire clip; using the original clip', {
      clip: clip.name,
      duration: clip.duration,
      trimStartSeconds,
      trimEndSeconds,
    });
    return clip;
  }

  const tracks = clip.tracks
    .map(track => {
      const trimmedTrack = track.clone();
      trimmedTrack.trim(start, end);
      trimmedTrack.shift(-start);
      return trimmedTrack;
    })
    .filter(track => track.times.length > 0);
  if (tracks.length === 0) {
    console.warn('Animation trim removed all tracks; using the original clip', {
      clip: clip.name,
      duration: clip.duration,
      trimStartSeconds,
      trimEndSeconds,
    });
    return clip;
  }
  return new THREE.AnimationClip(clip.name, end - start, tracks, clip.blendMode);
}

function normalizeModelScale(model: THREE.Object3D, targetHeight: number) {
  model.scale.setScalar(1);
  model.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(model);
  const height = bounds.getSize(new THREE.Vector3()).y;
  if (Number.isFinite(height) && height > 0.001) {
    model.scale.setScalar(targetHeight / height);
  }
}

function configureModelObject(model: THREE.Group) {
  model.traverse(child => {
    if (child instanceof THREE.Light) {
      child.visible = false;
    }
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

function findObjectByNames(root: THREE.Object3D, names: readonly string[]): THREE.Object3D | null {
  for (const name of names) {
    const exactMatch = root.getObjectByName(name);
    if (exactMatch) return exactMatch;
  }

  const normalizedNames = names.map(normalizeObjectName);
  for (const normalizedName of normalizedNames) {
    let partialMatch: THREE.Object3D | null = null;
    root.traverse(child => {
      if (partialMatch) return;
      if (normalizeObjectName(child.name).includes(normalizedName)) {
        partialMatch = child;
      }
    });

    if (partialMatch) return partialMatch;
  }

  return null;
}

function normalizeObjectName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function configureWeaponObject(
  weapon: THREE.Object3D,
  attachment: WeaponAttachmentConfig,
) {
  if (attachment.normalizeHeight !== undefined) {
    normalizeModelScale(weapon, attachment.normalizeHeight);
    weapon.scale.multiplyScalar(attachment.scale);
  } else {
    weapon.scale.setScalar(attachment.scale);
  }
  weapon.position.set(...attachment.position);
  weapon.rotation.set(...attachment.rotation);
  weapon.visible = attachment.visibleByDefault ?? true;
  weapon.traverse(child => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

function cloneObjectRenderResources(root: THREE.Object3D) {
  root.traverse(child => {
    if (child instanceof THREE.Mesh) {
      child.geometry = child.geometry.clone();
      if (Array.isArray(child.material)) {
        child.material = child.material.map(material => material.clone());
      } else {
        child.material = child.material.clone();
      }
    }
  });
}

function disposeObjectMeshes(root: THREE.Object3D) {
  root.traverse(child => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach(m => m.dispose());
      } else {
        child.material.dispose();
      }
    }
  });
}
