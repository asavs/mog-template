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
 *
 * `visualCorrectionOffset` is the fix for a real-latency teleport bug: every
 * reconcile (`reconcileFromStore`) used to snap `runtime.local.position` —
 * which IS the rendered position — straight to the freshly-replayed
 * authoritative result. At low/local latency the replay result barely
 * differs from what was already on screen, so the snap is invisible. Under
 * real latency, more ticks are in flight and the replay result diverges
 * further from the last frame's render, so the same unsmoothed snap reads as
 * a teleport (#216's 8+ unit single-frame jump). The fix salvaged from the
 * pre-rewrite `components/localPlayerFrame.ts` (see `git show
 * 9f9fc5c:client/src/components/localPlayerFrame.ts`): keep the corrected
 * physics position (`runtime.local`) authoritative for the NEXT predicted
 * tick, but render `runtime.local.position + visualCorrectionOffset`, where
 * the offset starts at (old render position - new corrected position) and
 * decays toward zero over `VISUAL_CORRECTION_DECAY_RATE`. A correction
 * bigger than `VISUAL_CORRECTION_SNAP_METERS` (e.g. roll's ~4-unit
 * `displace_self`) skips the glide and snaps instantly instead — a
 * multi-unit dash should not visibly slide, only genuine prediction error
 * should. The glide's own speed is capped at `MAX_CORRECTION_CATCHUP_SPEED`
 * so catching up can never make the character outrun its own top speed.
 *
 * Reconciliation depends on one invariant that lives outside this file: the
 * predicted-tick numbering and the `clientTick` the client puts on the wire
 * must be the same number line, because the server's ack echoes the latter and
 * `reconcileLocalPrediction` slices the former against it. See
 * `StepFrameContext.clientTickRef` — that is where the rubberbanding
 * `qa-harness/input-churn.ts` exists to catch came from.
 *
 * Instrumentation (`runtime.metrics`, see `../perf/metrics.ts`) is recorded
 * here rather than anywhere downstream because this is the only place the
 * numbers still exist un-smoothed. By the time a position reaches the
 * renderer, `visualCorrectionOffset` has deliberately hidden the correction
 * that this file just applied — the very quantity a feel-tester needs to see.
 * `FrameDiagnostics` is the second, complementary half of that: `metrics` is
 * the smoothed, human-facing feel summary the F3 HUD draws (rates and
 * percentiles), while `FrameDiagnostics` is the raw per-frame reconcile state
 * an automated gate asserts on. Every recording call in either is
 * observational: no branch, ordering, or value in the reconcile path depends
 * on it, so instrumentation can never change what the simulation does.
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
  PLAYER_SPEED,
  type LocomotionPhase,
} from '../sim/locomotion';
import { simulateMovementTick, type PlayerSimState } from '../sim/movement';
import { sharedNetcodeMetrics, type NetcodeMetrics } from '../perf/metrics';
import type { GameStore } from './sync';

const TICK_DT = 1 / 20; // matches ACTIONS_TICK_RATE / the server's fixed tick
const MAX_TICKS_PER_FRAME = 5; // a stalled tab catches up over several frames, never in one jump
const MAX_PREDICTED_TICKS = 128; // ~6.4s of buffered ticks at 20Hz — generous slack for a slow ack
const CAMERA_DISTANCE = 5;
const CAMERA_HEIGHT = 1.6;
// Tuning carried over unchanged from the pre-rewrite file (git show
// 9f9fc5c:client/src/components/localPlayerFrame.ts) — already proven live.
const VISUAL_CORRECTION_DECAY_RATE = 12; // 1/s exponential decay toward zero offset
const VISUAL_CORRECTION_SNAP_METERS = 3.0; // corrections bigger than this snap instantly instead
/**
 * Speed ceiling on the glide itself, in units/s.
 *
 * The rendered position is `local.position + visualCorrectionOffset`, and both terms move —
 * so while a correction glides out, the character travels at walk speed PLUS the glide rate.
 * Exponential decay is fastest at the instant the correction lands, which is exactly when
 * that reads as a lurch: at `VISUAL_CORRECTION_DECAY_RATE` = 12/s, a 1m offset starts
 * unwinding at 12u/s on top of 6u/s of walking, i.e. the character visibly outruns its own
 * top speed by 3x. Measured live at 1.66m of rendered travel inside a 100ms window (16.6u/s)
 * with the reconcile itself behaving correctly.
 *
 * Half of `PLAYER_SPEED` caps the total at 1.5x — fast enough that a 1m correction is gone in
 * 330ms (the unclamped exponential took ~380ms to reach 1%, so nothing gets slower in
 * practice), and slow enough that catching up never looks like a dash. The exponential shape
 * is kept below the cap, so small corrections — the overwhelming majority — glide exactly as
 * they did before; only the leading edge of a big one is flattened.
 */
