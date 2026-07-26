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
 * (`presentation/animBridge.ts`, agent E) or does not exist yet.
 *
 * `predictTick` is the ONE integration seam for agent M's authoritative
 * movement simulation (`../sim/movement`, a parallel worktree — not present
 * in this tree). Until it lands, `localSimFallback.ts` stands in: flat
 * ground, no collision. Flip the import below when it does.
 */

import * as THREE from 'three';
import {
  RenderTickClock,
  pushSnapshot,
  sampleBuffer,
  toSnapshot,
  type TransformSnapshot,
} from '../netcode';
import type { GameStore } from './sync';
// integration: wave2-movement — swap for `import { simulateMovementTick } from '../sim/movement'`
// once agent M's module lands, keeping the same (state, input, rotationY, movementFraction,
// dtSeconds) => state signature.
import {
  simulateMovementTickFallback as simulateMovementTick,
  type MovementInput,
  type MovementSimState,
} from './localSimFallback';

const TICK_DT = 1 / 20; // matches ACTIONS_TICK_RATE / the server's fixed tick
const MAX_TICKS_PER_FRAME = 5; // a stalled tab catches up over several frames, never in one jump
const MAX_PREDICTED_TICKS = 128; // ~6.4s of buffered ticks at 20Hz — generous slack for a slow ack
const CAMERA_DISTANCE = 5;
const CAMERA_HEIGHT = 1.6;

export interface PredictedTick {
  clientTick: number;
  input: MovementInput;
  rotationY: number;
  movementFraction: number;
  /** The sim state immediately after this tick was applied. */
  result: MovementSimState;
}

/** One fixed-tick step. The sole call site `predictTick` funnels through, for the integration seam above. */
export function predictTick(
  sim: MovementSimState,
  input: MovementInput,
  rotationY: number,
  movementFraction: number,
): MovementSimState {
  return simulateMovementTick(sim, input, rotationY, movementFraction, TICK_DT);
}

export interface ReconcileResult {
  sim: MovementSimState;
  remaining: PredictedTick[];
}

/**
 * Standard CSP reconcile: drop every predicted tick the server has already
 * processed (`clientTick <= lastProcessedClientTick`), snap to the server's
 * authoritative position for what's left, and replay the remaining ticks'
 * own recorded input/rotation/movementFraction — never re-derived, so a
 * replay is deterministic even if the live input has since changed.
 *
 * Vertical velocity/grounded state do not travel over the wire (the server
 * only sends position), so the replay inherits whatever the first remaining
 * predicted tick already computed for them rather than resetting to zero —
 * otherwise every reconcile would cancel an in-flight jump.
 */
export function reconcileLocalPrediction(
  predicted: readonly PredictedTick[],
  serverPosition: { x: number; y: number; z: number },
  lastProcessedClientTick: number,
): ReconcileResult {
  const pending = predicted.filter(tick => tick.clientTick > lastProcessedClientTick);

  let sim: MovementSimState = {
    position: { ...serverPosition },
    verticalVelocity: pending[0]?.result.verticalVelocity ?? 0,
    isGrounded: pending[0]?.result.isGrounded ?? true,
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
  local: MovementSimState;
  predicted: PredictedTick[];
  clientTickCounter: number;
  lastProcessedClientTick: number;
  initializedFromServer: boolean;
  accumulatorSeconds: number;
  renderTickClock: RenderTickClock;
  snapshotBuffers: Map<string, TransformSnapshot[]>;
}

export function createFrameRuntimeState(): FrameRuntimeState {
  return {
    local: { position: { x: 0, y: 0, z: 0 }, verticalVelocity: 0, isGrounded: true },
    predicted: [],
    clientTickCounter: 0,
    lastProcessedClientTick: 0,
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
  movement: MovementInput;
  /** Facing yaw AND camera yaw — see input/useInput.ts's module doc for why they're one value. */
  rotationY: number;
  pitch: number;
  /** From `actions/gates.ts`'s `deriveGates(localActionId, localPhase).movementFraction`. */
  movementFraction: number;
}

export interface RemoteRenderState {
  position: THREE.Vector3;
  rotationY: number;
}

export interface FrameRenderState {
  localPosition: THREE.Vector3;
  localRotationY: number;
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

  return { localPosition, localRotationY: ctx.rotationY, remotes, camera };
}

function reconcileFromStore(runtime: FrameRuntimeState, ctx: StepFrameContext): void {
  if (!ctx.localIdentityHex) return;
  const transform = ctx.store.playerTransform.get(ctx.localIdentityHex);
  if (!transform) return;

  if (!runtime.initializedFromServer) {
    runtime.local = {
      position: { x: transform.position.x, y: transform.position.y, z: transform.position.z },
      verticalVelocity: 0,
      isGrounded: true,
    };
    runtime.predicted = [];
    runtime.initializedFromServer = true;
    return;
  }

  const ack = ctx.store.playerInputAck.get(ctx.localIdentityHex);
  if (!ack || ack.lastProcessedClientTick === runtime.lastProcessedClientTick) return;

  const { sim, remaining } = reconcileLocalPrediction(
    runtime.predicted,
    transform.position,
    ack.lastProcessedClientTick,
  );
  runtime.local = sim;
  runtime.predicted = remaining;
  runtime.lastProcessedClientTick = ack.lastProcessedClientTick;
}

function predictPendingTicks(runtime: FrameRuntimeState, ctx: StepFrameContext): void {
  runtime.accumulatorSeconds += ctx.dtSeconds;
  let ticksThisFrame = 0;

  while (runtime.accumulatorSeconds >= TICK_DT && ticksThisFrame < MAX_TICKS_PER_FRAME) {
    runtime.accumulatorSeconds -= TICK_DT;
    ticksThisFrame += 1;
    runtime.clientTickCounter += 1;

    const result = predictTick(runtime.local, ctx.movement, ctx.rotationY, ctx.movementFraction);
    runtime.local = result;
    runtime.predicted.push({
      clientTick: runtime.clientTickCounter,
      input: ctx.movement,
      rotationY: ctx.rotationY,
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
