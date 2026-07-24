import { lazy, Suspense, useEffect, useMemo, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, Environment } from '@react-three/drei';
import * as THREE from 'three';
import type { InputState, PlayerInputAck, PlayerTransform, Vector3 } from '../generated/types';
import type { NetMetrics, RenderTickClock, TransformSnapshot } from '../netcode';
import type { PlayerRuntimeState } from '../playerRuntime';
import { publicAssetPath } from '../publicAssets';
import { useNetwork } from '../network/useNetwork';
import { useGameState } from '../state/useGameState';
import { attachAudioListener, detachAudioListener } from '../audio/AudioManager';
import { normalizeCharacterClass } from './characterConfig';
import { QA_GAME_DEBUG_ENABLED, publishQaRemotePlayerRoster } from '../hooks/useQaGameDebug';
import { PlayerLightPool, usePlayerLightPool } from './PlayerLightPool';
import type { SpellCasterVisualOrigin } from './spellVisualOrigins';
import type { PendingFireballCosmeticCast } from './fireballVisuals';

const GroundTerrain = lazy(() =>
  import('./GroundTerrain').then(m => ({ default: m.GroundTerrain })));
const CastleCollisionDebug = lazy(() =>
  import('./CastleCollisionDebug').then(m => ({ default: m.CastleCollisionDebug })));
const PlayerCapsuleDebug = lazy(() =>
  import('./PlayerCapsuleDebug').then(m => ({ default: m.PlayerCapsuleDebug })));
const LocalPlayer = lazy(() =>
  import('./LocalPlayer').then(m => ({ default: m.LocalPlayer })));
const RemotePlayer = lazy(() =>
  import('./RemotePlayer').then(m => ({ default: m.RemotePlayer })));
const SHADOW_MAP_SIZE = [1024, 1024] as [number, number];

export type GameWorldRuntimeRefs = {
  cosmeticFireballCastsRef: MutableRefObject<Map<string, PendingFireballCosmeticCast>>;
  inputRef: MutableRefObject<InputState>;
  latestTransformsRef: MutableRefObject<Map<string, PlayerTransform>>;
  latestInputAcksRef: MutableRefObject<Map<string, PlayerInputAck>>;
  metricsRef: MutableRefObject<NetMetrics>;
  playerRuntimeRef: MutableRefObject<PlayerRuntimeState>;
  rotationYRef: MutableRefObject<number>;
  renderTickClockRef: MutableRefObject<RenderTickClock>;
  spellCasterVisualOriginsRef: MutableRefObject<Map<string, SpellCasterVisualOrigin>>;
  snapshotBuffersRef: MutableRefObject<Map<string, TransformSnapshot[]>>;
};

export type GameWorldPlayerActions = {
  onBlockStart: () => void;
  onBlockStop: () => void;
  onDrinkPotion: () => void;
  onFireballCast: (targetPosition: Vector3) => void;
  onLightningStrike: (targetPosition: Vector3) => void;
  onRotationChange: (rotationY: number) => void;
  onSlashAttack: () => void;
};

type GameWorldProps = {
  combatAndSpellEffects: ReactNode;
  playerActions: GameWorldPlayerActions;
  runtimeRefs: GameWorldRuntimeRefs;
  setCosmeticFireballCastIds?: Dispatch<SetStateAction<string[]>>;
};

