/**
 * The reduced frame runtime: local-player CSP prediction/reconciliation,
 * remote interpolation, and third-person camera — called once per r3f frame.
 *
 * Salvaged from `git show 9f9fc5c:client/src/components/localPlayerFrame.ts`
 * (1,783 LOC) down to its load-bearing shape: predict on a fixed 20Hz tick,
 * reconcile from `player_transform` + `player_input_ack` by acked
 * `lastProcessedClientTick`, sample remotes through the already-built
 * `netcode.ts` (RenderTickClock + snapshot buffer — unchanged, reused
 * verbatim), and orbit a camera behind the local player. Everything the v1
 * file did for wizard aim targets, jump debug tracing, and per-class
 * animation timing is gone — that is presentation's job now
 * (`presentation/animBridge.ts`) or does not exist yet.
 *
 * `predictTick` is the CSP predictor: the authoritative movement sim
 * (`../sim/movement`'s `simulateMovementTick`) run against the same arena
 * ground/collision (`../sim/ground`'s `createArenaGround`) the server checks
 * transforms against, so a client-predicted position only ever needs a
 * correction from network jitter or an action-gated speed change the client
 * hasn't heard about yet — never from disagreeing physics.
 *
 * Locomotion (`../sim/locomotion`'s FSM) is derived per predicted tick from
 * the resulting sim state and exposed on `FrameRenderState.localLocomotion`
 * — presentation (`game/App.tsx`) reads it to pick a `motion.loco_*` key
 * without re-deriving grounded/moving/sprint state of its own.
 */

import * as THREE from 'three';
import {
  RenderTickClock,
  pushSnapshot,
  sampleBuffer,
  toSnapshot,
  type TransformSnapshot,
} from '../netcode';
import type { InputState } from '../generated/types';
import type { MovementState } from '../input/intents';
import { createArenaGround, type Ground } from '../sim/ground';
import {
  isGroundedAt,
  isMovingInput,
  phaseFor,
  type LocomotionPhase,
} from '../sim/locomotion';
import { simulateMovementTick, type PlayerSimState } from '../sim/movement';
import type { GameStore } from './sync';

const TICK_DT = 1 / 20; // matches ACTIONS_TICK_RATE / the server's fixed tick
const MAX_TICKS_PER_FRAME = 5; // a stalled tab catches up over several frames, never in one jump
const MAX_PREDICTED_TICKS = 128; // ~6.4s of buffered ticks at 20Hz — generous slack for a slow ack
const CAMERA_DISTANCE = 5;
const CAMERA_HEIGHT = 1.6;

/** One shared, stateless ground/collision resolver — the same rows `sim/ground.ts` bakes from `shared/arena.json`. */
const ARENA_GROUND: Ground = createArenaGround();

export interface PredictedTick {
  clientTick: number;
  input: MovementState;
  rotationY: number;
  movementFraction: number;
  /** The sim state immediately after this tick was applied. */
  result: PlayerSimState;
}

/** Wire-shaped movement input has no `sprint` (no default key binds it — see `docs/action-pipeline.md`). */
function toInputState(movement: MovementState): InputState {
  return { ...movement, sprint: false, sequence: 0, clientTick: 0 };
}

/** One fixed-tick step against the real authoritative sim + arena ground. */
export function predictTick(
  sim: PlayerSimState,
  input: MovementState,
  rotationY: number,
  movementFraction: number,
): PlayerSimState {
  return simulateMovementTick(sim, toInputState(input), rotationY, ARENA_GROUND, TICK_DT, movementFraction);
}

/** The locomotion phase a just-applied tick settled into — see module doc. */
function locomotionPhaseFor(result: PlayerSimState, input: MovementState): LocomotionPhase {
  return phaseFor(
    isGroundedAt(result.position, ARENA_GROUND.groundY),
    result.verticalVelocity,
    isMovingInput(toInputState(input)),
    result.sprintActive,
  );
}

export interface ReconcileResult {
  sim: PlayerSimState;
  remaining: PredictedTick[];
}

/**
 * Standard CSP reconcile: drop every predicted tick the server has already
 * processed (`clientTick <= lastProcessedClientTick`), snap to the server's
 * authoritative position for what's left, and replay the remaining ticks'
 * own recorded input/rotation/movementFraction — never re-derived, so a
 * replay is deterministic even if the live input has since changed.
 *
 * Vertical velocity/rotation/sprint state do not travel over the wire (the
 * server only sends position), so the replay inherits whatever the first
 * remaining predicted tick already computed for them rather than resetting
 * to zero — otherwise every reconcile would cancel an in-flight jump.
 */
