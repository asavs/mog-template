import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  clearPlayerModelAssetCacheForTests,
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
