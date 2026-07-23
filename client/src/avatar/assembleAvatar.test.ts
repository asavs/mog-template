import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { assembleAvatar } from './assembleAvatar';
import type { ResolvedAppearance } from './types';

function emptyResolved(overrides: Partial<ResolvedAppearance> = {}): ResolvedAppearance {
  return {
    body: {
      id: 'body_m',
      meshKey: 'body.glb',
      referenceHeight: 2,
      yOffset: 0.85,
      url: '/body.glb',
    },
    scale: 1,
    equipped: [],
    grants: [],
    capabilities: { melee: false, block: false, spells: [], drinkPotion: false },
    clips: [],
    ...overrides,
  };
}

describe('assembleAvatar', () => {
  it('clones body onto the group and exposes dispose', async () => {
    const group = new THREE.Group();
    const source = new THREE.Group();
    source.name = 'body-source';
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial());
    source.add(mesh);

    const getModelSource = vi.fn(async () => source);
    const loadModel = vi.fn(async () => source.clone(true) as THREE.Group);
    const loadAnimations = vi.fn(async () => [] as const);

    const assembled = await assembleAvatar({
      resolved: emptyResolved(),
      loaders: { getModelSource, loadModel, loadAnimations },
      group,
      desiredEquipmentVisibility: new Map(),
      actionAnimationNames: {
        idle: 'idle',
        jump: 'jump',
        slash: 'slash',
        block: 'block',
        cast: 'cast',
        drinking: 'drinking',
        death: 'death',
      },
    });

    expect(getModelSource).toHaveBeenCalledWith('/body.glb');
    expect(group.children).toHaveLength(1);
    expect(assembled.root).toBe(group.children[0]);
    assembled.dispose();
    expect(group.children).toHaveLength(0);
  });

  it('attaches socket equipment by bone name', async () => {
    const group = new THREE.Group();
    const body = new THREE.Group();
    const hand = new THREE.Object3D();
    hand.name = 'mixamorigRightHand';
    body.add(hand);

    const weaponRoot = new THREE.Group();
    const sword = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 0.1), new THREE.MeshBasicMaterial());
    sword.name = 'One handed sword';
    weaponRoot.add(sword);

    const assembled = await assembleAvatar({
      resolved: emptyResolved({
        equipped: [
          {
            id: 'sword_1h',
            slot: 'main_hand',
            meshKey: 'sword.glb',
            attach: 'socket',
            socketId: 'right_hand',
            objectNames: ['One handed sword'],
            grants: ['melee_slash'],
            url: '/sword.glb',
            socket: {
              id: 'right_hand',
              boneNames: ['mixamorigRightHand'],
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: 1,
            },
          },
        ],
      }),
      loaders: {
        getModelSource: async () => body,
        loadModel: async () => weaponRoot.clone(true) as THREE.Group,
        loadAnimations: async () => [],
      },
      group,
      desiredEquipmentVisibility: new Map(),
      actionAnimationNames: {
        idle: 'idle',
        jump: 'jump',
        slash: 'slash',
        block: 'block',
        cast: 'cast',
        drinking: 'drinking',
        death: 'death',
      },
    });

    const swordObj = assembled.equipment.get('sword_1h');
    expect(swordObj).toBeDefined();
    // Attached to the *cloned* body's hand, not the source `hand` ref.
    expect(swordObj?.parent?.name).toBe('mixamorigRightHand');
    assembled.dispose();
  });
});
