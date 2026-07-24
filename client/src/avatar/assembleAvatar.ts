import type { MutableRefObject } from 'react';
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { configureAnimationPlayback } from '../components/playerAnimation';
import type { ResolvedAppearance, ResolvedItem } from './types';

export type AvatarLoaders = {
  loadModel: (url: string) => Promise<THREE.Group>;
  loadAnimations: (url: string) => Promise<readonly THREE.AnimationClip[]>;
  /** Shared source cache (do not clone here — assembler clones). */
  getModelSource: (url: string) => Promise<THREE.Group>;
};

export type AssembleAvatarOptions = {
  resolved: ResolvedAppearance;
  loaders: AvatarLoaders;
  group: THREE.Group;
  desiredEquipmentVisibility: Map<string, boolean>;
  actionAnimationNames: {
    idle: string;
    jump: string;
    slash: string;
    block: string;
    cast: string;
    drinking: string;
    death: string;
  };
  signal?: { disposed: boolean };
};

export type AssembledAvatar = {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  animations: Record<string, THREE.AnimationAction>;
  /** Mutable: partial equipment sync updates this map in place. */
  equipment: Map<string, THREE.Object3D>;
  dispose: () => void;
};

export type SyncAvatarEquipmentOptions = {
  assembled: AssembledAvatar;
  resolved: ResolvedAppearance;
  loaders: Pick<AvatarLoaders, 'loadModel'>;
  desiredEquipmentVisibility: Map<string, boolean>;
  signal?: { disposed: boolean };
};

/**
 * Build a playable avatar scene graph from a resolved catalog appearance.
 * Game code should not branch on class mesh packs — only pass ResolvedAppearance.
 */
export async function assembleAvatar(options: AssembleAvatarOptions): Promise<AssembledAvatar> {
  const {
    resolved,
    loaders,
    group,
    desiredEquipmentVisibility,
    actionAnimationNames,
    signal,
  } = options;

  const isDisposed = () => signal?.disposed === true;

  const bodySource = await loaders.getModelSource(resolved.body.url);
  if (isDisposed()) {
    throw new Error('Avatar assemble aborted');
  }

  const root = cloneSkeleton(bodySource) as THREE.Group;
  cloneObjectRenderResources(root);
  normalizeModelScale(root, resolved.body.referenceHeight * resolved.scale);
  root.position.y = resolved.body.yOffset;
  configureModelObject(root);
  group.add(root);

  const equipment = new Map<string, THREE.Object3D>();

  await attachResolvedEquipment({
    root,
    equipment,
    resolved,
    loadModel: loaders.loadModel,
    desiredEquipmentVisibility,
    isDisposed,
  });

  if (isDisposed()) {
    clearEquipmentMeshes(equipment);
    group.remove(root);
    disposeObjectMeshes(root);
    throw new Error('Avatar assemble aborted');
  }

  const mixer = new THREE.AnimationMixer(root);
  const animations: Record<string, THREE.AnimationAction> = {};

  await Promise.all(
    resolved.clips.map(async (clipSource) => {
      try {
        const animationClips = await loaders.loadAnimations(clipSource.url);
        if (isDisposed() || animationClips.length === 0) return;

        const sourceClip = animationClips[0].clone();
        const trimmed =
          clipSource.trimStartSeconds !== undefined || clipSource.trimEndSeconds !== undefined
            ? trimAnimationClipSeconds(
                sourceClip,
                clipSource.trimStartSeconds ?? 0,
                clipSource.trimEndSeconds ?? 0,
              )
            : sourceClip;
        const clip = makeAnimationInPlace(trimmed);
        const action = mixer.clipAction(clip);
        configureAnimationPlayback(clipSource.actionKey, action, actionAnimationNames);
        animations[clipSource.actionKey] = action;
      } catch (error) {
        console.warn(`Failed to load clip ${clipSource.actionKey}`, error);
      }
    }),
  );

  if (isDisposed()) {
    mixer.stopAllAction();
    mixer.uncacheRoot(mixer.getRoot());
    clearEquipmentMeshes(equipment);
    group.remove(root);
    disposeObjectMeshes(root);
    throw new Error('Avatar assemble aborted');
  }

  animations.idle?.play();

  return {
    root,
    mixer,
    animations,
    equipment,
    dispose: () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(mixer.getRoot());
      // Use the live equipment map so mid-session partial sync is cleaned up too.
      clearEquipmentMeshes(equipment);
      group.remove(root);
      disposeObjectMeshes(root);
    },
  };
}

/**
 * Equipment-only refresh: drop current gear meshes and attach the new set.
 * Does not reload body skeleton, re-scale, or rebind animation clips.
 * Mutates `assembled.equipment` in place.
 */
