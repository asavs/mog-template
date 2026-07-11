import { useEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import type { FireballProjectile } from '../generated/types';
import { LIGHTNING_EFFECT_MS, type ActiveSpellEffect } from '../network/useGameTableSync';
import { publicAssetPath } from '../publicAssets';
import { logFireballDebug, vectorDebug as fireballVectorDebug } from '../fireballDebug';
import type { SpellCasterVisualOrigin } from './spellVisualOrigins';
import {
  FIREBALL_VISUAL_HANDOFF_MS,
  FIREBALL_VISUAL_PENDING_TTL_MS,
  canProjectileClaimPendingFireball,
  fireballVisualSpawnOriginFromCaster,
  fireballVisualPositionFromClaim,
  normalizedFireballDirection,
  updatePendingFireballVisualOrigin,
  type PendingFireballCosmeticCast,
} from './fireballVisuals';

const LIGHTNING_DESCENT_MS = 260;
const LIGHTNING_START_HEIGHT = 10;
const LIGHTNING_COLOR = '#bff6ff';
const LIGHTNING_GROUND_EFFECT_SCALE = 0.5;
// Lightning's share of the fixed scene-wide spell point-light budget (see
// FIREBALL_MATERIAL_POOL_SIZE — the two must sum to the historical total of 16
// so NUM_POINT_LIGHTS stays constant). Each pooled light is always mounted, so
// casting borrows an existing light rather than mounting a new one and never
// changes the scene's point-light count. Overflow beyond this many concurrent
// ~900ms strikes degrades gracefully: the extra strike simply gets no impact
// light, and — crucially — still mounts no new light, so nothing recompiles.
const LIGHTNING_IMPACT_LIGHT_POOL_SIZE = 2;
const LIGHTNING_TEXTURE_URL = publicAssetPath('models/spells/lightning/Human_Spell_Lightning_Texture.png');
const LIGHTNING_STRIKE_MODEL_URL = publicAssetPath('models/spells/lightning/Human_Spell_Lightning_Strike.fbx');
const LIGHTNING_GROUND_MODEL_URL = publicAssetPath('models/spells/lightning/Human_Spell_Lightning_Ground.fbx');
const FIREBALL_CORE_SPRITE_URL = publicAssetPath('models/spells/fireball/fireball-no-trail-2.png');
const FIREBALL_TRAIL_SPRITE_URL = publicAssetPath('models/spells/fireball/fireball.png');
const FIREBALL_SHEET_COLUMNS = 4;
const FIREBALL_SHEET_ROWS = 10;
const FIREBALL_SHEET_FRAMES = FIREBALL_SHEET_COLUMNS * FIREBALL_SHEET_ROWS;
const FIREBALL_FRAME_MS = 45;
const FIREBALL_COLOR = '#ff8a22';
const FIREBALL_CORE_SIZE = [1.45, 1.25] as [number, number];
const FIREBALL_CORE_OPACITY = 0.95;
const FIREBALL_DIRECTIONAL_TRAIL_SIZE = [2.2, 1.6] as [number, number];
const FIREBALL_DIRECTIONAL_TRAIL_BACK_OFFSET = 0.5;
const FIREBALL_DIRECTIONAL_TRAIL_MAX_OPACITY = 0.45;
const FIREBALL_PUFF_TRAIL_DISTANCES = [0.65, 1.05, 1.45, 1.85] as const;
const FIREBALL_PUFF_TRAIL_SCALES = [0.38, 0.28, 0.19, 0.12] as const;
// Fireball's always-mounted impact/material pool. Its light count is part of a
// fixed scene-wide spell point-light budget (see LIGHTNING_IMPACT_LIGHT_POOL_SIZE):
// FIREBALL + LIGHTNING must sum to the historical total (16) so the scene's
// NUM_POINT_LIGHTS never changes — a change forces every lit material to relink
// (a multi-second ANGLE stall). Overflow beyond this many concurrent projectiles
// falls back to a per-projectile light (a rare, bounded extra).
const FIREBALL_MATERIAL_POOL_SIZE = 14;

useLoader.preload(THREE.TextureLoader, FIREBALL_CORE_SPRITE_URL);
useLoader.preload(THREE.TextureLoader, FIREBALL_TRAIL_SPRITE_URL);
useLoader.preload(THREE.TextureLoader, LIGHTNING_TEXTURE_URL);
useLoader.preload(FBXLoader, LIGHTNING_STRIKE_MODEL_URL);
useLoader.preload(FBXLoader, LIGHTNING_GROUND_MODEL_URL);

function displayFireballFrame(texture: THREE.Texture, frame: number) {
  const column = frame % FIREBALL_SHEET_COLUMNS;
  const row = Math.floor(frame / FIREBALL_SHEET_COLUMNS);
  texture.offset.set(
    column / FIREBALL_SHEET_COLUMNS,
    1 - (row + 1) / FIREBALL_SHEET_ROWS,
  );
}

function createFireballAnimatedTexture(sourceTexture: THREE.Texture, initialFrame: number) {
  const texture = sourceTexture.clone();
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(1 / FIREBALL_SHEET_COLUMNS, 1 / FIREBALL_SHEET_ROWS);
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  displayFireballFrame(texture, initialFrame);
  texture.needsUpdate = true;
  return texture;
}

type FireballVisualResources = {
  coreGeometry: THREE.PlaneGeometry;
  directionalTrailGeometry: THREE.PlaneGeometry;
  trailGeometry: THREE.CircleGeometry;
  trailMaterials: THREE.MeshBasicMaterial[];
};

type FireballMaterialSlot = {
  coreMaterial: THREE.MeshBasicMaterial;
  coreTexture: THREE.Texture;
  directionalTrailMaterial: THREE.MeshBasicMaterial;
  trailTexture: THREE.Texture;
};

type FireballWarmupResources = {
  warmupCoreMaterial: THREE.MeshBasicMaterial;
  warmupCoreTexture: THREE.Texture;
  warmupTrailMaterial: THREE.MeshBasicMaterial;
  warmupTrailTexture: THREE.Texture;
};

type LightningModelClone = {
  model: THREE.Group;
  materials: THREE.MeshBasicMaterial[];
  mixers: THREE.AnimationMixer[];
};

export function FireballProjectileEffects({
  cosmeticFireballCastIds,
  cosmeticFireballCastsRef,
  projectileIds,
  projectilesRef,
  setCosmeticFireballCastIds,
  spellCasterVisualOriginsRef,
}: {
  cosmeticFireballCastIds: readonly string[];
  cosmeticFireballCastsRef: MutableRefObject<Map<string, PendingFireballCosmeticCast>>;
  projectileIds: readonly string[];
  projectilesRef: MutableRefObject<Map<string, FireballProjectile>>;
  setCosmeticFireballCastIds: Dispatch<SetStateAction<string[]>>;
  spellCasterVisualOriginsRef: MutableRefObject<Map<string, SpellCasterVisualOrigin>>;
}) {
  const coreSourceTexture = useLoader(THREE.TextureLoader, FIREBALL_CORE_SPRITE_URL);
  const trailSourceTexture = useLoader(THREE.TextureLoader, FIREBALL_TRAIL_SPRITE_URL);
  const slotAssignmentsRef = useRef<Map<string, number>>(new Map());
  const lightRefs = useMemo(() => (
    Array.from({ length: FIREBALL_MATERIAL_POOL_SIZE }, () => ({ current: null }) as MutableRefObject<THREE.PointLight | null>)
  ), []);
  const resourcesRef = useRef<FireballVisualResources | null>(null);
  if (!resourcesRef.current) {
    resourcesRef.current = createFireballVisualResources();
  }
  const resources = resourcesRef.current;
  const fireballMaterialSlotsRef = useRef<FireballMaterialSlot[] | null>(null);
  if (!fireballMaterialSlotsRef.current) {
    fireballMaterialSlotsRef.current = Array.from({ length: FIREBALL_MATERIAL_POOL_SIZE }, () => createFireballMaterialSlot(
      coreSourceTexture,
      trailSourceTexture,
    ));
  }
  const fireballMaterialSlots = fireballMaterialSlotsRef.current;
  const warmupRef = useRef<THREE.Group>(null);
  const warmupRenderedRef = useRef(false);
  const warmupResourcesRef = useRef<FireballWarmupResources | null>(null);
  if (!warmupResourcesRef.current) {
    warmupResourcesRef.current = createFireballWarmupResources(coreSourceTexture, trailSourceTexture);
  }
  const {
    warmupCoreMaterial,
    warmupTrailMaterial,
  } = warmupResourcesRef.current;

  useEffect(() => {
    return () => {
      if (resourcesRef.current) {
        disposeFireballVisualResources(resourcesRef.current);
        resourcesRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (fireballMaterialSlotsRef.current) {
        fireballMaterialSlotsRef.current.forEach(disposeFireballMaterialSlot);
        fireballMaterialSlotsRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (warmupResourcesRef.current) {
        disposeFireballWarmupResources(warmupResourcesRef.current);
        warmupResourcesRef.current = null;
      }
    };
  }, []);

  useFrame(() => {
    if (warmupRenderedRef.current) {
      if (warmupRef.current) warmupRef.current.visible = false;
    } else {
      warmupRenderedRef.current = true;
    }
  });

  const activeProjectileIds = new Set([
    ...projectileIds,
    ...cosmeticFireballCastIds,
  ]);
  slotAssignmentsRef.current.forEach((_, projectileId) => {
    if (!activeProjectileIds.has(projectileId)) {
      slotAssignmentsRef.current.delete(projectileId);
    }
  });

  return (
    <group dispose={null}>
      <group ref={warmupRef} scale={0}>
        <mesh geometry={resources.trailGeometry} material={resources.trailMaterials[0]} frustumCulled={false} />
        <mesh geometry={resources.directionalTrailGeometry} material={warmupTrailMaterial} frustumCulled={false} />
        <mesh geometry={resources.coreGeometry} material={warmupCoreMaterial} frustumCulled={false} />
        {fireballMaterialSlots.map((slot, index) => (
          <group key={index}>
            <mesh geometry={resources.directionalTrailGeometry} material={slot.directionalTrailMaterial} frustumCulled={false} />
            <mesh geometry={resources.coreGeometry} material={slot.coreMaterial} frustumCulled={false} />
          </group>
        ))}
      </group>
      {lightRefs.map((lightRef, index) => (
        <pointLight
          key={index}
          ref={lightRef}
          color={FIREBALL_COLOR}
          intensity={0}
          distance={8}
          decay={2}
        />
      ))}
      {cosmeticFireballCastIds.map(castId => {
        const cast = cosmeticFireballCastsRef.current.get(castId);
        if (!cast || cast.claimedByProjectileId) return null;
        const slotIndex = getFireballMaterialSlotIndex(
          castId,
          slotAssignmentsRef.current,
        );

        return (
          <PendingFireballCosmeticEffect
            key={castId}
            cast={cast}
            coreSourceTexture={coreSourceTexture}
            lightRef={slotIndex >= 0 ? lightRefs[slotIndex] : undefined}
            materialSlot={slotIndex >= 0 ? fireballMaterialSlots[slotIndex] : undefined}
            onExpire={(expiredCastId) => {
              cosmeticFireballCastsRef.current.delete(expiredCastId);
              setCosmeticFireballCastIds(prev => prev.filter(id => id !== expiredCastId));
            }}
            resources={resources}
            spellCasterVisualOriginsRef={spellCasterVisualOriginsRef}
            trailSourceTexture={trailSourceTexture}
          />
        );
      })}
      {projectileIds.map(projectileId => {
        const projectile = projectilesRef.current.get(projectileId);
        if (!projectile) return null;
        const slotIndex = getFireballMaterialSlotIndex(
          projectileId,
          slotAssignmentsRef.current,
        );

        return (
          <FireballProjectileEffect
            key={projectileId}
            coreSourceTexture={coreSourceTexture}
            initialProjectile={projectile}
            lightRef={slotIndex >= 0 ? lightRefs[slotIndex] : undefined}
            materialSlot={slotIndex >= 0 ? fireballMaterialSlots[slotIndex] : undefined}
            projectileId={projectileId}
            projectilesRef={projectilesRef}
            resources={resources}
            cosmeticFireballCastsRef={cosmeticFireballCastsRef}
            setCosmeticFireballCastIds={setCosmeticFireballCastIds}
            spellCasterVisualOriginsRef={spellCasterVisualOriginsRef}
            trailSourceTexture={trailSourceTexture}
          />
        );
      })}
    </group>
  );
}

function getFireballMaterialSlotIndex(
  projectileId: string,
  slotAssignments: Map<string, number>,
): number {
  const existing = slotAssignments.get(projectileId);
  if (existing !== undefined) return existing;

  const usedSlots = new Set(slotAssignments.values());
  for (let index = 0; index < FIREBALL_MATERIAL_POOL_SIZE; index += 1) {
    if (!usedSlots.has(index)) {
      slotAssignments.set(projectileId, index);
      return index;
    }
  }

  slotAssignments.set(projectileId, -1);
  return -1;
}

function createFireballVisualResources(): FireballVisualResources {
  return {
    coreGeometry: new THREE.PlaneGeometry(...FIREBALL_CORE_SIZE),
    directionalTrailGeometry: new THREE.PlaneGeometry(...FIREBALL_DIRECTIONAL_TRAIL_SIZE),
    trailGeometry: new THREE.CircleGeometry(0.45, 24),
    trailMaterials: [0, 1, 2, 3].map(index => new THREE.MeshBasicMaterial({
      color: index < 2 ? '#ff8a22' : '#ff3d16',
      transparent: true,
      opacity: 0.28 - index * 0.05,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    })),
  };
}

function disposeFireballVisualResources(resources: FireballVisualResources) {
  resources.coreGeometry.dispose();
  resources.directionalTrailGeometry.dispose();
  resources.trailGeometry.dispose();
  resources.trailMaterials.forEach(material => material.dispose());
}

function createFireballMaterialSlot(
  coreSourceTexture: THREE.Texture,
  trailSourceTexture: THREE.Texture,
): FireballMaterialSlot {
  const coreTexture = createFireballAnimatedTexture(coreSourceTexture, 0);
  const trailTexture = createFireballAnimatedTexture(trailSourceTexture, 0);
  return {
    coreMaterial: createFireballMaterial(coreTexture, FIREBALL_CORE_OPACITY),
    coreTexture,
    directionalTrailMaterial: createFireballMaterial(trailTexture, FIREBALL_DIRECTIONAL_TRAIL_MAX_OPACITY),
    trailTexture,
  };
}

function disposeFireballMaterialSlot(slot: FireballMaterialSlot) {
  slot.coreTexture.dispose();
  slot.trailTexture.dispose();
  slot.coreMaterial.dispose();
  slot.directionalTrailMaterial.dispose();
}

function createFireballWarmupResources(
  coreSourceTexture: THREE.Texture,
  trailSourceTexture: THREE.Texture,
): FireballWarmupResources {
  const warmupCoreTexture = createFireballAnimatedTexture(coreSourceTexture, 0);
  const warmupTrailTexture = createFireballAnimatedTexture(trailSourceTexture, 0);
  return {
    warmupCoreMaterial: createFireballMaterial(warmupCoreTexture, FIREBALL_CORE_OPACITY),
    warmupCoreTexture,
    warmupTrailMaterial: createFireballMaterial(warmupTrailTexture, FIREBALL_DIRECTIONAL_TRAIL_MAX_OPACITY),
    warmupTrailTexture,
  };
}

function disposeFireballWarmupResources(resources: FireballWarmupResources) {
  resources.warmupCoreTexture.dispose();
  resources.warmupTrailTexture.dispose();
  resources.warmupCoreMaterial.dispose();
  resources.warmupTrailMaterial.dispose();
}

function createFireballMaterial(texture: THREE.Texture, opacity: number) {
  return new THREE.MeshBasicMaterial({
    map: texture,
    color: '#ffffff',
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

export function fireballServerPosition(projectile: FireballProjectile) {
  return new THREE.Vector3(
    projectile.position.x,
    projectile.position.y,
    projectile.position.z,
  );
}

export function fireballVisualSpawnOrigin(
  projectile: FireballProjectile,
  spellCasterVisualOrigins: Map<string, SpellCasterVisualOrigin>,
) {
  if (!canProjectileClaimPendingFireball(projectile.distanceTraveled)) {
    return null;
  }

  const casterVisualOrigin = spellCasterVisualOrigins.get(projectile.caster.toHexString());
  if (!casterVisualOrigin) return null;

  return fireballVisualSpawnOriginFromCaster(
    casterVisualOrigin.position,
    normalizedFireballDirection(
      new THREE.Vector3(projectile.direction.x, 0, projectile.direction.z),
      casterVisualOrigin.rotationY,
    ),
  );
}

function initialFireballDisplayPosition(
  projectile: FireballProjectile,
  spellCasterVisualOrigins: Map<string, SpellCasterVisualOrigin>,
) {
  return fireballVisualSpawnOrigin(projectile, spellCasterVisualOrigins) ?? fireballServerPosition(projectile);
}

function claimPendingFireballCast(
  projectile: FireballProjectile,
  projectileId: string,
  cosmeticFireballCasts: Map<string, PendingFireballCosmeticCast>,
) {
  if (!canProjectileClaimPendingFireball(projectile.distanceTraveled)) {
    logFireballDebug('projectile-claim-skip-stale', {
      distanceTraveled: Number(projectile.distanceTraveled.toFixed(3)),
      projectileId,
    });
    return null;
  }

  const now = performance.now();
  const casterKey = projectile.caster.toHexString();
  const projectileDirection = normalizedFireballDirection(new THREE.Vector3(
    projectile.direction.x,
    projectile.direction.y,
    projectile.direction.z,
  ));
  let bestCast: PendingFireballCosmeticCast | null = null;
  let bestScore = -Infinity;

  for (const cast of cosmeticFireballCasts.values()) {
    if (cast.claimedByProjectileId || cast.casterKey !== casterKey) continue;
    if (now - cast.startedAt > FIREBALL_VISUAL_PENDING_TTL_MS) continue;
    const directionScore = cast.direction.dot(projectileDirection);
    const recencyScore = Math.max(0, 1 - ((now - cast.startedAt) / FIREBALL_VISUAL_PENDING_TTL_MS));
    const score = directionScore * 2 + recencyScore;
    if (score > bestScore) {
      bestScore = score;
      bestCast = cast;
    }
  }

  if (!bestCast || bestScore < 0.5) {
    logFireballDebug('projectile-claim-miss', {
      caster: casterKey,
      projectileId,
      pendingCount: cosmeticFireballCasts.size,
      bestScore: Number(bestScore.toFixed(3)),
    });
    return null;
  }

  bestCast.claimedByProjectileId = projectileId;
  logFireballDebug('projectile-claim', {
    castId: bestCast.id,
    caster: casterKey,
    distanceTraveled: Number(projectile.distanceTraveled.toFixed(3)),
    directionDot: Number(bestCast.direction.dot(projectileDirection).toFixed(3)),
    projectileId,
    startPosition: fireballVectorDebug(bestCast.currentPosition),
  });
  return {
    castId: bestCast.id,
    direction: bestCast.direction.clone(),
    startPosition: bestCast.currentPosition.clone(),
    startedAt: bestCast.startedAt,
    claimedAt: now,
  };
}

function PendingFireballCosmeticEffect({
  cast,
  coreSourceTexture,
  lightRef,
  materialSlot,
  onExpire,
  resources,
  spellCasterVisualOriginsRef,
  trailSourceTexture,
}: {
  cast: PendingFireballCosmeticCast;
  coreSourceTexture: THREE.Texture;
  lightRef?: MutableRefObject<THREE.PointLight | null>;
  materialSlot?: FireballMaterialSlot;
  onExpire: (castId: string) => void;
  resources: FireballVisualResources;
  spellCasterVisualOriginsRef: MutableRefObject<Map<string, SpellCasterVisualOrigin>>;
  trailSourceTexture: THREE.Texture;
}) {
  const { camera } = useThree();
  const directionalTrailMeshRef = useRef<THREE.Mesh>(null);
  const coreMeshRef = useRef<THREE.Mesh>(null);
  const fallbackLightRef = useRef<THREE.PointLight>(null);
  const trailRefs = useRef<THREE.Mesh[]>([]);
  const fireballUpRef = useRef(new THREE.Vector3(0, 1, 0));
  const fireballNormalRef = useRef(new THREE.Vector3(1, 0, 0));
  const fireballBasisRef = useRef(new THREE.Matrix4());
  const toCameraRef = useRef(new THREE.Vector3());
  const currentFrameRef = useRef(-1);
  const fallbackSlotRef = useRef<FireballMaterialSlot | null>(null);
  if (!materialSlot && !fallbackSlotRef.current) {
    fallbackSlotRef.current = createFireballMaterialSlot(coreSourceTexture, trailSourceTexture);
  }
  const activeMaterialSlot = materialSlot ?? fallbackSlotRef.current;
  const activeLightRef = lightRef ?? fallbackLightRef;

  useEffect(() => {
    if (!activeMaterialSlot) return undefined;
    currentFrameRef.current = -1;
    displayFireballFrame(activeMaterialSlot.coreTexture, 0);
    displayFireballFrame(activeMaterialSlot.trailTexture, 0);
    activeMaterialSlot.directionalTrailMaterial.opacity = FIREBALL_DIRECTIONAL_TRAIL_MAX_OPACITY;
    if (activeLightRef.current) {
      activeLightRef.current.intensity = 18;
    }
    return () => {
      if (activeLightRef.current) {
        activeLightRef.current.intensity = 0;
      }
      if (fallbackSlotRef.current) {
        disposeFireballMaterialSlot(fallbackSlotRef.current);
        fallbackSlotRef.current = null;
      }
    };
  }, [activeLightRef, activeMaterialSlot]);

  useFrame(() => {
    const now = performance.now();
    if (cast.claimedByProjectileId || now - cast.startedAt > FIREBALL_VISUAL_PENDING_TTL_MS) {
      onExpire(cast.id);
      return;
    }

    const casterVisualOrigin = spellCasterVisualOriginsRef.current.get(cast.casterKey);
    const displayPosition = casterVisualOrigin
      ? updatePendingFireballVisualOrigin(cast, casterVisualOrigin.position)
      : cast.currentPosition;
    const frame = Math.floor((now - cast.startedAt) / FIREBALL_FRAME_MS) % FIREBALL_SHEET_FRAMES;
    if (frame !== currentFrameRef.current) {
      currentFrameRef.current = frame;
      if (activeMaterialSlot) {
        displayFireballFrame(activeMaterialSlot.coreTexture, frame);
        displayFireballFrame(activeMaterialSlot.trailTexture, frame);
      }
    }

    if (directionalTrailMeshRef.current) {
      directionalTrailMeshRef.current.position
        .copy(displayPosition)
        .addScaledVector(cast.direction, -FIREBALL_DIRECTIONAL_TRAIL_BACK_OFFSET);
      fireballNormalRef.current
        .crossVectors(cast.direction, fireballUpRef.current)
        .normalize();
      fireballBasisRef.current.makeBasis(
        cast.direction,
        fireballUpRef.current,
        fireballNormalRef.current,
      );
      directionalTrailMeshRef.current.quaternion.setFromRotationMatrix(fireballBasisRef.current);
    }
    if (coreMeshRef.current) {
      coreMeshRef.current.position.copy(displayPosition);
      coreMeshRef.current.quaternion.copy(camera.quaternion);
    }
    if (activeLightRef.current) {
      activeLightRef.current.position.copy(displayPosition);
    }
    toCameraRef.current.copy(camera.position).sub(displayPosition).normalize();
    const sideAmount = fireballNormalRef.current.crossVectors(cast.direction, toCameraRef.current).length();
    const angleFade = THREE.MathUtils.smoothstep(sideAmount, 0.45, 0.8);
    if (activeMaterialSlot) {
      activeMaterialSlot.directionalTrailMaterial.opacity = FIREBALL_DIRECTIONAL_TRAIL_MAX_OPACITY * angleFade;
    }

    trailRefs.current.forEach((trail, index) => {
      const distance = FIREBALL_PUFF_TRAIL_DISTANCES[index] ?? FIREBALL_PUFF_TRAIL_DISTANCES[FIREBALL_PUFF_TRAIL_DISTANCES.length - 1];
      trail.position.copy(displayPosition).addScaledVector(cast.direction, -distance);
      trail.quaternion.copy(camera.quaternion);
      trail.scale.setScalar(FIREBALL_PUFF_TRAIL_SCALES[index] ?? FIREBALL_PUFF_TRAIL_SCALES[FIREBALL_PUFF_TRAIL_SCALES.length - 1]);
    });
  });

  return (
    <group dispose={null}>
      {!lightRef && <pointLight ref={fallbackLightRef} color={FIREBALL_COLOR} intensity={18} distance={8} decay={2} />}
      {[0, 1, 2, 3].map(index => (
        <mesh
          key={index}
          ref={(mesh) => {
            if (mesh) trailRefs.current[index] = mesh;
          }}
          renderOrder={19 - index}
          geometry={resources.trailGeometry}
          material={resources.trailMaterials[index]}
        />
      ))}
      <mesh
        ref={directionalTrailMeshRef}
        renderOrder={20}
        geometry={resources.directionalTrailGeometry}
        material={activeMaterialSlot?.directionalTrailMaterial}
      />
      <mesh ref={coreMeshRef} renderOrder={21} geometry={resources.coreGeometry} material={activeMaterialSlot?.coreMaterial} />
    </group>
  );
}

function FireballProjectileEffect({
  coreSourceTexture,
  cosmeticFireballCastsRef,
  initialProjectile,
  lightRef,
  materialSlot,
  projectileId,
  projectilesRef,
  resources,
  setCosmeticFireballCastIds,
  spellCasterVisualOriginsRef,
  trailSourceTexture,
}: {
  coreSourceTexture: THREE.Texture;
  cosmeticFireballCastsRef: MutableRefObject<Map<string, PendingFireballCosmeticCast>>;
  initialProjectile: FireballProjectile;
  lightRef?: MutableRefObject<THREE.PointLight | null>;
  materialSlot?: FireballMaterialSlot;
  projectileId: string;
  projectilesRef: MutableRefObject<Map<string, FireballProjectile>>;
  resources: FireballVisualResources;
  setCosmeticFireballCastIds: Dispatch<SetStateAction<string[]>>;
  spellCasterVisualOriginsRef: MutableRefObject<Map<string, SpellCasterVisualOrigin>>;
  trailSourceTexture: THREE.Texture;
}) {
  const { camera } = useThree();
  const directionalTrailMeshRef = useRef<THREE.Mesh>(null);
  const coreMeshRef = useRef<THREE.Mesh>(null);
  const fallbackLightRef = useRef<THREE.PointLight>(null);
  const trailRefs = useRef<THREE.Mesh[]>([]);
  const fireballUpRef = useRef(new THREE.Vector3(0, 1, 0));
  const fireballNormalRef = useRef(new THREE.Vector3(1, 0, 0));
  const fireballBasisRef = useRef(new THREE.Matrix4());
  const toCameraRef = useRef(new THREE.Vector3());
  const claimedCosmeticCastRef = useRef(claimPendingFireballCast(
    initialProjectile,
    projectileId,
    cosmeticFireballCastsRef.current,
  ));
  const displayPositionRef = useRef(initialFireballDisplayPosition(
    initialProjectile,
    spellCasterVisualOriginsRef.current,
  ));
  const initializedDisplayFromClaimRef = useRef(false);
  if (claimedCosmeticCastRef.current && !initializedDisplayFromClaimRef.current) {
    initializedDisplayFromClaimRef.current = true;
    displayPositionRef.current.copy(claimedCosmeticCastRef.current.startPosition);
  }
  const targetPositionRef = useRef(new THREE.Vector3(
    initialProjectile.position.x,
    initialProjectile.position.y,
    initialProjectile.position.z,
  ));
  const distanceTraveledRef = useRef(initialProjectile.distanceTraveled);
  const directionRef = useRef(new THREE.Vector3(initialProjectile.direction.x, 0, initialProjectile.direction.z).normalize());
  const startedAtRef = useRef<number | null>(null);
  const loggedFirstRenderRef = useRef(false);
  const currentFrameRef = useRef(-1);
  const fallbackSlotRef = useRef<FireballMaterialSlot | null>(null);
  if (!materialSlot && !fallbackSlotRef.current) {
    fallbackSlotRef.current = createFireballMaterialSlot(coreSourceTexture, trailSourceTexture);
  }
  const activeMaterialSlot = materialSlot ?? fallbackSlotRef.current;
  const activeLightRef = lightRef ?? fallbackLightRef;

  useEffect(() => {
    return () => {
      if (fallbackSlotRef.current) {
        disposeFireballMaterialSlot(fallbackSlotRef.current);
        fallbackSlotRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const claimedCastId = claimedCosmeticCastRef.current?.castId;
    if (claimedCastId) {
      setCosmeticFireballCastIds(prev => prev.filter(id => id !== claimedCastId));
      cosmeticFireballCastsRef.current.delete(claimedCastId);
    }
    if (!activeMaterialSlot) return undefined;
    startedAtRef.current = null;
    loggedFirstRenderRef.current = false;
    currentFrameRef.current = -1;
    displayFireballFrame(activeMaterialSlot.coreTexture, 0);
    displayFireballFrame(activeMaterialSlot.trailTexture, 0);
    activeMaterialSlot.directionalTrailMaterial.opacity = FIREBALL_DIRECTIONAL_TRAIL_MAX_OPACITY;
    if (activeLightRef.current) {
      activeLightRef.current.intensity = 18;
    }
    return () => {
      if (activeLightRef.current) {
        activeLightRef.current.intensity = 0;
      }
    };
  }, [activeLightRef, activeMaterialSlot, cosmeticFireballCastsRef, projectileId, setCosmeticFireballCastIds]);

  useFrame(() => {
    const projectile = projectilesRef.current.get(projectileId);
    if (projectile) {
      targetPositionRef.current.set(projectile.position.x, projectile.position.y, projectile.position.z);
      distanceTraveledRef.current = projectile.distanceTraveled;
      directionRef.current.set(projectile.direction.x, 0, projectile.direction.z);
      if (directionRef.current.lengthSq() <= 0.0001) {
        directionRef.current.set(0, 0, -1);
      } else {
        directionRef.current.normalize();
      }
    }

    const startedAt = startedAtRef.current ??= performance.now();
    const displayPosition = displayPositionRef.current;
    const claimedCosmeticCast = claimedCosmeticCastRef.current;
    const handoffAgeMs = claimedCosmeticCast ? performance.now() - claimedCosmeticCast.claimedAt : FIREBALL_VISUAL_HANDOFF_MS;
    if (!loggedFirstRenderRef.current) {
      loggedFirstRenderRef.current = true;
      const visualSpawnOrigin = fireballVisualSpawnOrigin(initialProjectile, spellCasterVisualOriginsRef.current);
      const casterVisualOrigin = spellCasterVisualOriginsRef.current.get(initialProjectile.caster.toHexString());
      logFireballDebug('projectile-first-render', {
        caster: initialProjectile.caster.toHexString(),
        casterVisualPosition: casterVisualOrigin ? fireballVectorDebug(casterVisualOrigin.position) : null,
        casterVisualRotationY: casterVisualOrigin ? Number(casterVisualOrigin.rotationY.toFixed(3)) : null,
        direction: fireballVectorDebug(directionRef.current),
        displayPosition: fireballVectorDebug(displayPosition),
        distanceTraveled: Number(distanceTraveledRef.current.toFixed(3)),
        handoffCastId: claimedCosmeticCast?.castId ?? null,
        handoffStartPosition: claimedCosmeticCast ? fireballVectorDebug(claimedCosmeticCast.startPosition) : null,
        projectileId,
        serverPosition: fireballVectorDebug(targetPositionRef.current),
        visualSpawnOrigin: visualSpawnOrigin ? fireballVectorDebug(visualSpawnOrigin) : null,
      });
    }
    if (claimedCosmeticCast) {
      const visualLinePosition = fireballVisualPositionFromClaim(
        claimedCosmeticCast.startPosition,
        directionRef.current,
        distanceTraveledRef.current,
      );
      if (handoffAgeMs < FIREBALL_VISUAL_HANDOFF_MS) {
        const handoffAlpha = THREE.MathUtils.clamp(handoffAgeMs / FIREBALL_VISUAL_HANDOFF_MS, 0, 1);
        displayPosition
          .copy(claimedCosmeticCast.startPosition)
          .lerp(visualLinePosition, handoffAlpha);
      } else {
        displayPosition.lerp(visualLinePosition, 0.65);
      }
    } else {
      displayPosition.lerp(targetPositionRef.current, 0.35);
    }
    const frame = Math.floor((performance.now() - startedAt) / FIREBALL_FRAME_MS) % FIREBALL_SHEET_FRAMES;

    if (frame !== currentFrameRef.current) {
      currentFrameRef.current = frame;
      if (activeMaterialSlot) {
        displayFireballFrame(activeMaterialSlot.coreTexture, frame);
        displayFireballFrame(activeMaterialSlot.trailTexture, frame);
      }
    }

    if (directionalTrailMeshRef.current) {
      directionalTrailMeshRef.current.position
        .copy(displayPosition)
        .addScaledVector(directionRef.current, -FIREBALL_DIRECTIONAL_TRAIL_BACK_OFFSET);
      fireballNormalRef.current
        .crossVectors(directionRef.current, fireballUpRef.current)
        .normalize();
      fireballBasisRef.current.makeBasis(
        directionRef.current,
        fireballUpRef.current,
        fireballNormalRef.current,
      );
      directionalTrailMeshRef.current.quaternion.setFromRotationMatrix(fireballBasisRef.current);
    }
    if (coreMeshRef.current) {
      coreMeshRef.current.position.copy(displayPosition);
      coreMeshRef.current.quaternion.copy(camera.quaternion);
    }
    if (activeLightRef.current) {
      activeLightRef.current.position.copy(displayPosition);
    }
    toCameraRef.current.copy(camera.position).sub(displayPosition).normalize();
    const sideAmount = fireballNormalRef.current.crossVectors(directionRef.current, toCameraRef.current).length();
    const angleFade = THREE.MathUtils.smoothstep(sideAmount, 0.45, 0.8);
    if (activeMaterialSlot) {
      activeMaterialSlot.directionalTrailMaterial.opacity = FIREBALL_DIRECTIONAL_TRAIL_MAX_OPACITY * angleFade;
    }

    trailRefs.current.forEach((trail, index) => {
      const distance = FIREBALL_PUFF_TRAIL_DISTANCES[index] ?? FIREBALL_PUFF_TRAIL_DISTANCES[FIREBALL_PUFF_TRAIL_DISTANCES.length - 1];
      trail.position.copy(displayPosition).addScaledVector(directionRef.current, -distance);
      trail.quaternion.copy(camera.quaternion);
      trail.scale.setScalar(FIREBALL_PUFF_TRAIL_SCALES[index] ?? FIREBALL_PUFF_TRAIL_SCALES[FIREBALL_PUFF_TRAIL_SCALES.length - 1]);
    });
  });

  return (
    <group dispose={null}>
      {!lightRef && <pointLight ref={fallbackLightRef} color={FIREBALL_COLOR} intensity={18} distance={8} decay={2} />}
      {[0, 1, 2, 3].map(index => (
        <mesh
          key={index}
          ref={(mesh) => {
            if (mesh) trailRefs.current[index] = mesh;
          }}
          renderOrder={19 - index}
          geometry={resources.trailGeometry}
          material={resources.trailMaterials[index]}
        />
      ))}
      <mesh
        ref={directionalTrailMeshRef}
        renderOrder={20}
        geometry={resources.directionalTrailGeometry}
        material={activeMaterialSlot?.directionalTrailMaterial}
      />
      <mesh ref={coreMeshRef} renderOrder={21} geometry={resources.coreGeometry} material={activeMaterialSlot?.coreMaterial} />
    </group>
  );
}

function createLightningMaterial(texture: THREE.Texture, opacity: number) {
  return new THREE.MeshBasicMaterial({
    color: LIGHTNING_COLOR,
    map: texture,
    transparent: true,
    opacity,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function createLightningModelClone(
  sourceModel: THREE.Group,
  texture: THREE.Texture,
  scale: number,
  yOffset: number,
  opacity: number,
): LightningModelClone {
  const model = sourceModel.clone(true);
  const materials: THREE.MeshBasicMaterial[] = [];
  const mixers: THREE.AnimationMixer[] = [];

  model.scale.setScalar(scale);
  model.position.set(0, yOffset, 0);
  model.traverse(child => {
    if (child instanceof THREE.Mesh) {
      const material = createLightningMaterial(texture, opacity);
      child.castShadow = false;
      child.receiveShadow = false;
      child.frustumCulled = false;
      child.material = material;
      materials.push(material);
    }
  });

  if (model.animations.length > 0) {
    const mixer = new THREE.AnimationMixer(model);
    mixers.push(mixer);
    model.animations.forEach((clip) => {
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.reset().play();
    });
  }

  return { model, materials, mixers };
}

function disposeLightningModelClone(clone: LightningModelClone) {
  clone.mixers.forEach(mixer => {
    mixer.stopAllAction();
    mixer.uncacheRoot(mixer.getRoot());
  });
  clone.materials.forEach(material => material.dispose());
}

function useLightningEffectAssets() {
  const texture = useLoader(THREE.TextureLoader, LIGHTNING_TEXTURE_URL);
  texture.colorSpace = THREE.SRGBColorSpace;
  const strikeModel = useLoader(FBXLoader, LIGHTNING_STRIKE_MODEL_URL);
  const groundModel = useLoader(FBXLoader, LIGHTNING_GROUND_MODEL_URL);
  return { groundModel, strikeModel, texture };
}

export function LightningEffectPreloader() {
  const { groundModel, strikeModel, texture } = useLightningEffectAssets();
  const warmupRef = useRef<THREE.Group>(null);
  const warmupRenderedRef = useRef(false);
  const warmupResourcesRef = useRef<LightningModelClone[] | null>(null);

  if (!warmupResourcesRef.current) {
    const strike = createLightningModelClone(strikeModel, texture, 0.018, LIGHTNING_START_HEIGHT + 0.02, 0.85);
    const crossStrike = createLightningModelClone(strikeModel, texture, 0.018, LIGHTNING_START_HEIGHT + 0.02, 0.85);
    crossStrike.model.rotation.z = Math.PI / 2;
    const ground = createLightningModelClone(groundModel, texture, 0.07 * LIGHTNING_GROUND_EFFECT_SCALE, 0.04, 0.72);
    warmupResourcesRef.current = [strike, crossStrike, ground];
  }

  useEffect(() => {
    return () => {
      warmupResourcesRef.current?.forEach(disposeLightningModelClone);
      warmupResourcesRef.current = null;
    };
  }, []);

  useFrame(() => {
    if (warmupRenderedRef.current) {
      if (warmupRef.current) warmupRef.current.visible = false;
    } else {
      warmupRenderedRef.current = true;
    }
  });

  return (
    <group ref={warmupRef} scale={0} dispose={null}>
      {warmupResourcesRef.current.map((resource, index) => (
        <primitive key={index} object={resource.model} />
      ))}
      <mesh position={[0, 0.055, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={18} frustumCulled={false}>
        <circleGeometry args={[1.25, 48]} />
        <meshBasicMaterial
          color={LIGHTNING_COLOR}
          transparent
          opacity={0.65}
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

// Renders all active lightning strikes over a persistent, always-mounted pool
// of impact lights. Mounting a fresh <pointLight> per cast would change the
// scene's total point-light count, and three bakes NUM_POINT_LIGHTS into every
// program's cache key — so each change forces every MeshStandard/Physical/Phong
// material (players, terrain) to relink, a multi-second stall on ANGLE/D3D.
// Keeping the pool always mounted holds the count constant (mirrors the fireball
// light pool), so casting never recompiles anything.
export function LightningStrikeEffects({ effects }: { effects: readonly ActiveSpellEffect[] }) {
  const lightRefs = useMemo(() => (
    Array.from(
      { length: LIGHTNING_IMPACT_LIGHT_POOL_SIZE },
      () => ({ current: null }) as MutableRefObject<THREE.PointLight | null>,
    )
  ), []);
  const slotAssignmentsRef = useRef<Map<string, number>>(new Map());

  const activeKeys = new Set(effects.map(effect => effect.key));
  slotAssignmentsRef.current.forEach((_, key) => {
    if (!activeKeys.has(key)) slotAssignmentsRef.current.delete(key);
  });

  return (
    <group dispose={null}>
      {lightRefs.map((lightRef, index) => (
        <pointLight
          key={index}
          ref={lightRef}
          color={LIGHTNING_COLOR}
          intensity={0}
          distance={12}
          decay={2}
        />
      ))}
      {effects.map(effect => {
        const slotIndex = getLightningLightSlotIndex(effect.key, slotAssignmentsRef.current);
        return (
          <LightningStrikeEffect
            key={effect.key}
            effect={effect}
            lightRef={slotIndex >= 0 ? lightRefs[slotIndex] : undefined}
          />
        );
      })}
    </group>
  );
}

function getLightningLightSlotIndex(
  effectKey: string,
  slotAssignments: Map<string, number>,
): number {
  const existing = slotAssignments.get(effectKey);
  if (existing !== undefined) return existing;

  const usedSlots = new Set(slotAssignments.values());
  for (let index = 0; index < LIGHTNING_IMPACT_LIGHT_POOL_SIZE; index += 1) {
    if (!usedSlots.has(index)) {
      slotAssignments.set(effectKey, index);
      return index;
    }
  }

  slotAssignments.set(effectKey, -1);
  return -1;
}

function LightningStrikeEffect({
  effect,
  lightRef,
}: {
  effect: ActiveSpellEffect;
  // A pooled impact light, borrowed from LightningStrikeEffects' persistent
  // pool. The effect drives its intensity/world-position rather than mounting
  // its own <pointLight>, so the scene's total point-light count never changes
  // (see LightningStrikeEffects). undefined only if the pool is exhausted.
  lightRef?: MutableRefObject<THREE.PointLight | null>;
}) {
  const { groundModel, strikeModel, texture } = useLightningEffectAssets();
  const groupRef = useRef<THREE.Group>(null);
  const strikeModelRef = useRef<THREE.Group | null>(null);
  const crossStrikeModelRef = useRef<THREE.Group | null>(null);
  const groundModelRef = useRef<THREE.Group | null>(null);
  const groundGlowRef = useRef<THREE.Mesh>(null);
  const groundGlowMaterialRef = useRef<THREE.MeshBasicMaterial>(null);
  const mixerRefs = useRef<THREE.AnimationMixer[]>([]);
  const strikeMaterialsRef = useRef<THREE.MeshBasicMaterial[]>([]);
  const crossStrikeMaterialsRef = useRef<THREE.MeshBasicMaterial[]>([]);
  const groundMaterialsRef = useRef<THREE.MeshBasicMaterial[]>([]);

  useEffect(() => {
    const group = groupRef.current;
    const strike = createLightningModelClone(strikeModel, texture, 0.018, LIGHTNING_START_HEIGHT + 0.02, 0.85);
    const crossStrike = createLightningModelClone(strikeModel, texture, 0.018, LIGHTNING_START_HEIGHT + 0.02, 0.85);
    const ground = createLightningModelClone(groundModel, texture, 0.07 * LIGHTNING_GROUND_EFFECT_SCALE, 0.04, 0.72);

    crossStrike.model.rotation.z = Math.PI / 2;
    ground.model.visible = false;

    strikeModelRef.current = strike.model;
    crossStrikeModelRef.current = crossStrike.model;
    groundModelRef.current = ground.model;
    strikeMaterialsRef.current = strike.materials;
    crossStrikeMaterialsRef.current = crossStrike.materials;
    groundMaterialsRef.current = ground.materials;
    mixerRefs.current = [...strike.mixers, ...crossStrike.mixers, ...ground.mixers];

    group?.add(strike.model, crossStrike.model, ground.model);

    return () => {
      strikeModelRef.current = null;
      crossStrikeModelRef.current = null;
      groundModelRef.current = null;
      strikeMaterialsRef.current = [];
      crossStrikeMaterialsRef.current = [];
      groundMaterialsRef.current = [];
      mixerRefs.current = [];
      group?.remove(strike.model, crossStrike.model, ground.model);
      disposeLightningModelClone(strike);
      disposeLightningModelClone(crossStrike);
      disposeLightningModelClone(ground);
    };
  }, [groundModel, strikeModel, texture]);

  // Release the borrowed pool light when this strike ends, so the shared light
  // goes dark for the next borrower instead of lingering lit.
  useEffect(() => {
    const light = lightRef?.current;
    if (light) light.intensity = 0;
    return () => {
      if (light) light.intensity = 0;
    };
  }, [lightRef]);

  useFrame((_, delta) => {
    const elapsed = performance.now() - effect.startedAt;
    const descentProgress = Math.min(1, elapsed / LIGHTNING_DESCENT_MS);
    const easedDescent = 1 - Math.pow(1 - descentProgress, 3);
    const impactElapsed = Math.max(0, elapsed - LIGHTNING_DESCENT_MS);
    const impactProgress = Math.min(1, impactElapsed / (LIGHTNING_EFFECT_MS - LIGHTNING_DESCENT_MS));
    const pulse = Math.sin(impactProgress * Math.PI);
    const impactFlash = Math.max(0, 1 - impactProgress);
    const hasImpacted = elapsed >= LIGHTNING_DESCENT_MS;

    mixerRefs.current.forEach(mixer => mixer.update(delta));
    if (groupRef.current) {
      groupRef.current.scale.setScalar(1);
    }
    if (groundGlowRef.current) {
      groundGlowRef.current.scale.setScalar(hasImpacted ? (1.3 + pulse * 1.8) * LIGHTNING_GROUND_EFFECT_SCALE : 0.001);
      groundGlowRef.current.rotation.z += delta * 0.8;
      groundGlowRef.current.visible = hasImpacted && impactProgress < 0.95;
    }
    if (groundGlowMaterialRef.current) {
      groundGlowMaterialRef.current.opacity = hasImpacted
        ? Math.min(1, 0.65 * impactFlash + 0.18 * pulse)
        : 0;
    }
    const impactLight = lightRef?.current;
    if (impactLight) {
      // The pooled light is parented at the world origin, so it takes the
      // strike's full world position (group position + the animated height).
      impactLight.position.set(
        effect.spell.position.x,
        effect.spell.position.y + LIGHTNING_START_HEIGHT * (1 - easedDescent) + 1.4,
        effect.spell.position.z,
      );
      impactLight.intensity = hasImpacted
        ? Math.min(120, 95 * impactFlash + 30 * pulse)
        : 18 + 24 * descentProgress;
    }
    if (strikeModelRef.current) {
      strikeModelRef.current.position.y = LIGHTNING_START_HEIGHT * (1 - easedDescent) + 0.02;
      strikeModelRef.current.visible = descentProgress < 1 || Math.floor(elapsed / 70) % 2 === 0 || impactProgress < 0.2;
      strikeMaterialsRef.current.forEach(material => {
        material.opacity = Math.min(1, hasImpacted ? 0.78 + pulse * 0.35 : 0.45 + descentProgress * 0.45);
      });
    }
    if (crossStrikeModelRef.current) {
      crossStrikeModelRef.current.position.y = LIGHTNING_START_HEIGHT * (1 - easedDescent) + 0.02;
      crossStrikeModelRef.current.visible = descentProgress < 1 || Math.floor(elapsed / 70) % 2 === 0 || impactProgress < 0.2;
      crossStrikeMaterialsRef.current.forEach(material => {
        material.opacity = Math.min(1, hasImpacted ? 0.78 + pulse * 0.35 : 0.45 + descentProgress * 0.45);
      });
    }
    if (groundModelRef.current) {
      groundModelRef.current.visible = hasImpacted && impactProgress < 0.95;
      groundModelRef.current.rotation.y += delta * 1.2;
      groundMaterialsRef.current.forEach(material => {
        material.opacity = hasImpacted
          ? Math.min(1, 0.18 + impactFlash * 0.92 + pulse * 0.28)
          : 0;
      });
    }
  });

  return (
    <group
      ref={groupRef}
      position={[
        effect.spell.position.x,
        effect.spell.position.y,
        effect.spell.position.z,
      ]}
    >
      <mesh ref={groundGlowRef} position={[0, 0.055, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={18}>
        <circleGeometry args={[1.25, 48]} />
        <meshBasicMaterial
          ref={groundGlowMaterialRef}
          color={LIGHTNING_COLOR}
          transparent
          opacity={0.65}
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
