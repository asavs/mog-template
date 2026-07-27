/**
 * The game shell: connect, join, render.
 *
 * `useSpacetimeConnection` (kept from before this rewrite) owns the socket;
 * this component wires its two callbacks to `sync.ts`'s generic table→store
 * mechanism, shows a join dialog until a `player` row exists for our
 * identity, then mounts the r3f scene and HUD. Movement/camera live in
 * `frame.ts`, driven once per r3f frame from here.
 *
 * The scene is `world/Arena.tsx` (ground + lighting + dressing) plus one
 * `PlayerBody` per live player — the local one driven by `frame.ts`'s
 * per-tick locomotion output, every other one by its own network rows. See
 * `game/PlayerBody.tsx` and `game/EffectsView.tsx` for the two halves of
 * what used to be the placeholder capsule/plane/lights below.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Identity } from 'spacetimedb';
import { deriveGates } from '../actions/gates';
import type { DbConnection } from '../generated';
import { useInput } from '../input/useInput';
import { useSpacetimeConnection } from '../network/useSpacetimeConnection';
import { createEffects } from '../presentation/effects';
import { mountPerfHud } from '../perf/hud';
import { sharedNetcodeMetrics, type NetcodeSnapshot } from '../perf/metrics';
import { shouldEnableQaGameDebug } from '../qaGate';
import { Arena } from '../world/Arena';
import { EffectsView } from './EffectsView';
import { createFrameRuntimeState, stepFrame } from './frame';
import { Hud } from './Hud';
import { PlayerBody } from './PlayerBody';
import { attachGameStore, createGameStore, type GameStore } from './sync';

const PLAYER_NAME_KEY = 'mog.playerName';
const HUD_POLL_INTERVAL_MS = 200;
/**
 * How often the netcode snapshot published on `window.__mogGame` is recomputed. Deriving
 * percentiles every frame would be wasted work for a channel nothing samples faster than
 * ~10Hz — the harness's rAF trace re-reads the same mutated object, and the perf overlay
 * redraws at this same cadence — so the per-frame path stays a plain property assignment.
 */
const NETCODE_PUBLISH_INTERVAL_MS = 100;