const MAX_CORRECTION_CATCHUP_SPEED = PLAYER_SPEED * 0.5;

type Vec3Like = { x: number; y: number; z: number };

function zeroVec3(): Vec3Like {
  return { x: 0, y: 0, z: 0 };
}

function addVec3(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subVec3(a: Vec3Like, b: Vec3Like): Vec3Like {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

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
  /** Predicted ticks this reconcile DISCARDED as already-processed by the server. */
  dropped: number;
}

/**
 * Standard CSP reconcile: drop every predicted tick the server has already
 * processed (`clientTick <= lastProcessedClientTick`), snap to the server's
 * authoritative position for what's left, and replay the remaining ticks'
 * own recorded input/rotation/movementFraction — never re-derived, so a
 * replay is deterministic even if the live input has since changed.
 *
 * This is only sound while `PredictedTick.clientTick` and the server's
 * `lastProcessedClientTick` are THE SAME NUMBER LINE. Enforcing that is
 * `StepFrameContext.clientTickRef`'s entire job — see its doc for what
 * happens when they drift apart.
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

  return { sim, remaining, dropped: predicted.length - pending.length };
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
  /**
   * Rendered position minus `local.position` — see module doc. Decays toward zero every frame
   * (`decayVisualCorrectionOffset`); a reconcile that produces a huge correction (a real dash
   * like roll, not prediction error) resets it straight to zero instead, so the render position
   * jumps immediately, same as before this offset existed.
   */
  visualCorrectionOffset: Vec3Like;
  /**
   * Netcode-feel instrumentation. Purely observational: nothing on this object is ever read
   * back by prediction, reconciliation, or rendering. It lives here because this is the only
   * place the interesting numbers exist un-smoothed — see the "instrumentation" note in the
   * module doc.
   */
  metrics: NetcodeMetrics;
  /** Pure observation — see `FrameDiagnostics`. Nothing here feeds back into prediction. */
  diagnostics: ReconcileDiagnostics;
}

/**
 * The running reconcile tallies `stepFrame` folds into every `FrameDiagnostics`.
 * Updated only by `reconcileFromStore`; never read by prediction.
 */
interface ReconcileDiagnostics {
  corrections: number;
  lastCorrectionMagnitude: number;
  lastCorrectionSnapped: boolean;
  lastCorrectionDropped: number;
  lastCorrectionReplayed: number;
}

function createReconcileDiagnostics(): ReconcileDiagnostics {
  return {
    corrections: 0,
    lastCorrectionMagnitude: 0,
    lastCorrectionSnapped: false,
    lastCorrectionDropped: 0,
    lastCorrectionReplayed: 0,
  };
}

/**
 * Per-frame reconciliation telemetry. `game/App.tsx` publishes it on
 * `window.__mogGame.reconcile` behind the QA gate (`qaGate.ts`) so
 * `qa-harness/input-churn.ts` can assert on the MECHANISM (which predicted ticks a
 * reconcile kept, how big the resulting correction was) instead of only on the
 * rendered symptom. Purely additive: computing it changes nothing about what the
 * frame simulates or renders.
 *
 * Distinct from `__mogGame.netcode` (`perf/metrics.ts`'s `NetcodeSnapshot`, drawn by the
 * F3 HUD), and deliberately so — that one is a rolling window of rates and percentiles
 * built for a human reading a live overlay, and its smoothing is exactly what makes it
 * unusable as a gate. An assertion needs to know that THIS reconcile discarded THESE
 * ticks; a p95 over five seconds cannot say that. The two share `stepFrame` and nothing else.
 */
