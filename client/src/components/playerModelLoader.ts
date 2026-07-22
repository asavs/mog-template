import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  assembleAvatar,
  preloadResolvedAppearance,
} from '../avatar/assembleAvatar';
import {
  assetUrlsForAppearance,
  defaultAvatarCatalog,
  resolvePreset,
} from '../avatar/catalog';
import type { AvatarCatalog, ResolvedAppearance } from '../avatar/types';
import { ANIMATIONS } from './characterConfig';

THREE.Cache.enabled = true;

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
  /** Loadout preset id (wizard/paladin) or any catalog preset. */
  presetId: string;
  catalog?: AvatarCatalog;
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
  // SkeletonUtils clone for skinned meshes; plain clone is not enough for bones.
  const { clone: cloneSkeleton } = await import('three/examples/jsm/utils/SkeletonUtils.js');
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

export function clearPlayerModelAssetCacheForTests() {
  modelAssetCache.clear();
  animationAssetCache.clear();
}

/**
 * Preload assets for one preset only (not every class).
 * Prefer calling with the local player's chosen class at join time.
 */
export async function preloadPresetAssets(
  presetId: string,
  catalog: AvatarCatalog = defaultAvatarCatalog,
): Promise<void> {
  const resolved = resolvePreset(presetId, catalog);
  await preloadResolvedAppearance(
    resolved,
    {
      getModelSource: url => getOrLoadModelSource(url),
      loadAnimations: url => getOrLoadAnimations(url),
    },
    assetUrlsForAppearance(resolved),
  );
}

/** @deprecated Use preloadPresetAssets(presetId) — all-class preload is gone. */
export function preloadAllCharacterModelAssets() {
  // No-op on purpose: preloading every class was a primary cold-load / first-walk stall.
  // Call preloadPresetAssets for the selected preset instead.
}

export function loadPlayerModelAssets({
  actionAnimationNames,
  presetId,
  catalog = defaultAvatarCatalog,
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
  let disposed = false;
  let disposeAvatar: (() => void) | null = null;
  equipmentItemsRef.current.clear();

  onModelLoaded(false);
  onMixerLoaded(null);
  onAnimationsLoaded({});
  currentAnimationRef.current = ANIMATIONS.IDLE;
  lastPlayedAttackSeqRef.current = null;

  const group = groupRef.current;
  if (!group) {
    return () => {
      disposed = true;
    };
  }

  let resolved: ResolvedAppearance;
  try {
    resolved = resolvePreset(presetId, catalog);
  } catch (error) {
    console.warn(`Failed to resolve avatar preset ${presetId}`, error);
    return () => {
      disposed = true;
    };
  }

  void assembleAvatar({
    resolved,
    loaders: {
      loadModel: url => getOrLoadModel(url),
      loadAnimations: url => getOrLoadAnimations(url),
      getModelSource: url => getOrLoadModelSource(url),
    },
    group,
    desiredEquipmentVisibility: desiredEquipmentVisibilityRef.current,
    actionAnimationNames,
    signal: { get disposed() { return disposed; } },
  }).then((assembled) => {
    if (disposed) {
      assembled.dispose();
      return;
    }
    disposeAvatar = assembled.dispose;
    visualModelRef.current = assembled.root;
    equipmentItemsRef.current = assembled.equipment;
    onModelLoaded(true);
    onMixerLoaded(assembled.mixer);
    onAnimationsLoaded(assembled.animations);
  }).catch((error) => {
    if (!disposed) {
      console.warn(`Failed to assemble avatar preset ${presetId}`, error);
    }
  });

  return () => {
    disposed = true;
    visualModelRef.current = null;
    equipmentItemsRef.current.clear();
    disposeAvatar?.();
    disposeAvatar = null;
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
