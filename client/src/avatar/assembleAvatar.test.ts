import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { assembleAvatar, syncAvatarEquipment } from './assembleAvatar';
import type { ResolvedAppearance, ResolvedItem } from './types';

const ACTION_ANIMATION_NAMES = {
  idle: 'idle',
  jump: 'jump',
  slash: 'slash',
  block: 'block',
  cast: 'cast',
  drinking: 'drinking',
  death: 'death',
} as const;

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

function socketItem(overrides: Partial<ResolvedItem> & Pick<ResolvedItem, 'id' | 'url' | 'meshKey'>): ResolvedItem {
  return {
    slot: 'main_hand',
    attach: 'socket',
    socketId: 'right_hand',
    grants: ['melee_slash'],
    objectNames: undefined,
    socket: {
      id: 'right_hand',
      boneNames: ['mixamorigRightHand'],
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: 1,
    },
    ...overrides,
  };
}

function makeBodyWithHand(): THREE.Group {
  const body = new THREE.Group();
  const hand = new THREE.Object3D();
  hand.name = 'mixamorigRightHand';
  body.add(hand);
  return body;
}

function makeWeaponRoot(name: string): THREE.Group {
  const weaponRoot = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1, 0.1), new THREE.MeshBasicMaterial());
  mesh.name = name;
  weaponRoot.add(mesh);
  return weaponRoot;
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
      actionAnimationNames: ACTION_ANIMATION_NAMES,
    });

    expect(getModelSource).toHaveBeenCalledWith('/body.glb');
    expect(group.children).toHaveLength(1);
    expect(assembled.root).toBe(group.children[0]);
    assembled.dispose();
    expect(group.children).toHaveLength(0);
  });

  it('attaches socket equipment by bone name', async () => {
    const group = new THREE.Group();
    const body = makeBodyWithHand();
    const weaponRoot = makeWeaponRoot('One handed sword');

    const assembled = await assembleAvatar({
      resolved: emptyResolved({
        equipped: [
          socketItem({
            id: 'sword_1h',
            meshKey: 'sword.glb',
            url: '/sword.glb',
            objectNames: ['One handed sword'],
          }),
        ],
      }),
      loaders: {
        getModelSource: async () => body,
        loadModel: async () => weaponRoot.clone(true) as THREE.Group,
        loadAnimations: async () => [],
      },
      group,
      desiredEquipmentVisibility: new Map(),
      actionAnimationNames: ACTION_ANIMATION_NAMES,
    });

    const swordObj = assembled.equipment.get('sword_1h');
    expect(swordObj).toBeDefined();
    // Attached to the *cloned* body's hand, not the source `hand` ref.
    expect(swordObj?.parent?.name).toBe('mixamorigRightHand');
    assembled.dispose();
  });

  it('skips mesh attach for grantsOnly items', async () => {
    const group = new THREE.Group();
    const body = makeBodyWithHand();
    const loadModel = vi.fn(async () => makeWeaponRoot('staff'));

    const assembled = await assembleAvatar({
      resolved: emptyResolved({
        equipped: [
          socketItem({
            id: 'staff',
            meshKey: 'staff.fbx',
            url: '/staff.fbx',
            grantsOnly: true,
            grants: ['cast_fireball'],
          }),
        ],
      }),
      loaders: {
        getModelSource: async () => body,
        loadModel,
        loadAnimations: async () => [],
      },
      group,
      desiredEquipmentVisibility: new Map(),
      actionAnimationNames: ACTION_ANIMATION_NAMES,
    });

    expect(loadModel).not.toHaveBeenCalled();
    expect(assembled.equipment.size).toBe(0);
    assembled.dispose();
  });
});