export interface FrameDiagnostics {
  /** `runtime.local.position` — the reconciled+predicted physics position, BEFORE the visual offset. */
  predictedPosition: Vec3Like;
  /** `runtime.visualCorrectionOffset` after this frame's decay. */
  visualOffset: Vec3Like;
  /** Authoritative `player_transform.position` for the local player as of this frame. */
  serverPosition: Vec3Like | null;
  /** `player_transform.serverTick`, stringified — bigint does not survive `page.evaluate`. */
  serverTick: string | null;
  /** `player_input_ack.lastProcessedClientTick`: the server's echo of `input/useInput.ts`'s send counter. */
  ackClientTick: number;
  /** `runtime.clientTickCounter`: frame.ts's own predicted-tick counter. */
  predictTickCounter: number;
  /** Predicted ticks still buffered awaiting an ack (`runtime.predicted.length`). */
  pendingTicks: number;
  /** Monotonic count of reconciles that actually ran (i.e. `serverTick` changed). */
  corrections: number;
  /** How far the most recent reconcile moved the render target. */
  lastCorrectionMagnitude: number;
  /** True when that correction exceeded `VISUAL_CORRECTION_SNAP_METERS` and skipped the glide. */
  lastCorrectionSnapped: boolean;
  /** Predicted ticks the most recent reconcile DISCARDED as already acked. */
  lastCorrectionDropped: number;
  /** Predicted ticks the most recent reconcile REPLAYED on top of the server position. */
  lastCorrectionReplayed: number;
}

export function createFrameRuntimeState(
  metrics: NetcodeMetrics = sharedNetcodeMetrics,
): FrameRuntimeState {
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
    visualCorrectionOffset: zeroVec3(),
    metrics,
    diagnostics: createReconcileDiagnostics(),
  };
}

/**
 * Sets `runtime.visualCorrectionOffset` so the render position keeps gliding from wherever it
 * currently is (`local.position + visualCorrectionOffset`, i.e. the OLD local + the OLD,
 * not-yet-fully-decayed offset — a second correction arriving mid-glide continues smoothly
 * rather than resetting) toward `correctedPosition`, UNLESS the jump is bigger than
 * `VISUAL_CORRECTION_SNAP_METERS`, in which case it snaps immediately (offset zeroed) — a real
 * displacement (roll's ~4-unit `displace_self`) should be instant, not a slow slide.
 *
 * Call this BEFORE overwriting `runtime.local` — it reads the pre-correction position.
 */
function applyVisualCorrection(
  runtime: FrameRuntimeState,
  correctedPosition: Vec3Like,
): { magnitude: number; snapped: boolean } {
  const previousRenderPosition = addVec3(runtime.local.position, runtime.visualCorrectionOffset);
  const offset = subVec3(previousRenderPosition, correctedPosition);
  const offsetLength = Math.hypot(offset.x, offset.y, offset.z);
  const snapped = offsetLength > VISUAL_CORRECTION_SNAP_METERS;
  runtime.visualCorrectionOffset = snapped ? zeroVec3() : offset;
  return { magnitude: offsetLength, snapped };
}

/**
 * Called once per r3f frame (not per predicted tick) — see module doc.
 *
 * Exponential decay toward zero, with the per-frame step capped so the glide never adds more
 * than `MAX_CORRECTION_CATCHUP_SPEED` to the rendered speed. Shrinking the offset uniformly
 * (rather than per-axis) keeps the glide pointing along the same line as the correction — a
 * per-axis clamp would bend the path.
 */
