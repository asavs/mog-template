import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, advance } from '@react-three/fiber';
import * as THREE from 'three';
import type { Identity } from 'spacetimedb';
import type { DbConnection } from './generated';
import type {
  FireballProjectile,
  PlayerAppearance,
  PlayerData,
  PlayerEquipment,
  PlayerHealth,
  PlayerInputAck,
  PlayerTransform,
} from './generated/types';
import {
  GameWorld,
  type GameWorldRuntimeRefs,
} from './components/GameWorld';
import { GameOverlays } from './components/GameOverlays';
import { CombatFeedbackEffect, type ActiveCombatFeedback } from './components/CombatFeedbackEffect';
import { FireballProjectileEffects, LightningEffectPreloader, LightningStrikeEffects } from './components/SpellEffects';
import type { WizardSpell } from './components/BasePlayer';
import {
  normalizeCharacterClass,
  resolvePlayerCapabilities,
} from './components/characterConfig';
import type { PendingFireballCosmeticCast } from './components/fireballVisuals';
import type { SpellCasterVisualOrigin } from './components/spellVisualOrigins';
import {
  createMetrics,
  RenderTickClock,
  type NetMetrics,
  type TransformSnapshot,
} from './netcode';
import { createPlayerRuntimeState } from './playerRuntime';
import { useGameTableSync, type ActiveSpellEffect } from './network/useGameTableSync';
import { useSpacetimeConnection } from './network/useSpacetimeConnection';
import type { NetworkState } from './network/NetworkContext';
import { NetworkProvider } from './network/NetworkProvider';
import { useJoinSession } from './hooks/useJoinSession';
import { usePlayerActions } from './hooks/usePlayerActions';
import { useInputState, useKeyboardInput } from './hooks/useInputManager';
import {
  QA_GAME_DEBUG_ENABLED,
  type GameDebugChannels,
  useQaGameDebug,
} from './hooks/useQaGameDebug';
import type { GameState } from './state/GameStateContext';
import { GameStateProvider } from './state/GameStateProvider';
import { HudStateProvider } from './state/HudStateProvider';
import {
  installAudioUnlockHandlers,
  setGameAudioMuted,
} from './audio/AudioManager';
import { frameLoopAdvanceTimeSeconds } from './frameLoop';
import { PLAYER_SPEED, SPRINT_MULTIPLIER } from './locomotion';

const CAMERA_CONFIG = { position: [5, 5, 5] as [number, number, number], fov: 50 };
const DEFAULT_MAX_FPS = 60;
const MAX_FPS = readMaxFps(import.meta.env.VITE_MAX_FPS);
const QA_CONFIG_CHANNELS = {
  config_walkSpeed: PLAYER_SPEED,
  config_sprintMultiplier: SPRINT_MULTIPLIER,
} satisfies GameDebugChannels;