describe('syncAvatarEquipment', () => {
  it('swaps gear without reloading the body skeleton', async () => {
    const group = new THREE.Group();
    const body = makeBodyWithHand();
    const getModelSource = vi.fn(async () => body);
    const loadModel = vi.fn(async (url: string) => {
      if (url.includes('sword')) {
        return makeWeaponRoot('One handed sword');
      }
      return makeWeaponRoot('Shield 1');
    });
    const loadAnimations = vi.fn(async () => [] as const);

    const swordItem = socketItem({
      id: 'sword_1h',
      meshKey: 'sword.glb',
      url: '/sword.glb',
      objectNames: ['One handed sword'],
    });
    const shieldItem = socketItem({
      id: 'shield',
      slot: 'off_hand',
      meshKey: 'shield.glb',
      url: '/shield.glb',
      objectNames: ['Shield 1'],
      socketId: 'left_hand',
      socket: {
        id: 'left_hand',
        boneNames: ['mixamorigRightHand'],
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: 1,
      },
      grants: ['block'],
    });

    const assembled = await assembleAvatar({
      resolved: emptyResolved({ equipped: [swordItem] }),
      loaders: { getModelSource, loadModel, loadAnimations },
      group,
      desiredEquipmentVisibility: new Map(),
      actionAnimationNames: ACTION_ANIMATION_NAMES,
    });

    expect(getModelSource).toHaveBeenCalledTimes(1);
    expect(assembled.equipment.has('sword_1h')).toBe(true);
    const bodyRoot = assembled.root;

    const bodyCallsBeforeSync = getModelSource.mock.calls.length;
    const animCallsBeforeSync = loadAnimations.mock.calls.length;

    await syncAvatarEquipment({
      assembled,
      resolved: emptyResolved({ equipped: [shieldItem] }),
      loaders: { loadModel },
      desiredEquipmentVisibility: new Map(),
    });

    expect(getModelSource).toHaveBeenCalledTimes(bodyCallsBeforeSync);
    expect(loadAnimations).toHaveBeenCalledTimes(animCallsBeforeSync);
    expect(assembled.root).toBe(bodyRoot);
    expect(group.children).toContain(bodyRoot);
    expect(assembled.equipment.has('sword_1h')).toBe(false);
    expect(assembled.equipment.has('shield')).toBe(true);
    expect(assembled.equipment.get('shield')?.parent?.name).toBe('mixamorigRightHand');

    assembled.dispose();
    expect(group.children).toHaveLength(0);
  });

  it('keeps unchanged gear meshes and only loads newly equipped items', async () => {
    const group = new THREE.Group();
    const body = makeBodyWithHand();
    const loadModel = vi.fn(async (url: string) => {
      if (url.includes('sword')) return makeWeaponRoot('One handed sword');
      return makeWeaponRoot('Shield 1');
    });

    const swordItem = socketItem({
      id: 'sword_1h',
      meshKey: 'sword.glb',
      url: '/sword.glb',
      objectNames: ['One handed sword'],
    });
    const shieldItem = socketItem({
      id: 'shield',
      slot: 'off_hand',
      meshKey: 'shield.glb',
      url: '/shield.glb',
      objectNames: ['Shield 1'],
      grants: ['block'],
    });

    const assembled = await assembleAvatar({
      resolved: emptyResolved({ equipped: [swordItem] }),
      loaders: {
        getModelSource: async () => body,
        loadModel,
        loadAnimations: async () => [],
      },
      group,
      desiredEquipmentVisibility: new Map(),
      actionAnimationNames: ACTION_ANIMATION_NAMES,
    });

    const keptSword = assembled.equipment.get('sword_1h');
    expect(keptSword).toBeDefined();
    const swordLoadsBefore = loadModel.mock.calls.filter(c => String(c[0]).includes('sword')).length;

    await syncAvatarEquipment({
      assembled,
      resolved: emptyResolved({ equipped: [swordItem, shieldItem] }),
      loaders: { loadModel },
      desiredEquipmentVisibility: new Map(),
    });

    expect(assembled.equipment.get('sword_1h')).toBe(keptSword);
    expect(assembled.equipment.has('shield')).toBe(true);
    const swordLoadsAfter = loadModel.mock.calls.filter(c => String(c[0]).includes('sword')).length;
    expect(swordLoadsAfter).toBe(swordLoadsBefore);
    expect(loadModel.mock.calls.some(c => String(c[0]).includes('shield'))).toBe(true);

    assembled.dispose();
  });

  it('does not wipe live equipment when a cancelled sync aborts', async () => {
    const group = new THREE.Group();
    const body = makeBodyWithHand();
    const swordItem = socketItem({
      id: 'sword_1h',
      meshKey: 'sword.glb',
      url: '/sword.glb',
      objectNames: ['One handed sword'],
    });
    const shieldItem = socketItem({
      id: 'shield',
      slot: 'off_hand',
      meshKey: 'shield.glb',
      url: '/shield.glb',
      objectNames: ['Shield 1'],
      grants: ['block'],
    });

    let releaseShield!: () => void;
    const shieldGate = new Promise<void>(resolve => {
      releaseShield = resolve;
    });

    const loadModel = vi.fn(async (url: string) => {
      if (url.includes('shield')) {
        await shieldGate;
        return makeWeaponRoot('Shield 1');
      }
      return makeWeaponRoot('One handed sword');
    });

    const assembled = await assembleAvatar({
      resolved: emptyResolved({ equipped: [swordItem] }),
      loaders: {
        getModelSource: async () => body,
        loadModel,
        loadAnimations: async () => [],
      },
      group,
      desiredEquipmentVisibility: new Map(),
      actionAnimationNames: ACTION_ANIMATION_NAMES,
    });

    const signal = { disposed: false };
    const pending = syncAvatarEquipment({
      assembled,
      resolved: emptyResolved({ equipped: [shieldItem] }),
      loaders: { loadModel },
      desiredEquipmentVisibility: new Map(),
      signal,
    });

    // Cancel mid-flight (simulates a newer apply generation) after the stale
    // sync has already removed sword but before shield load finishes.
    await Promise.resolve();
    signal.disposed = true;
    releaseShield();
    await pending;

    // Must not clear the shared map on cancel — a newer generation owns it.
    // Stale path may have removed sword (diff) but must not attach shield after cancel.
    expect(assembled.equipment.has('shield')).toBe(false);

    // Newer generation re-applies the intended set cleanly.
    await syncAvatarEquipment({
      assembled,
      resolved: emptyResolved({ equipped: [swordItem] }),
      loaders: { loadModel },
      desiredEquipmentVisibility: new Map(),
    });
    expect(assembled.equipment.has('sword_1h')).toBe(true);

    assembled.dispose();
  });

  it('disposes removed equipment meshes on sync and on avatar dispose', async () => {
    const group = new THREE.Group();
    const body = makeBodyWithHand();
    const loadModel = vi.fn(async () => makeWeaponRoot('One handed sword'));

    const swordItem = socketItem({
      id: 'sword_1h',
      meshKey: 'sword.glb',
      url: '/sword.glb',
      objectNames: ['One handed sword'],
    });

    const assembled = await assembleAvatar({
      resolved: emptyResolved({ equipped: [swordItem] }),
      loaders: {
        getModelSource: async () => body,
        loadModel,
        loadAnimations: async () => [],
      },
      group,
      desiredEquipmentVisibility: new Map(),
      actionAnimationNames: ACTION_ANIMATION_NAMES,
    });

    const firstSword = assembled.equipment.get('sword_1h') as THREE.Mesh;
    const geometry = firstSword.geometry;
    const disposeSpy = vi.spyOn(geometry, 'dispose');

    await syncAvatarEquipment({
      assembled,
      resolved: emptyResolved({ equipped: [] }),
      loaders: { loadModel },
      desiredEquipmentVisibility: new Map(),
    });

    expect(assembled.equipment.size).toBe(0);
    expect(disposeSpy).toHaveBeenCalled();

    // Attach again then full dispose should clear gear too.
    await syncAvatarEquipment({
      assembled,
      resolved: emptyResolved({ equipped: [swordItem] }),
      loaders: { loadModel },
      desiredEquipmentVisibility: new Map(),
    });
    expect(assembled.equipment.size).toBe(1);
    assembled.dispose();
    expect(assembled.equipment.size).toBe(0);
  });

  it('preserves desiredEquipmentVisibility on partial re-attach', async () => {
    const group = new THREE.Group();
    const body = makeBodyWithHand();
    const swordItem = socketItem({
      id: 'potion',
      slot: 'off_hand',
      meshKey: 'potion.glb',
      url: '/potion.glb',
      visibleByDefault: false,
      grants: ['drink_potion'],
    });

    const assembled = await assembleAvatar({
      resolved: emptyResolved({ equipped: [swordItem] }),
      loaders: {
        getModelSource: async () => body,
        loadModel: async () => makeWeaponRoot('potion'),
        loadAnimations: async () => [],
      },
      group,
      desiredEquipmentVisibility: new Map([['potion', true]]),
      actionAnimationNames: ACTION_ANIMATION_NAMES,
    });

    expect(assembled.equipment.get('potion')?.visible).toBe(true);

    await syncAvatarEquipment({
      assembled,
      resolved: emptyResolved({ equipped: [swordItem] }),
      loaders: { loadModel: async () => makeWeaponRoot('potion') },
      desiredEquipmentVisibility: new Map([['potion', true]]),
    });

    expect(assembled.equipment.get('potion')?.visible).toBe(true);
    assembled.dispose();
  });
});
