/**
 * The game shell: connect, join, render.
 *
 * `useSpacetimeConnection` (kept from before this rewrite) owns the socket;
 * this component wires its two callbacks to `sync.ts`'s generic table→store
 * mechanism, shows a join dialog until a `player` row exists for our
 * identity, then mounts the r3f scene and HUD. Movement/camera live in
 * `frame.ts`, driven once per r3f frame from here.
 *
 * `// integration: wave2-anim` marks where agent E's presentation layer
 * (skinned rig + AnimationController) replaces the placeholder capsules.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Identity } from 'spacetimedb';
import { deriveGates } from '../actions/gates';
import type { DbConnection } from '../generated';
import { useInput } from '../input/useInput';
import { useSpacetimeConnection } from '../network/useSpacetimeConnection';
import { shouldEnableQaGameDebug } from '../qaGate';
import { Hud } from './Hud';
import { createFrameRuntimeState, stepFrame } from './frame';
import { attachGameStore, createGameStore, type GameStore } from './sync';

const PLAYER_NAME_KEY = 'mog.playerName';
const HUD_POLL_INTERVAL_MS = 200;

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
    };
  }
}

function PlayerCapsule({ color }: { color: string }) {
  return (
    // integration: wave2-anim — a placeholder capsule stands in for the skinned rig.
    <mesh castShadow position={[0, 0.9, 0]}>
      <capsuleGeometry args={[0.35, 1.1, 4, 8]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
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
      window.__mogGame = {
        localPosition: { x: render.localPosition.x, y: render.localPosition.y, z: render.localPosition.z },
        remoteCount: render.remotes.size,
        joined: identityHex !== null,
        identityHex,
        store,
      };
    }
  });

  return (
    <>
      <hemisphereLight intensity={1.1} color="#cfd8ee" groundColor="#2a2118" />
      <directionalLight position={[6, 10, 4]} intensity={2} castShadow />
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[200, 200]} />
        <meshStandardMaterial color="#1c2030" />
      </mesh>

      <group ref={localGroupRef}>
        <PlayerCapsule color="#7fd1ff" />
      </group>

      {remoteIds.map(id => (
        <group
          key={id}
          ref={element => {
            if (element) remoteGroupsRef.current.set(id, element);
            else remoteGroupsRef.current.delete(id);
          }}
        >
          <PlayerCapsule color="#ff9f7f" />
        </group>
      ))}
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

  const input = useInput({ connRef, active: joined });

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
