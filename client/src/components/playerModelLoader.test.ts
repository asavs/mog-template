import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import * as assembleModule from '../avatar/assembleAvatar';
import { resolvePreset } from '../avatar/catalog';
import type { AssembledAvatar } from '../avatar/assembleAvatar';
import {
  clearPlayerModelAssetCacheForTests,
  createPlayerModelBinding,
  getOrLoadAnimations,
  getOrLoadModel,
} from './playerModelLoader';

describe('player model asset cache', () => {
  beforeEach(() => {
    clearPlayerModelAssetCacheForTests();
  });

  it('loads a model URL once and returns distinct cloned instances', async () => {
    let loadCount = 0;
    const source = new THREE.Group();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 'red' }),
    );
    source.add(mesh);

    const loadModel = async () => {
      loadCount += 1;
      return source;
    };

    const [first, second] = await Promise.all([
      getOrLoadModel('/models/shared.fbx', loadModel),
      getOrLoadModel('/models/shared.fbx', loadModel),
    ]);

    expect(loadCount).toBe(1);
    expect(first).not.toBe(second);
    expect(first).not.toBe(source);
    expect(first.children[0]).not.toBe(second.children[0]);
    expect((first.children[0] as THREE.Mesh).geometry).not.toBe((second.children[0] as THREE.Mesh).geometry);
  });

  it('loads animation clips once and shares cached clip data', async () => {
    let loadCount = 0;
    const clip = new THREE.AnimationClip('idle', 1, []);
    const loadAnimations = async () => {
      loadCount += 1;
      return [clip] as const;
    };

    const [first, second] = await Promise.all([
      getOrLoadAnimations('/models/idle.fbx', loadAnimations),
      getOrLoadAnimations('/models/idle.fbx', loadAnimations),
    ]);

    expect(loadCount).toBe(1);
    expect(first).toBe(second);
    expect(first[0]).toBe(clip);
  });
});

describe('createPlayerModelBinding partial reassemble', () => {
  beforeEach(() => {
    clearPlayerModelAssetCacheForTests();
    vi.restoreAllMocks();
  });

  function makeAssembled(): AssembledAvatar {
    const root = new THREE.Group();
    const equipment = new Map<string, THREE.Object3D>();
    return {
      root,
      mixer: new THREE.AnimationMixer(root),
      animations: {},
      equipment,
      dispose: vi.fn(() => {
        equipment.clear();
      }),
    };
  }

  function bindingHarness() {
    const group = new THREE.Group();
    const groupRef = { current: group };
    const visualModelRef = { current: null as THREE.Group | null };
    const equipmentItemsRef = { current: new Map<string, THREE.Object3D>() };
    const desiredEquipmentVisibilityRef = { current: new Map<string, boolean>() };
    const currentAnimationRef = { current: 'idle' };
    const lastPlayedAttackSeqRef = { current: null as number | null };
    const onModelLoaded = vi.fn();
    const onMixerLoaded = vi.fn();
    const onAnimationsLoaded = vi.fn();

    const binding = createPlayerModelBinding({
      actionAnimationNames: {
        idle: 'idle',
        jump: 'jump',
        slash: 'slash',
        block: 'block',
        cast: 'cast',
        drinking: 'drinking',
        death: 'death',
      },
      currentAnimationRef,
      desiredEquipmentVisibilityRef,
      equipmentItemsRef,
      groupRef,
      lastPlayedAttackSeqRef,
      onAnimationsLoaded,
      onMixerLoaded,
      onModelLoaded,
      visualModelRef,
    });

    return { binding, onModelLoaded, equipmentItemsRef, visualModelRef };
  }

  it('uses equipment-only sync when body/clips are unchanged', async () => {
    const assembled = makeAssembled();
    const assembleSpy = vi
      .spyOn(assembleModule, 'assembleAvatar')
      .mockResolvedValue(assembled);
    const syncSpy = vi
      .spyOn(assembleModule, 'syncAvatarEquipment')
      .mockResolvedValue(undefined);

    const { binding } = bindingHarness();
    const paladin = resolvePreset('paladin');
    const unequippedMain = {
      ...paladin,
      equipped: paladin.equipped.filter(item => item.slot !== 'main_hand'),
      grants: paladin.grants.filter(g => g !== 'melee_slash'),
      capabilities: { ...paladin.capabilities, melee: false },
    };

    binding.applyResolved(paladin);
    await vi.waitFor(() => expect(assembleSpy).toHaveBeenCalledTimes(1));

    binding.applyResolved(unequippedMain);
    await vi.waitFor(() => expect(syncSpy).toHaveBeenCalledTimes(1));

    expect(assembleSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        assembled,
        resolved: unequippedMain,
      }),
    );

    binding.dispose();
  });

  it('full-assembles again when body/scale/clips identity changes', async () => {
    const first = makeAssembled();
    const second = makeAssembled();
    const assembleSpy = vi
      .spyOn(assembleModule, 'assembleAvatar')
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const syncSpy = vi
      .spyOn(assembleModule, 'syncAvatarEquipment')
      .mockResolvedValue(undefined);

    const { binding } = bindingHarness();
    const paladin = resolvePreset('paladin');
    const wizard = resolvePreset('wizard');

    binding.applyResolved(paladin);
    await vi.waitFor(() => expect(assembleSpy).toHaveBeenCalledTimes(1));

    binding.applyResolved(wizard);
    await vi.waitFor(() => expect(assembleSpy).toHaveBeenCalledTimes(2));

    expect(syncSpy).not.toHaveBeenCalled();
    expect(first.dispose).toHaveBeenCalled();

    binding.dispose();
  });
});