export function GameWorld({
  combatAndSpellEffects,
  playerActions,
  runtimeRefs,
  setCosmeticFireballCastIds,
}: GameWorldProps) {
  const { identity } = useNetwork();
  const {
    playerClasses,
    players,
    selectedWizardSpell,
  } = useGameState();
  const {
    cosmeticFireballCastsRef,
    inputRef,
    latestTransformsRef,
    latestInputAcksRef,
    metricsRef,
    playerRuntimeRef,
    rotationYRef,
    renderTickClockRef,
    spellCasterVisualOriginsRef,
    snapshotBuffersRef,
  } = runtimeRefs;
  const {
    onBlockStart,
    onBlockStop,
    onDrinkPotion,
    onFireballCast,
    onLightningStrike,
    onRotationChange,
    onSlashAttack,
  } = playerActions;

  const playerIdentityKeys = useMemo(() => Array.from(players.keys()), [players]);
  const { lightRefs, getLightRefForPlayer } = usePlayerLightPool(playerIdentityKeys);

  const remoteIdentityKeys = useMemo(() => {
    if (!QA_GAME_DEBUG_ENABLED) return null;

    return Array.from(players.values())
      .map(player => player.identity.toHexString())
      .filter(identityKey => !identity || identityKey !== identity.toHexString())
      .sort();
  }, [identity, players]);

  useEffect(() => {
    if (!remoteIdentityKeys) return;

    publishQaRemotePlayerRoster(remoteIdentityKeys);
    return () => {
      publishQaRemotePlayerRoster([]);
    };
  }, [remoteIdentityKeys]);

  const playerNodes = Array.from(players.values()).map((player) => {
    const playerIdentityKey = player.identity.toHexString();
    const playerLightRef = getLightRefForPlayer(playerIdentityKey);
    const isLocalPlayer = !!identity && player.identity.isEqual(identity);

    if (isLocalPlayer) {
      return (
        <LocalPlayer
          key={playerIdentityKey}
          playerData={player}
          lightRef={playerLightRef}
          characterClass={normalizeCharacterClass(playerClasses.get(playerIdentityKey))}
          playerRuntimeRef={playerRuntimeRef}
          onRotationChange={onRotationChange}
          onSlashAttack={onSlashAttack}
          onBlockStart={onBlockStart}
          onBlockStop={onBlockStop}
          onDrinkPotion={onDrinkPotion}
          onLightningStrike={onLightningStrike}
          onFireballCast={onFireballCast}
          selectedWizardSpell={selectedWizardSpell}
          cosmeticFireballCastsRef={cosmeticFireballCastsRef}
          setCosmeticFireballCastIds={setCosmeticFireballCastIds}
          spellCasterVisualOriginsRef={spellCasterVisualOriginsRef}
          currentInputRef={inputRef}
          rotationYRef={rotationYRef}
          latestTransformsRef={latestTransformsRef}
          latestInputAcksRef={latestInputAcksRef}
          metricsRef={metricsRef}
        />
      );
    }

    return (
      <RemotePlayer
        key={playerIdentityKey}
        playerData={player}
        lightRef={playerLightRef}
        characterClass={normalizeCharacterClass(playerClasses.get(playerIdentityKey))}
        playerRuntimeRef={playerRuntimeRef}
        renderTickClockRef={renderTickClockRef}
        spellCasterVisualOriginsRef={spellCasterVisualOriginsRef}
        snapshotBuffersRef={snapshotBuffersRef}
      />
    );
  });
  return (
    <>
      <MetricsTicker metricsRef={metricsRef} renderTickClockRef={renderTickClockRef} />
      <AudioListenerBridge />
      <SceneSkybox />
      <Environment preset="studio" environmentIntensity={0.08} />
      <ambientLight intensity={0.01} />
      <directionalLight
        position={[10, 10, 10]}
        intensity={0.03}
        castShadow
        shadow-mapSize={SHADOW_MAP_SIZE}
      />
      <PlayerLightPool lightRefs={lightRefs} />
      <gridHelper args={[100, 100, 0x444444, 0x222222]} />

      <ContactShadows
        opacity={0.4}
        scale={50}
        blur={1}
        far={10}
        resolution={256}
        color="#000000"
      />

      <Suspense fallback={null}>
        {playerNodes}
      </Suspense>

      <Suspense fallback={null}>
        <GroundTerrain />
      </Suspense>
      {QA_GAME_DEBUG_ENABLED && (
        <Suspense fallback={null}>
          <>
            <CastleCollisionDebug />
            <PlayerCapsuleDebug />
          </>
        </Suspense>
      )}
      <Suspense fallback={null}>
        {combatAndSpellEffects}
      </Suspense>
    </>
  );
}

function AudioListenerBridge() {
  const { camera, scene } = useThree();

  useEffect(() => {
    attachAudioListener(camera, scene);
    return () => {
      detachAudioListener();
    };
  }, [camera, scene]);

  return null;
}

function SceneSkybox() {
  const { scene } = useThree();

  useEffect(() => {
    const previousBackground = scene.background;
    const loader = new THREE.CubeTextureLoader();
    const texture = loader.load([
      publicAssetPath('skybox/corona_ft.png'),
      publicAssetPath('skybox/corona_bk.png'),
      publicAssetPath('skybox/corona_up.png'),
      publicAssetPath('skybox/corona_dn.png'),
      publicAssetPath('skybox/corona_rt.png'),
      publicAssetPath('skybox/corona_lf.png'),
    ]);

    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    // eslint-disable-next-line react-hooks/immutability -- Three.js scene background is configured imperatively.
    scene.background = texture;

    return () => {
      if (scene.background === texture) {
        scene.background = previousBackground;
      }
      texture.dispose();
    };
  }, [scene]);

  return null;
}

function MetricsTicker({ metricsRef, renderTickClockRef }: {
  metricsRef: MutableRefObject<NetMetrics>;
  renderTickClockRef: MutableRefObject<RenderTickClock>;
}) {
  useFrame((_, delta) => {
    renderTickClockRef.current.advance(Math.min(delta, 0.1));
    const metrics = metricsRef.current;
    const now = performance.now();
    metrics.frameCount += 1;

    const elapsed = now - metrics.lastFpsAt;
    if (elapsed >= 500) {
      metrics.fps = metrics.frameCount / (elapsed / 1000);
      metrics.frameCount = 0;
      metrics.lastFpsAt = now;
    }
  });

  return null;
}