function readMaxFps(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_MAX_FPS;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

// Timestamps land on vsync ticks, which rarely divide the frame budget evenly;
// without a small tolerance a 60Hz display's ~16.67ms ticks can jitter under
// the 16.67ms budget and stall a whole extra refresh (60fps -> 30fps).
const FRAME_CAP_TOLERANCE_MS = 1;

function RenderFrameLoop() {
  useEffect(() => {
    let disposed = false;
    let animationFrameId = 0;
    let firstFrameTimestamp: number | null = null;
    let lastAdvancedAt: number | null = null;
    const minFrameMs = MAX_FPS > 0 ? 1000 / MAX_FPS : 0;

    // Run rAF continuously and skip vsync ticks until the frame budget has
    // elapsed. Never delay *scheduling* the next rAF (e.g. via setTimeout):
    // a callback requested mid-refresh only fires on the vsync after next,
    // which turns a 60fps cap into 40fps on a 120Hz display.
    const onFrame = (timestamp: number) => {
      if (disposed) return;
      animationFrameId = window.requestAnimationFrame(onFrame);

      if (minFrameMs > 0 && lastAdvancedAt !== null) {
        const elapsed = timestamp - lastAdvancedAt;
        if (elapsed < minFrameMs - FRAME_CAP_TOLERANCE_MS) return;
        // Anchor to the cap grid rather than the vsync grid so leftover time
        // carries over and the average rate stays at the cap. Frames admitted
        // by the tolerance (elapsed just under minFrameMs) must anchor to the
        // timestamp itself: elapsed % minFrameMs === elapsed there, which
        // would leave the anchor unmoved and let every later tick through.
        const leftover = elapsed >= minFrameMs ? elapsed % minFrameMs : 0;
        lastAdvancedAt = timestamp - leftover;
      } else {
        lastAdvancedAt = timestamp;
      }

      if (firstFrameTimestamp === null) {
        firstFrameTimestamp = timestamp;
      }
      advance(frameLoopAdvanceTimeSeconds(timestamp, firstFrameTimestamp));
    };

    animationFrameId = window.requestAnimationFrame(onFrame);

    return () => {
      disposed = true;
      if (animationFrameId !== 0) window.cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return null;
}

type QaGameDebugBridgeProps = {
  combatFeedbackEffects: number;
  fireballProjectiles: number;
  hp?: number;
  isDead?: boolean;
  isJoined: boolean;
  lightningEffects: number;
  maxHp?: number;
  playersOnline: number;
};

function QaGameDebugBridge({
  combatFeedbackEffects,
  fireballProjectiles,
  hp,
  isDead,
  isJoined,
  lightningEffects,
  maxHp,
  playersOnline,
}: QaGameDebugBridgeProps) {
  const channels = useMemo<GameDebugChannels>(() => ({
    ...QA_CONFIG_CHANNELS,
    combatFeedbackEffects,
    fireballProjectiles,
    hp,
    isDead,
    isJoined,
    lightningEffects,
    maxHp,
    playersOnline,
  }), [
    combatFeedbackEffects,
    fireballProjectiles,
    hp,
    isDead,
    isJoined,
    lightningEffects,
    maxHp,
    playersOnline,
  ]);

  useQaGameDebug(channels);
  return null;
}

export default function App() {
  const [players, setPlayers] = useState<ReadonlyMap<string, PlayerData>>(new Map());
  const [playerClasses, setPlayerClasses] = useState<ReadonlyMap<string, string>>(new Map());
  const [playerAppearances, setPlayerAppearances] = useState<ReadonlyMap<string, PlayerAppearance>>(new Map());
  const [playerEquipment, setPlayerEquipment] = useState<ReadonlyMap<string, readonly PlayerEquipment[]>>(new Map());
  const [spellEffects, setSpellEffects] = useState<ActiveSpellEffect[]>([]);
  const [combatFeedback, setCombatFeedback] = useState<ActiveCombatFeedback[]>([]);
  const [cosmeticFireballCastIds, setCosmeticFireballCastIds] = useState<string[]>([]);
  const [fireballProjectileIds, setFireballProjectileIds] = useState<string[]>([]);
  const [selectedWizardSpell, setSelectedWizardSpell] = useState<WizardSpell>('fireball');
  const [isJoined, setIsJoined] = useState(false);
  const [hudHealth, setHudHealth] = useState<PlayerHealth>();
  const [audioMuted, setAudioMuted] = useState(false);

  const isJoinedRef = useRef(false);
  const identityRef = useRef<Identity | null>(null);
  const { inputRef, resetInputForDeath } = useInputState();
  const rotationYRef = useRef(0);
  const latestTransformsRef = useRef<Map<string, PlayerTransform>>(new Map());
  const latestInputAcksRef = useRef<Map<string, PlayerInputAck>>(new Map());
  const cosmeticFireballCastsRef = useRef<Map<string, PendingFireballCosmeticCast>>(new Map());
  const fireballProjectilesRef = useRef<Map<string, FireballProjectile>>(new Map());
  const spellCasterVisualOriginsRef = useRef<Map<string, SpellCasterVisualOrigin>>(new Map());
  const snapshotBuffersRef = useRef<Map<string, TransformSnapshot[]>>(new Map());
  const renderTickClockRef = useRef(new RenderTickClock());
  const playerRuntimeRef = useRef(createPlayerRuntimeState());
  const spellSubscriptionReadyRef = useRef(false);
  const combatSubscriptionReadyRef = useRef(false);
  const metricsRef = useRef<NetMetrics>(createMetrics());

  useEffect(() => installAudioUnlockHandlers(), []);



  useEffect(() => {
    setGameAudioMuted(audioMuted);
  }, [audioMuted]);

  useEffect(() => {
    isJoinedRef.current = isJoined;
  }, [isJoined]);

  const {
    handleSubscriptionApplied,
    registerTableCallbacks,
  } = useGameTableSync({
    combatSubscriptionReadyRef,
    identityRef,
    inputRef,
    latestTransformsRef,
    latestInputAcksRef,
    metricsRef,
    playerRuntimeRef,
    resetInputForDeath,
    setCombatFeedback,
    fireballProjectilesRef,
    setFireballProjectileIds,
    setHudHealth,
    setIsJoined,
    setPlayerClasses,
    setPlayerAppearances,
    setPlayerEquipment,
    setPlayers,
    setSpellEffects,
    snapshotBuffersRef,
    renderTickClockRef,
    spellSubscriptionReadyRef,
  });

  const handleConnected = useCallback((_connection: DbConnection, id: Identity) => {
    identityRef.current = id;
  }, []);

  const handleDisconnected = useCallback(() => {
    setIsJoined(false);
    spellSubscriptionReadyRef.current = false;
    combatSubscriptionReadyRef.current = false;
  }, []);

  const {
    connected,
    connRef,
    databaseName,
    forgetSavedConnection,
    hasSavedCharacter,
    identity,
  } = useSpacetimeConnection({
    onConnected: handleConnected,
    onDisconnected: handleDisconnected,
    onSubscriptionApplied: handleSubscriptionApplied,
    registerTableCallbacks,
  });

  const {
    handleClearSavedCharacter,
    handleJoin,
    handleLeave,
    joinPreferences,
  } = useJoinSession({
    connRef,
    forgetSavedConnection,
    setIsJoined,
  });

  // Warm only the selected join class (not every character pack). Remotes load on demand.
  // Use catalog-aware normalize so future presets (e.g. acolyte) preload correctly.
  useEffect(() => {
    const presetId = normalizeCharacterClass(joinPreferences.characterClass);
    void import('./components/playerModelLoader').then(({ preloadPresetAssets }) => {
      void preloadPresetAssets(presetId);
    });
  }, [joinPreferences.characterClass]);

  const networkState = useMemo<NetworkState>(() => ({
    connected,
    connRef,
    databaseName,
    forgetSavedConnection,
    hasSavedCharacter,
    identity,
  }), [
    connected,
    connRef,
    databaseName,
    forgetSavedConnection,
    hasSavedCharacter,
    identity,
  ]);

  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);

  const {
    gameWorldPlayerActions,
    sendInputNow,
  } = usePlayerActions({
    connRef,
    identity,
    inputRef,
    isDead: hudHealth?.isDead ?? false,
    isJoined,
    isJoinedRef,
    metricsRef,
    playerRuntimeRef,
    rotationYRef,
  });


  // Spell hotkeys follow resolved grants (appearance + equipment + baseline),
  // not the raw character_class string alone — mid-session gear changes apply.
  const localCapabilities = useMemo(() => {
    const identityKey = identity?.toHexString();
    if (!identityKey) {
      return resolvePlayerCapabilities({});
    }
    const appearanceRow = playerAppearances.get(identityKey);
    const equipmentRows = playerEquipment.get(identityKey);
    return resolvePlayerCapabilities({
      legacyClass: playerClasses.get(identityKey),
      appearance: appearanceRow
        ? {
            bodyId: appearanceRow.bodyId,
            scale: appearanceRow.scale,
            loadoutPreset: appearanceRow.loadoutPreset,
          }
        : null,
      equipment: equipmentRows?.map(row => ({
        slot: row.slot,
        itemId: row.itemId,
      })),
    });
  }, [identity, playerAppearances, playerClasses, playerEquipment]);

  useKeyboardInput({
    identity,
    inputRef,
    onSelectWizardSpell: setSelectedWizardSpell,
    playerRuntimeRef,
    sendInputNow,
    availableSpells: localCapabilities.spells,
  });

  const gameState = useMemo<GameState>(() => ({
    playerAppearances,
    playerEquipment,
    playerClasses,
    players,
    selectedWizardSpell,
  }), [
    playerAppearances,
    playerEquipment,
    playerClasses,
    players,
    selectedWizardSpell,
  ]);

  const gameWorldRuntimeRefs = useMemo<GameWorldRuntimeRefs>(() => ({
    inputRef,
    cosmeticFireballCastsRef,
    latestTransformsRef,
    latestInputAcksRef,
    metricsRef,
    playerRuntimeRef,
    rotationYRef,
    renderTickClockRef,
    spellCasterVisualOriginsRef,
    snapshotBuffersRef,
  }), [
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
  ]);

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#050505' }}>
      {QA_GAME_DEBUG_ENABLED ? (
        <QaGameDebugBridge
          combatFeedbackEffects={combatFeedback.length}
          fireballProjectiles={fireballProjectileIds.length}
          hp={hudHealth?.currentHealth}
          isDead={hudHealth?.isDead}
          isJoined={isJoined}
          lightningEffects={spellEffects.length}
          maxHp={hudHealth?.maxHealth}
          playersOnline={players.size}
        />
      ) : null}
      <NetworkProvider value={networkState}>
        <GameStateProvider value={gameState}>
          <Canvas
            frameloop="never"
            shadows
            camera={CAMERA_CONFIG}
            gl={{
              outputColorSpace: THREE.SRGBColorSpace,
              toneMapping: THREE.ACESFilmicToneMapping,
              toneMappingExposure: 0.25,
            }}
          >
            <RenderFrameLoop />
            <NetworkProvider value={networkState}>
              <GameStateProvider value={gameState}>
                <GameWorld
                  playerActions={gameWorldPlayerActions}
                  runtimeRefs={gameWorldRuntimeRefs}
                  setCosmeticFireballCastIds={setCosmeticFireballCastIds}
                  combatAndSpellEffects={(
                    <>
                      <LightningEffectPreloader />
                      <LightningStrikeEffects effects={spellEffects} />
                      <FireballProjectileEffects
                        cosmeticFireballCastIds={cosmeticFireballCastIds}
                        cosmeticFireballCastsRef={cosmeticFireballCastsRef}
                        projectileIds={fireballProjectileIds}
                        projectilesRef={fireballProjectilesRef}
                        setCosmeticFireballCastIds={setCosmeticFireballCastIds}
                        spellCasterVisualOriginsRef={spellCasterVisualOriginsRef}
                      />
                      {combatFeedback.map(effect => (
                        <CombatFeedbackEffect
                          key={effect.key}
                          effect={effect}
                        />
                      ))}
                    </>
                  )}
                />
              </GameStateProvider>
            </NetworkProvider>
          </Canvas>

          <HudStateProvider
            hudHealth={hudHealth}
            isJoined={isJoined}
            joinPreferences={joinPreferences}
            metricsRef={metricsRef}
            snapshotBuffersRef={snapshotBuffersRef}
          >
            <GameOverlays
              audioMuted={audioMuted}
              onClearSavedCharacter={handleClearSavedCharacter}
              onJoin={handleJoin}
              onLeave={handleLeave}
              onToggleAudio={() => setAudioMuted(muted => !muted)}
            />
          </HudStateProvider>
        </GameStateProvider>
      </NetworkProvider>
    </div>
  );
}