function decayVisualCorrectionOffset(runtime: FrameRuntimeState, dtSeconds: number): void {
  const offset = runtime.visualCorrectionOffset;
  const length = Math.hypot(offset.x, offset.y, offset.z);
  if (length <= 1e-6) {
    runtime.visualCorrectionOffset = zeroVec3();
    return;
  }

  const exponentialStep = length * (1 - Math.exp(-VISUAL_CORRECTION_DECAY_RATE * dtSeconds));
  const step = Math.min(exponentialStep, MAX_CORRECTION_CATCHUP_SPEED * dtSeconds);
  const remaining = Math.max(0, length - step) / length;
  runtime.visualCorrectionOffset = {
    x: offset.x * remaining,
    y: offset.y * remaining,
    z: offset.z * remaining,
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
  /**
   * The ONE client-tick number line, shared with `input/useInput.ts`.
   *
   * `predictPendingTicks` stamps each predicted tick with `runtime.clientTickCounter` and
   * mirrors that counter here; `useInput`'s `sendMovement` stamps the outgoing
   * `InputState.clientTick` with whatever it reads back. The server echoes that number
   * into `player_input_ack.lastProcessedClientTick` (`net.rs::update_player_input`, published
   * from `tick.rs::game_tick` only after the transform for it was computed), and
   * `reconcileLocalPrediction` slices the predicted buffer against it. All four values are
   * therefore the same quantity, which is the only thing that makes the slice mean anything.
   *
   * This ref exists because they once were not. The rewrite gave `useInput` a private
   * counter that ticked once per SEND — 20/s while a key is held, plus one per press and
   * per release — while `frame.ts` kept its own that ticks once per 50ms SIM TICK, always,
   * including while idle and before the player has even joined. Two counters, one namespace,
   * compared against each other. Both failure directions were measured live under the
   * `input_churn` detector (`qa-harness/input-churn.ts`) on
   * `public/v2/essential-template`:
   *
   *  - Steady play: the predictor's counter ran thousands of ticks ahead (it counts idle
   *    ticks; sends do not), so the ack sat below EVERY buffered tick and nothing was ever
   *    dropped. Every correction replayed the whole ~100-tick buffer — five seconds of
   *    prediction — on top of the authoritative position, and the render ran that far ahead
   *    of truth. Measured: `walk_forward` covered 8.26m where 750ms at 6u/s is 4.50m, with
   *    79-117 ticks pending at all times.
   *  - Churn ("wadwadwad"): every key edge adds an extra send, so the send counter caught up
   *    and OVERTOOK the predictor's. The ack then sat above every buffered tick and a single
   *    reconcile discarded all 64 of them and replayed none, snapping the render back onto
   *    the raw authoritative position. Measured: 63-64 ticks dropped in one reconcile,
   *    `pendingTicks` collapsing 64 -> 0, rendered path inflated to 1.83x what 6u/s can draw.
   *
   * The pre-rewrite client had no such split — one counter, advanced by the prediction loop
   * and stamped onto the outgoing input (`git show
   * 9f9fc5c:client/src/components/localPlayerFrame.ts`, `nextClientTick`). This restores it.
   */
  clientTickRef: { current: number };
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
  /** QA-only observation channel — see `FrameDiagnostics`. */
  diagnostics: FrameDiagnostics;
}

/** Called once per r3f frame (useFrame). Mutates `runtime` in place; returns what to render. */
export function stepFrame(runtime: FrameRuntimeState, ctx: StepFrameContext): FrameRenderState {
  runtime.metrics.recordFrame(ctx.dtSeconds);
  reconcileFromStore(runtime, ctx);
  predictPendingTicks(runtime, ctx);
  // Once per FRAME (not per tick, however many ran above) — matches the pre-rewrite tuning.
  decayVisualCorrectionOffset(runtime, ctx.dtSeconds);
  // How much correction is still being hidden from the player right now, after the decay above.
  runtime.metrics.setVisualCorrectionOffsetLength(
    Math.hypot(
      runtime.visualCorrectionOffset.x,
      runtime.visualCorrectionOffset.y,
      runtime.visualCorrectionOffset.z,
    ),
  );
  const remotes = sampleRemotes(runtime, ctx);

  const localPosition = new THREE.Vector3(
    runtime.local.position.x + runtime.visualCorrectionOffset.x,
    runtime.local.position.y + runtime.visualCorrectionOffset.y,
    runtime.local.position.z + runtime.visualCorrectionOffset.z,
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
    diagnostics: collectDiagnostics(runtime, ctx),
  };
}

function collectDiagnostics(runtime: FrameRuntimeState, ctx: StepFrameContext): FrameDiagnostics {
  const transform = ctx.localIdentityHex ? ctx.store.playerTransform.get(ctx.localIdentityHex) : undefined;
  return {
    predictedPosition: { ...runtime.local.position },
    visualOffset: { ...runtime.visualCorrectionOffset },
    serverPosition: transform
      ? { x: transform.position.x, y: transform.position.y, z: transform.position.z }
      : null,
    serverTick: transform ? String(transform.serverTick) : null,
    ackClientTick: runtime.lastProcessedClientTick,
    predictTickCounter: runtime.clientTickCounter,
    pendingTicks: runtime.predicted.length,
    ...runtime.diagnostics,
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
    runtime.visualCorrectionOffset = zeroVec3();
    runtime.initializedFromServer = true;
    runtime.lastServerTick = transform.serverTick;
    // The first authoritative row is the baseline the arrival-interval series measures from —
    // without it the first real interval would be timed from page load instead of from a tick.
    runtime.metrics.recordTransformArrival();
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
  // A changed row IS an authoritative arrival (see the comment above) — so this is the honest
  // place to measure the cadence the server actually delivers at, bursts included.
  runtime.metrics.recordTransformArrival();

  const ack = ctx.store.playerInputAck.get(ctx.localIdentityHex);
  const lastProcessedClientTick = ack?.lastProcessedClientTick ?? runtime.lastProcessedClientTick;
  // Closes the input round trip opened by `useInput`'s `onInputSent`. Repeat acks of a sequence
  // already seen are dropped inside `recordAck`, so a republished row costs nothing.
  if (ack) runtime.metrics.recordAck(ack.lastInputSeq);

  const { sim, remaining, dropped } = reconcileLocalPrediction(
    runtime.predicted,
    transform.position,
    lastProcessedClientTick,
  );
  // Pre-smoothing prediction error: how far the authoritative replay landed from where the
  // client had predicted it was. Deliberately NOT the render-space delta that
  // `applyVisualCorrection` derives — that one folds in the leftover, still-decaying offset
  // from an earlier correction, which would double-count a burst of them.
  runtime.metrics.recordReconcile(
    Math.hypot(
      sim.position.x - runtime.local.position.x,
      sim.position.y - runtime.local.position.y,
      sim.position.z - runtime.local.position.z,
    ),
  );
  // `magnitude` here IS the render-space delta the comment above sets `recordReconcile`
  // apart from — the two answer different questions and the detector wants both: how wrong
  // prediction was (above) versus how far the picture is about to move (here).
  const { magnitude, snapped } = applyVisualCorrection(runtime, sim.position);
  runtime.local = sim;
  runtime.predicted = remaining;
  runtime.lastProcessedClientTick = lastProcessedClientTick;

  runtime.diagnostics = {
    corrections: runtime.diagnostics.corrections + 1,
    lastCorrectionMagnitude: magnitude,
    lastCorrectionSnapped: snapped,
    lastCorrectionDropped: dropped,
    lastCorrectionReplayed: remaining.length,
  };
}

function predictPendingTicks(runtime: FrameRuntimeState, ctx: StepFrameContext): void {
  runtime.accumulatorSeconds += ctx.dtSeconds;
  let ticksThisFrame = 0;

  while (runtime.accumulatorSeconds >= TICK_DT && ticksThisFrame < MAX_TICKS_PER_FRAME) {
    runtime.accumulatorSeconds -= TICK_DT;
    ticksThisFrame += 1;
    runtime.clientTickCounter += 1;
    // Publish the counter BEFORE simulating, so an input event landing anywhere between this
    // tick and the next carries this tick's number — matching the pre-rewrite ordering
    // (`currentInputRef.current.clientTick = nextClientTick` before `simulatePredictedTick`).
    // The server acking N then means "the authoritative transform includes the input you were
    // holding as of predicted tick N", so ticks > N are exactly the ones still to replay.
    ctx.clientTickRef.current = runtime.clientTickCounter;

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