export function reconcileLocalPrediction(
  predicted: readonly PredictedTick[],
  serverPosition: { x: number; y: number; z: number },
  lastProcessedClientTick: number,
): ReconcileResult {
  const pending = predicted.filter(tick => tick.clientTick > lastProcessedClientTick);

  let sim: PlayerSimState = {
    position: { ...serverPosition },
    rotationY: pending[0]?.result.rotationY ?? 0,
    verticalVelocity: pending[0]?.result.verticalVelocity ?? 0,
    wasJumpPressed: pending[0]?.result.wasJumpPressed ?? false,
    sprintActive: pending[0]?.result.sprintActive ?? false,
  };

  const remaining: PredictedTick[] = [];
  for (const tick of pending) {
    sim = predictTick(sim, tick.input, tick.rotationY, tick.movementFraction);
    remaining.push({ ...tick, result: sim });
  }

  return { sim, remaining };
}

export interface OrbitCamera {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
}

/** Third-person orbit: camera trails the facing direction, offset up by `height`. */
export function computeOrbitCamera(
  target: THREE.Vector3,
  yaw: number,
  pitch: number,
  distance: number = CAMERA_DISTANCE,
  height: number = CAMERA_HEIGHT,
): OrbitCamera {
  const cosPitch = Math.cos(pitch);
  // Forward is -Z at yaw=0, matching input/useInput.ts's aimVectorFor and the server's convention.
  const forward = new THREE.Vector3(-Math.sin(yaw) * cosPitch, Math.sin(pitch), -Math.cos(yaw) * cosPitch);
  const lookAt = target.clone().add(new THREE.Vector3(0, height, 0));
  const position = lookAt.clone().addScaledVector(forward, -distance);
  return { position, lookAt };
}

export interface FrameRuntimeState {
  local: PlayerSimState;
  /** The locomotion phase the most recent predicted (or reconciled-idle) tick settled into. */
  localLocomotionPhase: LocomotionPhase;
  predicted: PredictedTick[];
  clientTickCounter: number;
  lastProcessedClientTick: number;
  /** `player_transform.serverTick` as of the last reconcile — see `reconcileFromStore`. */
  lastServerTick: bigint | null;
  initializedFromServer: boolean;
  accumulatorSeconds: number;
  renderTickClock: RenderTickClock;
  snapshotBuffers: Map<string, TransformSnapshot[]>;
}

export function createFrameRuntimeState(): FrameRuntimeState {
  return {
    local: { position: { x: 0, y: 0, z: 0 }, rotationY: 0, verticalVelocity: 0, wasJumpPressed: false, sprintActive: false },
    localLocomotionPhase: 'grounded_idle',
    predicted: [],
    clientTickCounter: 0,
    lastProcessedClientTick: 0,
    lastServerTick: null,
    initializedFromServer: false,
    accumulatorSeconds: 0,
    renderTickClock: new RenderTickClock(),
    snapshotBuffers: new Map(),
  };
}

export interface StepFrameContext {
  dtSeconds: number;
  store: GameStore;
  /** Local player's identity, hex-encoded — the same key sync.ts uses. Null before joining. */
  localIdentityHex: string | null;
  movement: MovementState;
  /** Facing yaw AND camera yaw — see input/useInput.ts's module doc for why they're one value. */
  rotationY: number;
  pitch: number;
  /** From `actions/gates.ts`'s `deriveGates(localActionId, localPhase).movementFraction`. */
  movementFraction: number;
  /**
   * From `actions/gates.ts`'s `deriveGates(localActionId, localPhase).canRotate`. `false`
   * freezes the predicted CHARACTER yaw (movement direction + rendered facing) at whatever it
   * last was — mirroring the server's `can_rotate` gate in `tick.rs::game_tick` — while `rotationY`
   * above (mouse-look / camera orbit) keeps moving freely; see `predictPendingTicks` and
   * `stepFrame`'s `localRotationY`.
   */
  canRotate: boolean;
}

export interface RemoteRenderState {
  position: THREE.Vector3;
  rotationY: number;
}

export interface FrameRenderState {
  localPosition: THREE.Vector3;
  localRotationY: number;
  /** For presentation's `motion.loco_*` key selection — see module doc. */
  localLocomotionPhase: LocomotionPhase;
  remotes: ReadonlyMap<string, RemoteRenderState>;
  camera: OrbitCamera;
}

/** Called once per r3f frame (useFrame). Mutates `runtime` in place; returns what to render. */
export function stepFrame(runtime: FrameRuntimeState, ctx: StepFrameContext): FrameRenderState {
  reconcileFromStore(runtime, ctx);
  predictPendingTicks(runtime, ctx);
  const remotes = sampleRemotes(runtime, ctx);

  const localPosition = new THREE.Vector3(
    runtime.local.position.x,
    runtime.local.position.y,
    runtime.local.position.z,
  );
  const camera = computeOrbitCamera(localPosition, ctx.rotationY, ctx.pitch);

  return {
    localPosition,
    // Camera stays free (`camera` above, computed straight off `ctx.rotationY`) even when the
    // character can't rotate — only the character's own rendered facing freezes, matching
    // `runtime.local.rotationY`, the same frozen value `predictPendingTicks` fed the sim.
    localRotationY: ctx.canRotate ? ctx.rotationY : runtime.local.rotationY,
    localLocomotionPhase: runtime.localLocomotionPhase,
    remotes,
    camera,
  };
}

