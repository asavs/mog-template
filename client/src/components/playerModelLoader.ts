import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  assembleAvatar,
  preloadResolvedAppearance,
  syncAvatarEquipment,
  type AssembledAvatar,
} from '../avatar/assembleAvatar';
import {
  appearanceBodyClipsKey,
  appearanceEquipmentKey,
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
  /**
   * Fully resolved catalog appearance (prefer server appearance/equipment).
   * When omitted, `presetId` is used for legacy callers.
   */
  resolved?: ResolvedAppearance;
  /** Loadout preset id fallback when `resolved` is not provided. */
  presetId?: string;
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

export type PlayerModelBindingOptions = Omit<
  LoadPlayerModelAssetOptions,
  'resolved' | 'presetId'
> & {
  catalog?: AvatarCatalog;
};

/**
 * Long-lived binding that chooses full assemble vs equipment-only sync.
 * Call `applyResolved` whenever presentation changes; same body/clips/scale
 * with different gear only re-attaches equipment meshes.
 */
export type PlayerModelBinding = {
  applyResolved: (resolved: ResolvedAppearance) => void;
  dispose: () => void;
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

/**
 * Create a binding that can full-assemble or partial-sync equipment without
 * tearing down the body/mixer when only the equipped item set changes.
 */
export function createPlayerModelBinding(
  options: PlayerModelBindingOptions,
): PlayerModelBinding {
  const {
    actionAnimationNames,
    currentAnimationRef,
    desiredEquipmentVisibilityRef,
    equipmentItemsRef,
    groupRef,
    lastPlayedAttackSeqRef,
    onAnimationsLoaded,
    onMixerLoaded,
    onModelLoaded,
    visualModelRef,
  } = options;

  let disposed = false;
  let assembled: AssembledAvatar | null = null;
  let lastBodyClipsKey: string | null = null;
  let lastEquipmentKey: string | null = null;
  let applyGeneration = 0;

  const loaders = {
    loadModel: (url: string) => getOrLoadModel(url),
    loadAnimations: (url: string) => getOrLoadAnimations(url),
    getModelSource: (url: string) => getOrLoadModelSource(url),
  };

  function resetLoadedState() {
    equipmentItemsRef.current.clear();
    visualModelRef.current = null;
    onModelLoaded(false);
    onMixerLoaded(null);
    onAnimationsLoaded({});
    currentAnimationRef.current = ANIMATIONS.IDLE;
    lastPlayedAttackSeqRef.current = null;
  }

  function disposeAssembled() {
    assembled?.dispose();
    assembled = null;
    lastBodyClipsKey = null;
    lastEquipmentKey = null;
  }

  async function fullAssemble(resolved: ResolvedAppearance, gen: number) {
    const group = groupRef.current;
    if (!group) return;

    disposeAssembled();
    resetLoadedState();

    const label = resolved.presetId ?? resolved.body.id;
    try {
      const next = await assembleAvatar({
        resolved,
        loaders,
        group,
        desiredEquipmentVisibility: desiredEquipmentVisibilityRef.current,
        actionAnimationNames,
        signal: {
          get disposed() {
            return disposed || gen !== applyGeneration;
          },
        },
      });

      if (disposed || gen !== applyGeneration) {
        next.dispose();
        return;
      }

      assembled = next;
      lastBodyClipsKey = appearanceBodyClipsKey(resolved);
      lastEquipmentKey = appearanceEquipmentKey(resolved);
      visualModelRef.current = next.root;
      equipmentItemsRef.current = next.equipment;
      onModelLoaded(true);
      onMixerLoaded(next.mixer);
      onAnimationsLoaded(next.animations);
    } catch (error) {
      if (!disposed && gen === applyGeneration) {
        console.warn(`Failed to assemble avatar ${label}`, error);
      }
    }
  }

  async function partialEquipment(resolved: ResolvedAppearance, gen: number) {
    const current = assembled;
    if (!current) return;

    try {
      await syncAvatarEquipment({
        assembled: current,
        resolved,
        loaders,
        desiredEquipmentVisibility: desiredEquipmentVisibilityRef.current,
        signal: {
          get disposed() {
            return disposed || gen !== applyGeneration || assembled !== current;
          },
        },
      });

      if (disposed || gen !== applyGeneration || assembled !== current) {
        return;
      }

      // Map is mutated in place; keep ref pointed at the same instance.
      equipmentItemsRef.current = current.equipment;
      lastEquipmentKey = appearanceEquipmentKey(resolved);
    } catch (error) {
      if (!disposed && gen === applyGeneration) {
        console.warn('Failed to sync avatar equipment', error);
      }
    }
  }

  return {
    applyResolved(resolved: ResolvedAppearance) {
      if (disposed) return;

      const bodyKey = appearanceBodyClipsKey(resolved);
      const equipKey = appearanceEquipmentKey(resolved);

      if (assembled && lastBodyClipsKey === bodyKey) {
        if (lastEquipmentKey === equipKey) {
          return;
        }
        const gen = ++applyGeneration;
        void partialEquipment(resolved, gen);
        return;
      }

      const gen = ++applyGeneration;
      void fullAssemble(resolved, gen);
    },
    dispose() {
      disposed = true;
      applyGeneration += 1;
      disposeAssembled();
      visualModelRef.current = null;
      equipmentItemsRef.current.clear();
    },
  };
}

/**
 * One-shot full assemble (legacy callers / tests). Prefer `createPlayerModelBinding`
 * for live players so mid-session equip/unequip can partial-sync.
 */
export function loadPlayerModelAssets({
  actionAnimationNames,
  resolved: resolvedInput,
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
  let resolved: ResolvedAppearance | undefined;
  try {
    resolved = resolvedInput
      ?? resolvePreset(presetId ?? 'wizard', catalog);
  } catch (error) {
    console.warn(`Failed to resolve avatar (${presetId ?? 'resolved'})`, error);
    return () => {};
  }

  const binding = createPlayerModelBinding({
    actionAnimationNames,
    currentAnimationRef,
    desiredEquipmentVisibilityRef,
    equipmentItemsRef,
    groupRef,
    lastPlayedAttackSeqRef,
    onAnimationsLoaded,
    onMixerLoaded,
    onModelLoaded,
    visualModelRef,
    catalog,
  });
  binding.applyResolved(resolved);
  return () => binding.dispose();
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