export async function syncAvatarEquipment(
  options: SyncAvatarEquipmentOptions,
): Promise<void> {
  const {
    assembled,
    resolved,
    loaders,
    desiredEquipmentVisibility,
    signal,
  } = options;

  const isDisposed = () => signal?.disposed === true;

  clearEquipmentMeshes(assembled.equipment);

  if (isDisposed()) {
    return;
  }

  await attachResolvedEquipment({
    root: assembled.root,
    equipment: assembled.equipment,
    resolved,
    loadModel: loaders.loadModel,
    desiredEquipmentVisibility,
    isDisposed,
  });

  if (isDisposed()) {
    clearEquipmentMeshes(assembled.equipment);
  }
}

async function attachResolvedEquipment(options: {
  root: THREE.Group;
  equipment: Map<string, THREE.Object3D>;
  resolved: ResolvedAppearance;
  loadModel: AvatarLoaders['loadModel'];
  desiredEquipmentVisibility: Map<string, boolean>;
  isDisposed: () => boolean;
}): Promise<void> {
  const {
    root,
    equipment,
    resolved,
    loadModel,
    desiredEquipmentVisibility,
    isDisposed,
  } = options;

  await Promise.all(
    resolved.equipped.map(async (item) => {
      if (item.attach !== 'socket' || !item.socket) return;
      // Grants-only placeholder — no mesh attach (see ItemDef.grantsOnly).
      if (item.grantsOnly) return;

      try {
        const assetRoot = await loadModel(item.url);
        if (isDisposed()) {
          disposeObjectMeshes(assetRoot);
          return;
        }

        const sourceWeapon = item.objectNames
          ? findObjectByNames(assetRoot, item.objectNames)
          : assetRoot;
        const targetBone = findObjectByNames(root, item.socket.boneNames);
        if (!sourceWeapon || !targetBone) {
          console.warn('Failed to attach equipment', {
            itemId: item.id,
            sourceWeapon: sourceWeapon?.name ?? null,
            targetBone: targetBone?.name ?? null,
            url: item.url,
          });
          disposeObjectMeshes(assetRoot);
          return;
        }

        sourceWeapon.parent?.remove(sourceWeapon);
        if (sourceWeapon !== assetRoot) {
          disposeObjectMeshes(assetRoot);
        }

        configureWeaponObject(sourceWeapon, item);
        sourceWeapon.visible =
          desiredEquipmentVisibility.get(item.id) ?? item.visibleByDefault ?? true;
        targetBone.add(sourceWeapon);
        equipment.set(item.id, sourceWeapon);
      } catch (error) {
        console.warn(`Failed to load equipment ${item.id}`, error);
      }
    }),
  );
}

function clearEquipmentMeshes(equipment: Map<string, THREE.Object3D>) {
  equipment.forEach(weapon => {
    disposeObjectMeshes(weapon);
    weapon.parent?.remove(weapon);
  });
  equipment.clear();
}

/** Preload all URLs for an appearance (body, gear, clips) into the model/anim caches. */
export async function preloadResolvedAppearance(
  resolved: ResolvedAppearance,
  loaders: Pick<AvatarLoaders, 'getModelSource' | 'loadAnimations'>,
  urls: readonly string[],
): Promise<void> {
  const unique = [...new Set(urls)];
  await Promise.all(
    unique.map(async (url) => {
      const isClip = resolved.clips.some(clip => clip.url === url);
      if (isClip) {
        await loaders.loadAnimations(url);
      } else {
        await loaders.getModelSource(url);
      }
    }),
  ).catch(error => {
    console.warn('Failed to preload avatar assets', error);
  });
}

export function normalizeModelScale(model: THREE.Object3D, targetHeight: number) {
  model.scale.setScalar(1);
  model.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(model);
  const height = bounds.getSize(new THREE.Vector3()).y;
  if (Number.isFinite(height) && height > 0.001) {
    model.scale.setScalar(targetHeight / height);
  }
}

export function findObjectByNames(root: THREE.Object3D, names: readonly string[]): THREE.Object3D | null {
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

function configureWeaponObject(weapon: THREE.Object3D, item: ResolvedItem) {
  const socket = item.socket;
  const position = item.position ?? socket?.position ?? [0, 0, 0];
  const rotation = item.rotation ?? socket?.rotation ?? [0, 0, 0];
  const scale = item.scale ?? socket?.scale ?? 1;

  if (item.normalizeHeight !== undefined) {
    normalizeModelScale(weapon, item.normalizeHeight);
    weapon.scale.multiplyScalar(scale);
  } else {
    weapon.scale.setScalar(scale);
  }
  weapon.position.set(...position);
  weapon.rotation.set(...rotation);
  weapon.visible = item.visibleByDefault ?? true;
  weapon.traverse(child => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
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

/** Test helper: abort signal ref pattern used by React effects. */
export type DisposeSignal = MutableRefObject<{ disposed: boolean }>;
