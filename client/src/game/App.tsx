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
import {
  useSpacetimeConnection,
  type ConnectionStatus,
  type SubscriptionAppliedInfo,
} from '../network/useSpacetimeConnection';
import { createEffects } from '../presentation/effects';
import { mountPerfHud } from '../perf/hud';
import { sharedNetcodeMetrics, type NetcodeSnapshot } from '../perf/metrics';
import { shouldEnableQaGameDebug } from '../qaGate';
import { Arena } from '../world/Arena';
import { EffectsView } from './EffectsView';
import { createFrameRuntimeState, stepFrame, type FrameDiagnostics } from './frame';
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
      /**
       * Per-frame CSP reconcile state (`frame.ts`'s `FrameDiagnostics`) — what the
       * `input_churn` detector (`qa-harness/input-churn.ts`) asserts the MECHANISM against,
       * not just the rendered symptom. Deliberately separate from `netcode` above: that one
       * is smoothed for a human reading the F3 HUD, this one is the raw per-frame truth an
       * assertion needs. Rebuilt each frame, so a sampler must copy it, not hold it.
       */
      reconcile: FrameDiagnostics;
    };
  }
}

interface SceneProps {
  store: GameStore;
  identityHex: string | null;
  movementRef: React.MutableRefObject<{ forward: boolean; backward: boolean; left: boolean; right: boolean; jump: boolean }>;
  rotationYRef: React.MutableRefObject<number>;
  pitchRef: React.MutableRefObject<number>;
  /** Bumps on every (re)connect — see the reset effect below. */
  connectionEpoch: number;
  /** Written by `frame.ts`, read by `useInput` — see `StepFrameContext.clientTickRef`. */
  clientTickRef: React.MutableRefObject<number>;
}