function reconcileFromStore(runtime: FrameRuntimeState, ctx: StepFrameContext): void {
  if (!ctx.localIdentityHex) return;
  const transform = ctx.store.playerTransform.get(ctx.localIdentityHex);
  if (!transform) return;

  if (!runtime.initializedFromServer) {
    runtime.local = {
      position: { x: transform.position.x, y: transform.position.y, z: transform.position.z },
      rotationY: transform.rotationY,
      verticalVelocity: 0,
      wasJumpPressed: false,
      sprintActive: false,
    };
    runtime.predicted = [];
    runtime.initializedFromServer = true;
    runtime.lastServerTick = transform.serverTick;
    return;
  }

  // Gated on `player_transform.serverTick` — NOT on a fresh `player_input_ack` — because not
  // every authoritative position change is input-driven: `roll`'s `displace_self` effect (and
  // any future knockback/pull) moves the actor straight through
  // `player_logic`/`collision::resolve_player_movement` without ever touching
  // `update_player_input`, so no new ack accompanies it. `player_transform` only republishes on
  // an actual pose delta (`transform_needs_publish_from_snapshot` — no idle rebroadcast), so
  // "the row changed" is exactly "there is a correction worth reconciling," ack or not.
  if (transform.serverTick === runtime.lastServerTick) return;
  runtime.lastServerTick = transform.serverTick;

  const ack = ctx.store.playerInputAck.get(ctx.localIdentityHex);
  const lastProcessedClientTick = ack?.lastProcessedClientTick ?? runtime.lastProcessedClientTick;

  const { sim, remaining } = reconcileLocalPrediction(
    runtime.predicted,
    transform.position,
    lastProcessedClientTick,
  );
  runtime.local = sim;
  runtime.predicted = remaining;
  runtime.lastProcessedClientTick = lastProcessedClientTick;
}

function predictPendingTicks(runtime: FrameRuntimeState, ctx: StepFrameContext): void {
  runtime.accumulatorSeconds += ctx.dtSeconds;
  let ticksThisFrame = 0;

  while (runtime.accumulatorSeconds >= TICK_DT && ticksThisFrame < MAX_TICKS_PER_FRAME) {
    runtime.accumulatorSeconds -= TICK_DT;
    ticksThisFrame += 1;
    runtime.clientTickCounter += 1;

    // Frozen character yaw: when `canRotate` is false, feed the sim its own last predicted
    // yaw instead of the live camera yaw — the same value the server's `can_rotate` gate keeps
    // `player_transform.rotation_y` pinned to (`tick.rs::game_tick`), so movement direction AND
    // rendered facing both stay put on this side too, never predicting ahead of the correction.
    const rotationY = ctx.canRotate ? ctx.rotationY : runtime.local.rotationY;
    const result = predictTick(runtime.local, ctx.movement, rotationY, ctx.movementFraction);
    runtime.local = result;
    runtime.localLocomotionPhase = locomotionPhaseFor(result, ctx.movement);
    runtime.predicted.push({
      clientTick: runtime.clientTickCounter,
      input: ctx.movement,
      rotationY,
      movementFraction: ctx.movementFraction,
      result,
    });
    if (runtime.predicted.length > MAX_PREDICTED_TICKS) runtime.predicted.shift();
  }
}

/** Remotes ride netcode.ts unchanged: push whatever's in the store, sample the render tick. */
function sampleRemotes(
  runtime: FrameRuntimeState,
  ctx: StepFrameContext,
): ReadonlyMap<string, RemoteRenderState> {
  for (const [identityHex, transform] of ctx.store.playerTransform) {
    if (identityHex === ctx.localIdentityHex) continue;
    pushSnapshot(runtime.snapshotBuffers, identityHex, toSnapshot(transform), runtime.renderTickClock);
  }

  const renderTick = runtime.renderTickClock.advance(ctx.dtSeconds);
  const remotes = new Map<string, RemoteRenderState>();
  for (const identityHex of runtime.snapshotBuffers.keys()) {
    if (identityHex === ctx.localIdentityHex) continue;
    const sample = sampleBuffer(runtime.snapshotBuffers.get(identityHex), renderTick);
    if (sample) remotes.set(identityHex, { position: sample.position, rotationY: sample.rotationY });
  }
  return remotes;
}