function loadSavedName(): string {
  try {
    return window.localStorage.getItem(PLAYER_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string) {
  try {
    window.localStorage.setItem(PLAYER_NAME_KEY, name);
  } catch {
    // localStorage can throw in locked-down contexts (private browsing quotas, etc.) — the
    // join flow still works, it just won't remember the name for next time.
  }
}

declare global {
  interface Window {
    /** QA-only (gated by `?qa` / VITE_QA_MODE — see qaGate.ts). Row-level ground truth for smoke tests. */
    __mogGame?: {
      localPosition: { x: number; y: number; z: number };
      remoteCount: number;
      joined: boolean;
      identityHex: string | null;
      store: GameStore;
      /**
       * Live netcode-feel metrics (see `perf/metrics.ts`). The SAME object every frame —
       * mutated in place, never reallocated — so a sampler may hold a reference to it.
       */
      netcode: NetcodeSnapshot;
    };
  }
}

interface SceneProps {
  store: GameStore;
  identityHex: string | null;
  movementRef: React.MutableRefObject<{ forward: boolean; backward: boolean; left: boolean; right: boolean; jump: boolean }>;
  rotationYRef: React.MutableRefObject<number>;
  pitchRef: React.MutableRefObject<number>;
}

function Scene({ store, identityHex, movementRef, rotationYRef, pitchRef }: SceneProps) {
  const runtimeRef = useRef(createFrameRuntimeState());
  const localGroupRef = useRef<THREE.Group>(null);
  const remoteGroupsRef = useRef(new Map<string, THREE.Group>());
  const [remoteIds, setRemoteIds] = useState<string[]>([]);
  const effectsRef = useRef(createEffects());
  const lastNetcodePublishRef = useRef(0);

  useFrame((state, delta) => {
    const actionState = identityHex ? store.playerActionState.get(identityHex) : undefined;
    const gates = deriveGates(actionState?.actionId ?? '', actionState?.phase ?? 0);

    const render = stepFrame(runtimeRef.current, {
      dtSeconds: Math.min(delta, 0.1),
      store,
      localIdentityHex: identityHex,
      movement: movementRef.current,
      rotationY: rotationYRef.current,
      pitch: pitchRef.current,
      movementFraction: gates.movementFraction,
      canRotate: gates.canRotate,
    });

    if (localGroupRef.current) {
      localGroupRef.current.position.copy(render.localPosition);
      localGroupRef.current.rotation.y = render.localRotationY;
    }
    state.camera.position.copy(render.camera.position);
    state.camera.lookAt(render.camera.lookAt);

    let idsChanged = render.remotes.size !== remoteIds.length;
    for (const [id, remote] of render.remotes) {
      if (!idsChanged && !remoteIds.includes(id)) idsChanged = true;
      const group = remoteGroupsRef.current.get(id);
      if (group) {
        group.position.copy(remote.position);
        group.rotation.y = remote.rotationY;
      }
    }
    if (idsChanged) setRemoteIds([...render.remotes.keys()]);

    if (shouldEnableQaGameDebug()) {
      const metrics = runtimeRef.current.metrics;
      const now = performance.now();
      if (now - lastNetcodePublishRef.current >= NETCODE_PUBLISH_INTERVAL_MS) {
        lastNetcodePublishRef.current = now;
        metrics.refreshSnapshot(now);
      }
      window.__mogGame = {
        localPosition: { x: render.localPosition.x, y: render.localPosition.y, z: render.localPosition.z },
        remoteCount: render.remotes.size,
        joined: identityHex !== null,
        identityHex,
        store,
        netcode: metrics.snapshot,
      };
    }
  });

  return (
    <>
      <Arena />

      <group ref={localGroupRef}>
        {identityHex && (
          <PlayerBody
            identityHex={identityHex}
            store={store}
            effects={effectsRef.current}
            ownsSceneEffects
            local={{
              // Closures, not the current value: `Scene` only re-renders on
              // player-count changes, but `PlayerBody`'s own `useFrame` needs
              // the LIVE per-tick sim output — see `PlayerBody`'s module doc.
              phase: () => runtimeRef.current.localLocomotionPhase,
              input: () => movementRef.current,
            }}
          />
        )}
      </group>

      {remoteIds.map(id => (
        <group
          key={id}
          ref={element => {
            if (element) remoteGroupsRef.current.set(id, element);
            else remoteGroupsRef.current.delete(id);
          }}
        >
          <PlayerBody identityHex={id} store={store} effects={effectsRef.current} ownsSceneEffects={false} />
        </group>
      ))}

      <EffectsView effects={effectsRef.current} store={store} />
    </>
  );
}

function JoinDialog({ onJoin, defaultName }: { onJoin: (name: string) => void; defaultName: string }) {
  const [name, setName] = useState(defaultName);
  return (
    <div className="join-overlay">
      <form
        className="join-card"
        onSubmit={event => {
          event.preventDefault();
          const trimmed = name.trim();
          if (trimmed) onJoin(trimmed);
        }}
      >
        <h1>mog</h1>
        <input
          autoFocus
          value={name}
          onChange={event => setName(event.target.value)}
          placeholder="name"
          maxLength={24}
        />
        <button type="submit" disabled={!name.trim()}>
          join
        </button>
      </form>
    </div>
  );
}

export function App() {
  const [store, setStore] = useState<GameStore>(createGameStore);
  const storeRef = useRef<GameStore>(store);
  const markReadyRef = useRef<() => void>(() => {});
  const [joined, setJoined] = useState(false);
  const [defaultName] = useState(loadSavedName);
  const containerRef = useRef<HTMLDivElement>(null);

  // `store` (state) is what render reads — refs can't be read during render (react-hooks/refs).
  // `storeRef` mirrors it for the non-render call sites below (subscription/polling callbacks),
  // which run outside React's render pass and would otherwise need `store` threaded through
  // every dependency array just to stay non-stale.
  useEffect(() => {
    storeRef.current = store;
  }, [store]);

  const registerTableCallbacks = useCallback((connection: DbConnection) => {
    const attached = attachGameStore(connection);
    storeRef.current = attached.store;
    markReadyRef.current = attached.markReady;
    setStore(attached.store);
    return attached.unsubscribe;
  }, []);

  const handleSubscriptionApplied = useCallback((_connection: DbConnection, id: Identity) => {
    markReadyRef.current();
    setJoined(storeRef.current.player.has(id.toHexString()));
  }, []);

  const handleDisconnected = useCallback(() => {
    setJoined(false);
  }, []);

  const { connRef, connected, identity } = useSpacetimeConnection({
    onDisconnected: handleDisconnected,
    onSubscriptionApplied: handleSubscriptionApplied,
    registerTableCallbacks,
  });

  const identityHex = identity?.toHexString() ?? null;

  // The `player` row (join confirmation) can arrive after subscription-applied already fired —
  // poll rather than thread a callback through every insert path for one boolean.
  useEffect(() => {
    if (!connected || joined || !identityHex) return;
    const id = window.setInterval(() => {
      if (storeRef.current.player.has(identityHex)) setJoined(true);
    }, HUD_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [connected, joined, identityHex]);

  const handleJoin = useCallback((name: string) => {
    saveName(name);
    connRef.current?.reducers.joinGame({ username: name });
  }, [connRef]);

  // Opens the input round trip that `frame.ts` closes when the matching ack arrives — the send
  // instant is knowable nowhere else. See `useInput`'s `onInputSent` doc.
  const handleInputSent = useCallback((sequence: number) => {
    sharedNetcodeMetrics.recordInputSent(sequence);
  }, []);

  const input = useInput({ connRef, active: joined, onInputSent: handleInputSent });

  // The perf overlay is a debug surface, so it rides the same `?qa` / VITE_QA_MODE gate as
  // `window.__mogGame` and stays absent from a normal production session. It mounts hidden;
  // the keymap's debug row (F3) reveals it. `storeRef` is read through a getter because the
  // store object is replaced when the connection attaches.
  useEffect(() => {
    if (!shouldEnableQaGameDebug()) return;
    const hud = mountPerfHud({
      metrics: sharedNetcodeMetrics,
      store: () => storeRef.current,
    });
    return () => hud.dispose();
  }, []);

  useEffect(() => {
    if (!joined) return;
    const element = containerRef.current;
    const handleClick = () => {
      if (!input.locked) input.requestPointerLock(document.body);
    };
    element?.addEventListener('click', handleClick);
    return () => element?.removeEventListener('click', handleClick);
  }, [joined, input]);

  const scene = useMemo(
    () => (
      <Scene
        store={store}
        identityHex={identityHex}
        movementRef={input.movementRef}
        rotationYRef={input.rotationYRef}
        pitchRef={input.pitchRef}
      />
    ),
    [store, identityHex, input.movementRef, input.rotationYRef, input.pitchRef],
  );

  return (
    <div className="game-shell" ref={containerRef}>
      <Canvas
        shadows
        camera={{ position: [0, 2.5, 5], fov: 55 }}
        gl={{ outputColorSpace: THREE.SRGBColorSpace, toneMapping: THREE.ACESFilmicToneMapping }}
      >
        {scene}
      </Canvas>

      {joined && <Hud store={store} identityHex={identityHex} />}
      {joined && !input.locked && <div className="lock-hint">click to play</div>}
      {!joined && connected && <JoinDialog onJoin={handleJoin} defaultName={defaultName} />}
      {!connected && <div className="connecting">connecting…</div>}
    </div>
  );
}