function Scene({
  store,
  identityHex,
  movementRef,
  rotationYRef,
  pitchRef,
  connectionEpoch,
  clientTickRef,
}: SceneProps) {
  const runtimeRef = useRef(createFrameRuntimeState());
  const localGroupRef = useRef<THREE.Group>(null);
  const remoteGroupsRef = useRef(new Map<string, THREE.Group>());
  const [remoteIds, setRemoteIds] = useState<string[]>([]);
  const effectsRef = useRef(createEffects());
  const lastNetcodePublishRef = useRef(0);

  /**
   * Client-side prediction reset on reconnect.
   *
   * `frame.ts` accumulates predicted ticks that are only retired when the
   * server acks their `clientTick`. Those acks die with the socket, so a
   * reconnect that kept the old runtime would replay a backlog of pre-drop
   * inputs against a freshly-restored server position and teleport the player.
   *
   * The reset is a whole new `FrameRuntimeState` rather than a mutating
   * `reset()` on the existing one: `createFrameRuntimeState` is frame.ts's own
   * exported constructor and is by definition complete, so this cannot drift
   * out of date as fields are added to the struct — and it needs no new API
   * from frame.ts. `initializedFromServer` starts false again, so the first
   * post-reconnect `reconcileFromStore` re-seeds position straight from the
   * server's `player_transform` row.
   *
   * The effect deliberately skips its first run (epoch 1 is the initial
   * connect, whose state was just constructed above).
   *
   * Rebuilding is safe for the netcode instrumentation too, which is easy to
   * doubt: `createFrameRuntimeState` defaults its `metrics` parameter to the
   * module-level `sharedNetcodeMetrics`, the same object `mountPerfHud` holds,
   * so a fresh runtime re-attaches to it rather than orphaning the overlay.
   */
  const lastEpochRef = useRef(connectionEpoch);
  useEffect(() => {
    if (connectionEpoch === lastEpochRef.current) return;
    lastEpochRef.current = connectionEpoch;
    runtimeRef.current = createFrameRuntimeState();
  }, [connectionEpoch]);

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
      clientTickRef,
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
        reconcile: render.diagnostics,
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

  /**
   * True once this page has joined at least once. Both a ref and state on
   * purpose: `handleSubscriptionApplied` reads it from a callback (where state
   * would be stale), and render reads it to tell a *first* join apart from a
   * session being restored. It must survive `joined` being reset to false by
   * the very drop it exists to recover from, so a disconnect never clears it —
   * only coming back as a different identity does (see below).
   */
  const hadJoinedRef = useRef(false);
  const [hadJoined, setHadJoined] = useState(false);
  /** The identity the last applied subscription came back as — see the reset below. */
  const lastIdentityHexRef = useRef<string | null>(null);

  /**
   * The single writer for `joined`, so "we are in the world" and "we have been in
   * the world" can never disagree. Both call sites that can turn `joined` on go
   * through here; an effect mirroring `joined` into `hadJoined` would be a
   * cascading render for a value already known at the moment of the change.
   */
  const markJoined = useCallback((next: boolean) => {
    setJoined(next);
    if (!next) return;
    hadJoinedRef.current = true;
    setHadJoined(true);
  }, []);

  const handleSubscriptionApplied = useCallback(
    (connection: DbConnection, id: Identity, { reconnected }: SubscriptionAppliedInfo) => {
      markReadyRef.current();

      const identityHex = id.toHexString();
      const hasPlayerRow = storeRef.current.player.has(identityHex);
      markJoined(hasPlayerRow);

      // Coming back as a DIFFERENT identity is not this session returning — it is
      // a different player. That happens whenever the saved token stops applying:
      // `forgetSavedConnection` wipes it deliberately, and a server that rejects
      // it hands back a fresh anonymous identity. Treating those as a restore
      // would silently auto-rejoin the new identity under the previous player's
      // cached name and never offer the name field again, so the session flags
      // reset and the flow falls back to a normal first join.
      //
      // Keyed on the identity rather than on `hasSavedCharacter` because the
      // identity is the thing that actually determines whether the server has a
      // character to give back.
      const previousIdentityHex = lastIdentityHexRef.current;
      lastIdentityHexRef.current = identityHex;
      if (previousIdentityHex !== null && previousIdentityHex !== identityHex) {
        hadJoinedRef.current = false;
        setHadJoined(false);
        return;
      }

      // A dropped session is cleaned up server-side: `identity_disconnected`
      // folds the live player rows into `logged_out_player` (server/spacetimedb/
      // src/lib.rs, player.rs). The saved token brings the identity back, but
      // only `join_game` brings the *character* back — it restores the archived
      // row, keeping the original username, health and position, and is a
      // documented no-op if a live row somehow survived. So re-issuing it is
      // both necessary and safe, and it is what makes recovery invisible
      // instead of dumping the player back on the join dialog.
      if (reconnected && !hasPlayerRow && hadJoinedRef.current) {
        connection.reducers.joinGame({ username: loadSavedName() || 'player' });
      }
    },
    [],
  );

  const handleDisconnected = useCallback(() => {
    setJoined(false);
  }, []);

  const { connRef, connected, identity, status, reconnectAttempt, connectionEpoch } =
    useSpacetimeConnection({
      onDisconnected: handleDisconnected,
      onSubscriptionApplied: handleSubscriptionApplied,
      registerTableCallbacks,
    });

  const identityHex = identity?.toHexString() ?? null;

  /**
   * The socket is back but the character is not yet: the server archived the
   * player row on disconnect, so there is a gap between `connected` and the
   * automatic `join_game` landing. Naming it matters — without it, render falls
   * through to the branch that means "a new player needs to pick a name".
   */
  const restoringSession = hadJoined && !joined;

  // The `player` row (join confirmation) can arrive after subscription-applied already fired —
  // poll rather than thread a callback through every insert path for one boolean.
  useEffect(() => {
    if (!connected || joined || !identityHex) return;
    const id = window.setInterval(() => {
      if (storeRef.current.player.has(identityHex)) markJoined(true);
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

  // One client-tick number line for the whole local player: `frame.ts`'s predictor advances
  // it, `useInput` stamps outgoing input with it, the server echoes it back as
  // `lastProcessedClientTick`, and the predictor slices its buffer against the echo. Owned
  // here because it is the one thing prediction and input must agree on, and this is their
  // only common ancestor. See `frame.ts`'s `StepFrameContext.clientTickRef`.
  const clientTickRef = useRef(0);

  // `connected` gates alongside `joined`: input is frozen — dropped, not queued —
  // while the socket is down. A movement intent from before the drop describes a
  // world state the server has already moved past, so replaying it on reconnect
  // would fight the authoritative position rather than help. Movement resumes
  // fresh from whatever keys are actually held once we are back. It also keeps
  // the netcode metrics honest: an input that was never sent must not open a
  // round trip that can never close.
  const input = useInput({
    connRef,
    active: joined && connected,
    clientTickRef,
    onInputSent: handleInputSent,
  });

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
        connectionEpoch={connectionEpoch}
        clientTickRef={clientTickRef}
      />
    ),
    [
      store,
      identityHex,
      input.movementRef,
      input.rotationYRef,
      input.pitchRef,
      connectionEpoch,
      clientTickRef,
    ],
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
      {joined && !input.locked && connected && <div className="lock-hint">click to play</div>}
      {/* `!hadJoined` is load-bearing, not defensive. Without it a reconnect
          renders this dialog for the moment between the socket returning and the
          automatic rejoin landing — and its `autoFocus` input pulls focus, which
          exits pointer lock, which silently drops every subsequent key. The
          player gets a session that looks recovered but cannot be moved. */}
      {!joined && connected && !hadJoined && (
        <JoinDialog onJoin={handleJoin} defaultName={defaultName} />
      )}

      {/* First connect of the page's life: the world is not there yet, so the
          full-bleed message is right. A *re*connect keeps the last-known world
          on screen behind an unobtrusive banner instead — the player can still
          see where they were, and recovery is usually over in well under a
          second. */}
      {status === 'connecting' && <div className="connecting">connecting…</div>}
      {(status === 'reconnecting' || status === 'offline-retrying' || restoringSession) && (
        <ReconnectBanner
          status={status}
          attempt={reconnectAttempt}
          restoring={connected && restoringSession}
        />
      )}
    </div>
  );
}

function ReconnectBanner({
  status,
  attempt,
  restoring,
}: {
  status: ConnectionStatus;
  attempt: number;
  /** Socket is back; we are waiting on the server to hand the character back. */
  restoring: boolean;
}) {
  const label = restoring
    ? 'restoring session…'
    : status === 'offline-retrying'
      ? 'connection lost — still trying'
      : 'reconnecting…';
  return (
    <div
      className="reconnect-banner"
      role="status"
      aria-live="polite"
      data-qa-reconnect={restoring ? 'restoring' : status}
    >
      <span className="reconnect-banner__dot" />
      <span>{label}</span>
      {/* The attempt count is the honest signal that something is still happening
          during the longer backoff waits, where nothing else on screen moves. It
          is meaningless once the socket is back, so the restore phase omits it. */}
      {!restoring && <span className="reconnect-banner__attempt">attempt {attempt}</span>}
    </div>
  );
}
