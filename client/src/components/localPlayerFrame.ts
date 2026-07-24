import { useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import type { InputState, MovementState, PlayerInputAck, PlayerTransform } from '../generated/types';
import { sampleHeight, terrainHeightAt } from '../heightmap';
import { createMovementState, isMoving, simulateMovementTick, type LocomotionState } from '../movement';
import type { NetMetrics } from '../netcode';
import { setAudioListenerWorldPosition } from '../audio/AudioManager';
import type { ClassCapabilities } from './characterConfig';
import { publishFireballAimDebug, vectorDebug as fireballVectorDebug } from '../fireballDebug';

export type MovementAnimationDirection = 'forward' | 'back' | 'left' | 'right';

export interface PredictedTick {
  localTick: number;
  inputSeqAtTick: number;
  clientTickAtTick: number;
  input: InputState;
  rotationY: number;
  verticalVelocityBefore: number;
  jumpWasPressedBefore: boolean;
}

type LocalPlayerFrameOptions = {
  audioListenerPositionRef: MutableRefObject<THREE.Vector3>;
  camera: THREE.Camera;
  cameraOffsetRef: MutableRefObject<THREE.Vector3>;
  cameraOrbitPitchRef: MutableRefObject<number>;
  cameraOrbitResettingRef: MutableRefObject<boolean>;
  cameraOrbitYawRef: MutableRefObject<number>;
  cameraPitchRef: MutableRefObject<number>;
  cameraRotationMatrixRef: MutableRefObject<THREE.Matrix4>;
  cameraRotationRef: MutableRefObject<THREE.Euler>;
  /** Live capabilities from appearance + equipment (not class string alone). */
  capabilities: ClassCapabilities;
  currentInputRef: MutableRefObject<InputState>;
  deltaSeconds: number;
  debugRefs: {
    lastLogAtRef: MutableRefObject<number>;
    lastServerTickRef: MutableRefObject<PlayerTransform['serverTick'] | null>;
    lastSimLogPositionRef: MutableRefObject<THREE.Vector3>;
    lastRenderLogPositionRef: MutableRefObject<THREE.Vector3>;
    lastCameraLogPositionRef: MutableRefObject<THREE.Vector3>;
  };
  fireballAimDirectionRef: MutableRefObject<THREE.Vector3>;
  fireballLineRef: MutableRefObject<THREE.Line | null>;
  fireballTargetRef: MutableRefObject<THREE.Vector3>;
  forceAnimationRestartRef: MutableRefObject<string | null>;
  groupRef: MutableRefObject<THREE.Group>;
  initializedFromServerRef: MutableRefObject<boolean>;
  isDead: boolean;
  jumpAnimationDurationMs: number;
  jumpAnimationName: string;
  jumpAnimationUntilRef: MutableRefObject<number>;
  lastReconciledClientTickRef: MutableRefObject<number>;
  lastReconciledSeqRef: MutableRefObject<number>;
  lastReconciledServerTickRef: MutableRefObject<PlayerTransform['serverTick'] | null>;
  latestTransform: PlayerTransform | undefined;
  /** CSP acks from public `player_input_ack` (pose row is pose-only after #16). */
  latestInputAck: PlayerInputAck | undefined;
  lightningAimDirectionRef: MutableRefObject<THREE.Vector3>;
  lightningAimPointRef: MutableRefObject<THREE.Vector3>;
  lightningHorizontalOffsetRef: MutableRefObject<THREE.Vector3>;
  lightningReticleRef: MutableRefObject<THREE.Group | null>;
  lightningTargetRef: MutableRefObject<THREE.Vector3>;
  lightningTerrainNormalRef: MutableRefObject<THREE.Vector3>;
  localJumpWasPressedRef: MutableRefObject<boolean>;
  localMovementStateRef: MutableRefObject<MovementState | null>;
  localLocomotionStateRef: MutableRefObject<LocomotionState | null>;
  localPositionRef: MutableRefObject<THREE.Vector3>;
  localRotationYRef: MutableRefObject<number>;
  localVerticalVelocityRef: MutableRefObject<number>;
  metrics: NetMetrics;
  predictionAccumulatorRef: MutableRefObject<number>;
  predictedTicksRef: MutableRefObject<PredictedTick[]>;
  localClientTickRef: MutableRefObject<number>;
  localTickRef: MutableRefObject<number>;
  previousPredictedTickPositionRef: MutableRefObject<THREE.Vector3>;
  currentPredictedTickPositionRef: MutableRefObject<THREE.Vector3>;
  renderPositionRef: MutableRefObject<THREE.Vector3>;
  rotationYRef: MutableRefObject<number>;
  selectedWizardSpell: 'fireball' | 'lightning';
  toVisualYaw: (rotationY: number) => number;
  visualCorrectionOffsetRef: MutableRefObject<THREE.Vector3>;
  zeroVectorRef: MutableRefObject<THREE.Vector3>;
};

type LocalPlayerFrameResult = {
  airborneForAnimation: boolean;
  movementAnimationDirection: MovementAnimationDirection;
  movingForAnimation: boolean;
  sprintingForAnimation: boolean;
};

export type LocalPlayerRuntimeConfig = {
  camera: THREE.Camera;
  /** Live capabilities from appearance + equipment (not class string alone). */
  capabilities: ClassCapabilities;
  groupRef: MutableRefObject<THREE.Group>;
  identityKey: string;
  jumpAnimationName: string;
  rotationYRef: MutableRefObject<number>;
  selectedWizardSpell: 'fireball' | 'lightning';
  toVisualYaw: (rotationY: number) => number;
};

type RefValue<T> = MutableRefObject<T>;

function refValue<T>(current: T): RefValue<T> {
  return { current };
}

type PlayerDebugState = {
  simPosition: THREE.Vector3;
  visualOffset: THREE.Vector3;
  renderPosition: THREE.Vector3;
  cameraPosition: THREE.Vector3;
  offsetLength: number;
  cameraFollowSource: 'renderPositionRef';
  localServerTick: PlayerTransform['serverTick'] | null;
  localCorrectionError: number;
  serverPredictedPositionDelta: number;
  jumpDebugLogLength?: number;
};

type JumpDebugVec3 = {
  x: number;
  y: number;
  z: number;
};

type JumpDebugEntry = {
  at: number;
  phase: string;
  frameId: number;
  input?: Partial<InputState>;
  localPosition?: JumpDebugVec3;
  renderPosition?: JumpDebugVec3;
  visualOffset?: JumpDebugVec3;
  previousPredictedPosition?: JumpDebugVec3;
  currentPredictedPosition?: JumpDebugVec3;
  serverPosition?: JumpDebugVec3;
  groundY?: number;
  localClientTick?: number;
  localTick?: number;
  acknowledgedClientTick?: number;
  lastReconciledClientTick?: number;
  latestServerTick?: number | null;
  verticalVelocity?: number;
  jumpWasPressed?: boolean;
  movementState?: MovementState | null;
  pendingTickCount?: number;
  droppedTickCount?: number;
  reconciliationError?: number;
  correctionOffsetLength?: number;
  tickAlpha?: number;
  note?: string;
};

type JumpDebugFrame = {
  frameId: number;
  trace: boolean;
};

declare global {
  interface Window {
    __playerDebug?: PlayerDebugState;
    __jumpDebugConsole?: boolean;
    __jumpDebugEnabled?: boolean;
    __jumpDebugCopy?: () => string;
    __jumpDebugDump?: () => JumpDebugEntry[];
    __jumpDebugLog?: JumpDebugEntry[];
  }
}

export type LocalPlayerFrameRuntime = LocalPlayerRuntime;

export class LocalPlayerRuntime {
  readonly cameraOrbitDragDistanceRef = refValue(0);
  readonly cameraOrbitDraggingRef = refValue(false);
  readonly cameraOrbitPitchRef = refValue(0);
  readonly cameraOrbitResettingRef = refValue(false);
  readonly cameraOrbitYawRef = refValue(0);
  readonly cameraPitchRef = refValue(0);
  readonly fireballLineObject = new THREE.Line();
  readonly fireballLineRef = refValue<THREE.Line | null>(null);
  readonly fireballTargetRef = refValue(new THREE.Vector3());
  readonly forceAnimationRestartRef = refValue<string | null>(null);
  readonly jumpAnimationUntilRef = refValue(0);
  readonly lightningReticleRef = refValue<THREE.Group | null>(null);
  readonly lightningTargetRef = refValue(new THREE.Vector3());
  readonly localRotationYRef = refValue(0);

  private audioListenerPosition = new THREE.Vector3();
  private cameraOffset = new THREE.Vector3();
  private cameraRotation = new THREE.Euler(0, 0, 0, 'YXZ');
  private cameraRotationMatrix = new THREE.Matrix4();
  private readonly debugLastCameraLogPositionRef = refValue(new THREE.Vector3());
  private readonly debugLastLogAtRef = refValue(0);
  private readonly debugLastRenderLogPositionRef = refValue(new THREE.Vector3());
  private readonly debugLastServerTickRef = refValue<PlayerTransform['serverTick'] | null>(null);
  private readonly debugLastSimLogPositionRef = refValue(new THREE.Vector3());
  private fireballAimDirection = new THREE.Vector3();
  private readonly initializedFromServerRef = refValue(false);
  private readonly lastReconciledClientTickRef = refValue(0);
  private readonly lastReconciledSeqRef = refValue(0);
  private readonly lastReconciledServerTickRef = refValue<PlayerTransform['serverTick'] | null>(null);
  private lightningAimDirection = new THREE.Vector3();
  private lightningAimPoint = new THREE.Vector3();
  private lightningHorizontalOffset = new THREE.Vector3();
  private lightningTerrainNormal = new THREE.Vector3(0, 1, 0);
  private readonly localJumpWasPressedRef = refValue(false);
  private readonly localMovementStateRef = refValue<MovementState | null>(null);
  private readonly localLocomotionStateRef = refValue<LocomotionState | null>(null);
  private readonly localPositionRef = refValue(new THREE.Vector3());
  private readonly localVerticalVelocityRef = refValue(0);
  private readonly predictionAccumulatorRef = refValue(0);
  private readonly predictedTicksRef = refValue<PredictedTick[]>([]);
  private readonly localClientTickRef = refValue(0);
  private readonly localTickRef = refValue(0);
  private readonly previousPredictedTickPositionRef = refValue(new THREE.Vector3());
  private readonly currentPredictedTickPositionRef = refValue(new THREE.Vector3());
  private readonly renderPositionRef = refValue(new THREE.Vector3());
  private readonly visualCorrectionOffsetRef = refValue(new THREE.Vector3());
  private zeroVector = new THREE.Vector3();
  private config: LocalPlayerRuntimeConfig;

  constructor(config: LocalPlayerRuntimeConfig) {
    this.config = config;
  }

  updateConfig(config: LocalPlayerRuntimeConfig) {
    this.config = config;
  }

  getPredictionDebugState() {
    return {
      localPosition: this.localPositionRef.current.clone(),
      movementState: this.localMovementStateRef.current ? { ...this.localMovementStateRef.current } : null,
      locomotionState: this.localLocomotionStateRef.current ? { ...this.localLocomotionStateRef.current } : null,
      renderPosition: this.renderPositionRef.current.clone(),
      visualCorrectionOffset: this.visualCorrectionOffsetRef.current.clone(),
      predictedTickCount: this.predictedTicksRef.current.length,
      predictedClientTicks: this.predictedTicksRef.current.map(tick => tick.clientTickAtTick),
      accumulator: this.predictionAccumulatorRef.current,
      localClientTick: this.localClientTickRef.current,
      localTick: this.localTickRef.current,
      verticalVelocity: this.localVerticalVelocityRef.current,
      jumpWasPressed: this.localJumpWasPressedRef.current,
    };
  }
  runFrame({
    currentInput,
    deltaSeconds,
    isDead,
    jumpAnimationDurationMs,
    latestTransform,
    latestInputAck,
    metrics,
  }: {
    currentInput: InputState;
    deltaSeconds: number;
    isDead: boolean;
    jumpAnimationDurationMs: number;
    latestTransform: PlayerTransform | undefined;
    latestInputAck: PlayerInputAck | undefined;
    metrics: NetMetrics;
  }): LocalPlayerFrameResult {
    return runLocalPlayerFrame({
      audioListenerPositionRef: refValue(this.audioListenerPosition),
      camera: this.config.camera,
      cameraOffsetRef: refValue(this.cameraOffset),
      cameraOrbitPitchRef: this.cameraOrbitPitchRef,
      cameraOrbitResettingRef: this.cameraOrbitResettingRef,
      cameraOrbitYawRef: this.cameraOrbitYawRef,
      cameraPitchRef: this.cameraPitchRef,
      cameraRotationMatrixRef: refValue(this.cameraRotationMatrix),
      cameraRotationRef: refValue(this.cameraRotation),
      capabilities: this.config.capabilities,
      currentInputRef: refValue(currentInput),
      deltaSeconds,
      debugRefs: {
        lastLogAtRef: this.debugLastLogAtRef,
        lastServerTickRef: this.debugLastServerTickRef,
        lastSimLogPositionRef: this.debugLastSimLogPositionRef,
        lastRenderLogPositionRef: this.debugLastRenderLogPositionRef,
        lastCameraLogPositionRef: this.debugLastCameraLogPositionRef,
      },
      fireballAimDirectionRef: refValue(this.fireballAimDirection),
      fireballLineRef: this.fireballLineRef,
      fireballTargetRef: this.fireballTargetRef,
      forceAnimationRestartRef: this.forceAnimationRestartRef,
      groupRef: this.config.groupRef,
      initializedFromServerRef: this.initializedFromServerRef,
      isDead,
      jumpAnimationDurationMs,
      jumpAnimationName: this.config.jumpAnimationName,
      jumpAnimationUntilRef: this.jumpAnimationUntilRef,
      lastReconciledClientTickRef: this.lastReconciledClientTickRef,
      lastReconciledSeqRef: this.lastReconciledSeqRef,
      lastReconciledServerTickRef: this.lastReconciledServerTickRef,
      latestTransform,
      latestInputAck,
      lightningAimDirectionRef: refValue(this.lightningAimDirection),
      lightningAimPointRef: refValue(this.lightningAimPoint),
      lightningHorizontalOffsetRef: refValue(this.lightningHorizontalOffset),
      lightningReticleRef: this.lightningReticleRef,
      lightningTargetRef: this.lightningTargetRef,
      lightningTerrainNormalRef: refValue(this.lightningTerrainNormal),
      localJumpWasPressedRef: this.localJumpWasPressedRef,
      localMovementStateRef: this.localMovementStateRef,
      localLocomotionStateRef: this.localLocomotionStateRef,
      localPositionRef: this.localPositionRef,
      localRotationYRef: this.localRotationYRef,
      localVerticalVelocityRef: this.localVerticalVelocityRef,
      metrics,
      predictionAccumulatorRef: this.predictionAccumulatorRef,
      predictedTicksRef: this.predictedTicksRef,
      localClientTickRef: this.localClientTickRef,
      localTickRef: this.localTickRef,
      previousPredictedTickPositionRef: this.previousPredictedTickPositionRef,
      currentPredictedTickPositionRef: this.currentPredictedTickPositionRef,
      renderPositionRef: this.renderPositionRef,
      rotationYRef: this.config.rotationYRef,
      selectedWizardSpell: this.config.selectedWizardSpell,
      toVisualYaw: this.config.toVisualYaw,
      visualCorrectionOffsetRef: this.visualCorrectionOffsetRef,
      zeroVectorRef: refValue(this.zeroVector),
    });
  }
}

export function useLocalPlayerFrameRuntime(config: LocalPlayerRuntimeConfig): LocalPlayerFrameRuntime {
  const runtimeRef = useRef<LocalPlayerRuntime | null>(null);
  /* eslint-disable react-hooks/refs -- Prediction state must live in one stable runtime instance across renders. */
  if (runtimeRef.current === null) {
    runtimeRef.current = new LocalPlayerRuntime(config);
  } else {
    runtimeRef.current.updateConfig(config);
  }
  return runtimeRef.current;
  /* eslint-enable react-hooks/refs */
}
const CAMERA_HEIGHT = 2.0;
const CAMERA_DISTANCE = 5.0;
const CAMERA_MIN_PITCH = THREE.MathUtils.degToRad(-80);
const CAMERA_MAX_PITCH = THREE.MathUtils.degToRad(80);
const CAMERA_ORBIT_RESET_DAMPING = 10;
const AUDIO_LISTENER_HEIGHT = 1.5;
export const LOCAL_PREDICTION_TICK_DT = 1 / 20;
const MAX_PREDICTION_TICKS_PER_FRAME = 5;
const MAX_PREDICTED_TICK_BUFFER = 120;
const VISUAL_CORRECTION_DECAY_RATE = 12;
const VISUAL_CORRECTION_SNAP_METERS = 3.0;
const RECONCILIATION_EPSILON_METERS = 0.12;
const ENABLE_PLAYER_DEBUG_LOGS = false;
const DEBUG_LOG_INTERVAL_MS = 250;
const DEBUG_POSITION_EPSILON = 0.01;
const AIRBORNE_Y_EPSILON = 0.05;
const JUMP_START_GROUNDED_EPSILON = 0.01;
const VERTICAL_VELOCITY_EPSILON = 0.01;
const JUMP_DEBUG_RING_SIZE = 800;
const JUMP_DEBUG_POST_EVENT_FRAMES = 120;
const LIGHTNING_TARGET_DISTANCE = 24;
const LIGHTNING_TARGET_Y_OFFSET = 0.08;
const LIGHTNING_AIM_FALLBACK_DISTANCE = LIGHTNING_TARGET_DISTANCE;
const LIGHTNING_AIM_RAY_STEP = 0.75;
const LIGHTNING_NORMAL_SAMPLE_DISTANCE = 0.9;
const LIGHTNING_RETICLE_UP = new THREE.Vector3(0, 1, 0);
const FIREBALL_TARGET_DISTANCE = 28;
const FIREBALL_MARKER_Y_OFFSET = 0.08;
let jumpDebugFrameId = 0;
let jumpDebugFramesRemaining = 0;

export function shouldClearVerticalCorrection({
  groundY,
  movementState,
  positionY,
  verticalVelocity,
}: {
  groundY: number;
  movementState: MovementState | null;
  positionY: number;
  verticalVelocity: number;
}): boolean {
  return (
    (movementState?.isAirborne ?? false) ||
    positionY > groundY + AIRBORNE_Y_EPSILON ||
    Math.abs(verticalVelocity) > VERTICAL_VELOCITY_EPSILON
  );
}

function shouldPreserveLocalVerticalPrediction({
  localMovementState,
  localPosition,
  localVerticalVelocity,
}: {
  localMovementState: MovementState | null;
  localPosition: THREE.Vector3;
  localVerticalVelocity: number;
}): boolean {
  return shouldClearVerticalCorrection({
    groundY: terrainHeightAt(localPosition),
    movementState: localMovementState,
    positionY: localPosition.y,
    verticalVelocity: localVerticalVelocity,
  });
}

function vectorDebug(position: THREE.Vector3): JumpDebugVec3 {
  return {
    x: Number(position.x.toFixed(4)),
    y: Number(position.y.toFixed(4)),
    z: Number(position.z.toFixed(4)),
  };
}

function inputDebug(input: InputState): Partial<InputState> {
  return {
    forward: input.forward,
    backward: input.backward,
    left: input.left,
    right: input.right,
    sprint: input.sprint,
    jump: input.jump,
    sequence: input.sequence,
    clientTick: input.clientTick,
  };
}

function isJumpDebugEnabled() {
  if (typeof window === 'undefined') return false;
  if (window.__jumpDebugEnabled) return true;
  const params = new URLSearchParams(window.location.search);
  if (params.has('jumpDebug')) return true;
  try {
    return window.localStorage.getItem('mog.jumpDebug') === '1';
  } catch {
    return false;
  }
}

function beginJumpDebugFrame({
  input,
  movementState,
  verticalVelocity,
  visualCorrectionOffset,
}: {
  input: InputState;
  movementState: MovementState | null;
  verticalVelocity: number;
  visualCorrectionOffset: THREE.Vector3;
}): JumpDebugFrame {
  const frameId = jumpDebugFrameId + 1;
  jumpDebugFrameId = frameId;

  if (!isJumpDebugEnabled()) return { frameId, trace: false };

  const interesting = input.jump ||
    movementState?.isAirborne ||
    Math.abs(verticalVelocity) > VERTICAL_VELOCITY_EPSILON ||
    visualCorrectionOffset.lengthSq() > 0.000001;
  if (interesting) {
    jumpDebugFramesRemaining = JUMP_DEBUG_POST_EVENT_FRAMES;
  }

  const trace = jumpDebugFramesRemaining > 0;
  if (jumpDebugFramesRemaining > 0) {
    jumpDebugFramesRemaining -= 1;
  }

  return { frameId, trace };
}

function pushJumpDebug(entry: Omit<JumpDebugEntry, 'at'>) {
  if (!isJumpDebugEnabled()) return;

  const nextEntry: JumpDebugEntry = {
    at: Number(performance.now().toFixed(2)),
    ...entry,
  };
  const log = window.__jumpDebugLog ?? [];
  log.push(nextEntry);
  if (log.length > JUMP_DEBUG_RING_SIZE) {
    log.splice(0, log.length - JUMP_DEBUG_RING_SIZE);
  }
  window.__jumpDebugLog = log;
  window.__jumpDebugDump = () => [...log];
  window.__jumpDebugCopy = () => JSON.stringify(log, null, 2);

  if (window.__jumpDebugConsole !== false) {
    console.log('[JumpDebug]', JSON.stringify(nextEntry));
  }
}

export function runLocalPlayerFrame({
  audioListenerPositionRef,
  camera,
  cameraOffsetRef,
  cameraOrbitPitchRef,
  cameraOrbitResettingRef,
  cameraOrbitYawRef,
  cameraPitchRef,
  cameraRotationMatrixRef,
  cameraRotationRef,
  capabilities,
  currentInputRef,
  deltaSeconds: dt,
  debugRefs,
  fireballAimDirectionRef,
  fireballLineRef,
  fireballTargetRef,
  forceAnimationRestartRef,
  groupRef,
  initializedFromServerRef,
  isDead,
  jumpAnimationDurationMs,
  jumpAnimationName,
  jumpAnimationUntilRef,
  lastReconciledClientTickRef,
  lastReconciledSeqRef,
  lastReconciledServerTickRef,
  latestTransform,
  latestInputAck,
  lightningAimDirectionRef,
  lightningAimPointRef,
  lightningHorizontalOffsetRef,
  lightningReticleRef,
  lightningTargetRef,
  lightningTerrainNormalRef,
  localJumpWasPressedRef,
  localMovementStateRef,
  localLocomotionStateRef,
  localPositionRef,
  localRotationYRef,
  localVerticalVelocityRef,
  metrics,
  predictionAccumulatorRef,
  predictedTicksRef,
  localClientTickRef,
  localTickRef,
  previousPredictedTickPositionRef,
  currentPredictedTickPositionRef,
  renderPositionRef,
  rotationYRef,
  selectedWizardSpell,
  toVisualYaw,
  visualCorrectionOffsetRef,
  zeroVectorRef,
}: LocalPlayerFrameOptions): LocalPlayerFrameResult {
  const jumpDebugFrame = beginJumpDebugFrame({
    input: currentInputRef.current,
    movementState: localMovementStateRef.current,
    verticalVelocity: localVerticalVelocityRef.current,
    visualCorrectionOffset: visualCorrectionOffsetRef.current,
  });

  if (jumpDebugFrame.trace) {
    pushJumpDebug({
      phase: 'frame:start',
      frameId: jumpDebugFrame.frameId,
      input: inputDebug(currentInputRef.current),
      localPosition: vectorDebug(localPositionRef.current),
      renderPosition: vectorDebug(renderPositionRef.current),
      visualOffset: vectorDebug(visualCorrectionOffsetRef.current),
      previousPredictedPosition: vectorDebug(previousPredictedTickPositionRef.current),
      currentPredictedPosition: vectorDebug(currentPredictedTickPositionRef.current),
      groundY: Number(terrainHeightAt(localPositionRef.current).toFixed(4)),
      localClientTick: localClientTickRef.current,
      localTick: localTickRef.current,
      acknowledgedClientTick: metrics.acknowledgedClientTick,
      latestServerTick: latestTransform ? Number(latestTransform.serverTick) : null,
      verticalVelocity: Number(localVerticalVelocityRef.current.toFixed(4)),
      jumpWasPressed: localJumpWasPressedRef.current,
      movementState: localMovementStateRef.current ? { ...localMovementStateRef.current } : null,
      pendingTickCount: predictedTicksRef.current.length,
      correctionOffsetLength: Number(visualCorrectionOffsetRef.current.length().toFixed(4)),
    });
  }

  if (latestTransform && !initializedFromServerRef.current) {
    const initAck = inputAckFields(latestInputAck);
    localPositionRef.current.set(
      latestTransform.position.x,
      latestTransform.position.y,
      latestTransform.position.z,
    );
    renderPositionRef.current.copy(localPositionRef.current);
    visualCorrectionOffsetRef.current.set(0, 0, 0);
    lastReconciledServerTickRef.current = latestTransform.serverTick;
    lastReconciledClientTickRef.current = initAck.lastProcessedClientTick;
    lastReconciledSeqRef.current = initAck.lastInputSeq;
    metrics.lastSentClientTick = initAck.lastProcessedClientTick;
    currentInputRef.current.sequence = Math.max(currentInputRef.current.sequence, initAck.lastInputSeq);
    currentInputRef.current.clientTick = initAck.lastProcessedClientTick;
    rotationYRef.current = latestTransform.rotationY;
    localRotationYRef.current = latestTransform.rotationY;
    localMovementStateRef.current = { ...latestTransform.movementState };
    localLocomotionStateRef.current = null;
    localClientTickRef.current = initAck.lastProcessedClientTick;
    localTickRef.current = Number(latestTransform.serverTick);
    localVerticalVelocityRef.current = 0;
    localJumpWasPressedRef.current = false;
    predictedTicksRef.current = [];
    predictionAccumulatorRef.current = 0;
    previousPredictedTickPositionRef.current.copy(localPositionRef.current);
    currentPredictedTickPositionRef.current.copy(localPositionRef.current);
    initializedFromServerRef.current = true;
    if (jumpDebugFrame.trace) {
      pushJumpDebug({
        phase: 'frame:init-from-server',
        frameId: jumpDebugFrame.frameId,
        input: inputDebug(currentInputRef.current),
        localPosition: vectorDebug(localPositionRef.current),
        renderPosition: vectorDebug(renderPositionRef.current),
        serverPosition: vectorDebug(new THREE.Vector3(
          latestTransform.position.x,
          latestTransform.position.y,
          latestTransform.position.z,
        )),
        groundY: Number(terrainHeightAt(localPositionRef.current).toFixed(4)),
        localClientTick: localClientTickRef.current,
        localTick: localTickRef.current,
        acknowledgedClientTick: initAck.lastProcessedClientTick,
        latestServerTick: Number(latestTransform.serverTick),
        verticalVelocity: localVerticalVelocityRef.current,
        jumpWasPressed: localJumpWasPressedRef.current,
        movementState: localMovementStateRef.current ? { ...localMovementStateRef.current } : null,
        pendingTickCount: predictedTicksRef.current.length,
        note: 'initial authoritative transform loaded',
      });
    }
  }

  if (isDead) {
    predictionAccumulatorRef.current = 0;
    predictedTicksRef.current = [];
    if (latestTransform) {
      snapToServerTransform({
        latestTransform,
        latestInputAck,
        currentInputRef,
        localPositionRef,
        localVerticalVelocityRef,
        localJumpWasPressedRef,
        localMovementStateRef,
        localLocomotionStateRef,
        metrics,
        localClientTickRef,
        localTickRef,
        predictedTicksRef,
        previousPredictedTickPositionRef,
        currentPredictedTickPositionRef,
        visualCorrectionOffsetRef,
        jumpDebugFrame,
      });
      localRotationYRef.current = latestTransform.rotationY;
      rotationYRef.current = latestTransform.rotationY;
    } else {
      previousPredictedTickPositionRef.current.copy(localPositionRef.current);
      currentPredictedTickPositionRef.current.copy(localPositionRef.current);
      visualCorrectionOffsetRef.current.set(0, 0, 0);
    }
    if (jumpDebugFrame.trace) {
      pushJumpDebug({
        phase: 'frame:dead-skip-prediction',
        frameId: jumpDebugFrame.frameId,
        input: inputDebug(currentInputRef.current),
        localPosition: vectorDebug(localPositionRef.current),
        renderPosition: vectorDebug(renderPositionRef.current),
        visualOffset: vectorDebug(visualCorrectionOffsetRef.current),
        groundY: Number(terrainHeightAt(localPositionRef.current).toFixed(4)),
        localClientTick: localClientTickRef.current,
        localTick: localTickRef.current,
        acknowledgedClientTick: metrics.acknowledgedClientTick,
        latestServerTick: latestTransform ? Number(latestTransform.serverTick) : null,
        verticalVelocity: Number(localVerticalVelocityRef.current.toFixed(4)),
        jumpWasPressed: localJumpWasPressedRef.current,
        movementState: localMovementStateRef.current ? { ...localMovementStateRef.current } : null,
        pendingTickCount: predictedTicksRef.current.length,
      });
    }
  } else {
    reconcileLocalPrediction({
      latestTransform,
      latestInputAck,
      lastReconciledClientTickRef,
      lastReconciledSeqRef,
      lastReconciledServerTickRef,
      localPositionRef,
      localVerticalVelocityRef,
      localJumpWasPressedRef,
      localMovementStateRef,
      localLocomotionStateRef,
      metrics,
      predictedTicksRef,
      localClientTickRef,
      localTickRef,
      previousPredictedTickPositionRef,
      currentPredictedTickPositionRef,
      renderPositionRef,
      visualCorrectionOffsetRef,
      jumpDebugFrame,
    });
  }

  const currentInput = { ...currentInputRef.current };
  if (!isDead) {
    predictionAccumulatorRef.current += dt;
  }
  let ticksThisFrame = 0;
  let snappedAfterTickOverflow = false;

  while (!isDead && predictionAccumulatorRef.current >= LOCAL_PREDICTION_TICK_DT) {
    if (ticksThisFrame >= MAX_PREDICTION_TICKS_PER_FRAME) {
      if (latestTransform) {
        snapToServerTransform({
          latestTransform,
          latestInputAck,
          currentInputRef,
          localPositionRef,
          localVerticalVelocityRef,
          localJumpWasPressedRef,
          localMovementStateRef,
          localLocomotionStateRef,
          metrics,
          localClientTickRef,
          localTickRef,
          predictedTicksRef,
          previousPredictedTickPositionRef,
          currentPredictedTickPositionRef,
          visualCorrectionOffsetRef,
          jumpDebugFrame,
        });
      }
      if (jumpDebugFrame.trace) {
        pushJumpDebug({
          phase: 'prediction:overflow-snap',
          frameId: jumpDebugFrame.frameId,
          input: inputDebug(currentInputRef.current),
          localPosition: vectorDebug(localPositionRef.current),
          renderPosition: vectorDebug(renderPositionRef.current),
          visualOffset: vectorDebug(visualCorrectionOffsetRef.current),
          groundY: Number(terrainHeightAt(localPositionRef.current).toFixed(4)),
          localClientTick: localClientTickRef.current,
          localTick: localTickRef.current,
          acknowledgedClientTick: metrics.acknowledgedClientTick,
          latestServerTick: latestTransform ? Number(latestTransform.serverTick) : null,
          pendingTickCount: predictedTicksRef.current.length,
          note: 'prediction loop hit per-frame safety cap',
        });
      }
      predictionAccumulatorRef.current = 0;
      snappedAfterTickOverflow = true;
      break;
    }

    const nextClientTick = Math.max(
      localClientTickRef.current + 1,
      currentInputRef.current.clientTick,
    );
    localClientTickRef.current = nextClientTick;
    currentInputRef.current.clientTick = nextClientTick;
    const tickInput = { ...currentInputRef.current, clientTick: nextClientTick };
    const tickRotationY = localRotationYRef.current;
    const verticalVelocityBeforeTick = localVerticalVelocityRef.current;
    const jumpWasPressedBeforeTick = localJumpWasPressedRef.current;
    const positionBeforeTick = localPositionRef.current.clone();
    const movementStateBeforeTick = localMovementStateRef.current
      ? { ...localMovementStateRef.current }
      : null;
    previousPredictedTickPositionRef.current.copy(currentPredictedTickPositionRef.current);

    const jumpPressed = tickInput.jump;
    const startsGroundedJump =
      jumpPressed &&
      !localJumpWasPressedRef.current &&
      localPositionRef.current.y <= terrainHeightAt(localPositionRef.current) + JUMP_START_GROUNDED_EPSILON;

    if (startsGroundedJump) {
      jumpAnimationUntilRef.current = performance.now() + jumpAnimationDurationMs;
      forceAnimationRestartRef.current = jumpAnimationName;
    }

    if (jumpDebugFrame.trace) {
      pushJumpDebug({
        phase: 'prediction:before-tick',
        frameId: jumpDebugFrame.frameId,
        input: inputDebug(tickInput),
        localPosition: vectorDebug(positionBeforeTick),
        previousPredictedPosition: vectorDebug(previousPredictedTickPositionRef.current),
        currentPredictedPosition: vectorDebug(currentPredictedTickPositionRef.current),
        groundY: Number(terrainHeightAt(positionBeforeTick).toFixed(4)),
        localClientTick: localClientTickRef.current,
        localTick: localTickRef.current,
        acknowledgedClientTick: metrics.acknowledgedClientTick,
        verticalVelocity: Number(verticalVelocityBeforeTick.toFixed(4)),
        jumpWasPressed: jumpWasPressedBeforeTick,
        movementState: movementStateBeforeTick,
        pendingTickCount: predictedTicksRef.current.length,
        note: startsGroundedJump ? 'starts grounded jump animation' : undefined,
      });
    }

    simulatePredictedTick({
      input: tickInput,
      rotationY: tickRotationY,
      localPositionRef,
      localVerticalVelocityRef,
      localJumpWasPressedRef,
      localMovementStateRef,
      localLocomotionStateRef,
    });

    localTickRef.current += 1;
    currentPredictedTickPositionRef.current.copy(localPositionRef.current);
    predictedTicksRef.current.push({
      localTick: localTickRef.current,
      inputSeqAtTick: tickInput.sequence,
      clientTickAtTick: tickInput.clientTick,
      input: tickInput,
      rotationY: tickRotationY,
      verticalVelocityBefore: verticalVelocityBeforeTick,
      jumpWasPressedBefore: jumpWasPressedBeforeTick,
    });
    if (predictedTicksRef.current.length > MAX_PREDICTED_TICK_BUFFER) {
      predictedTicksRef.current.shift();
    }

    if (jumpDebugFrame.trace) {
      pushJumpDebug({
        phase: 'prediction:after-tick',
        frameId: jumpDebugFrame.frameId,
        input: inputDebug(tickInput),
        localPosition: vectorDebug(localPositionRef.current),
        previousPredictedPosition: vectorDebug(previousPredictedTickPositionRef.current),
        currentPredictedPosition: vectorDebug(currentPredictedTickPositionRef.current),
        groundY: Number(terrainHeightAt(localPositionRef.current).toFixed(4)),
        localClientTick: localClientTickRef.current,
        localTick: localTickRef.current,
        acknowledgedClientTick: metrics.acknowledgedClientTick,
        verticalVelocity: Number(localVerticalVelocityRef.current.toFixed(4)),
        jumpWasPressed: localJumpWasPressedRef.current,
        movementState: localMovementStateRef.current ? { ...localMovementStateRef.current } : null,
        pendingTickCount: predictedTicksRef.current.length,
        note: startsGroundedJump ? 'jump input accepted by local prediction' : undefined,
      });
    }

    predictionAccumulatorRef.current -= LOCAL_PREDICTION_TICK_DT;
    ticksThisFrame += 1;
  }

  const correctionAlpha = 1 - Math.exp(-VISUAL_CORRECTION_DECAY_RATE * dt);
  visualCorrectionOffsetRef.current.lerp(zeroVectorRef.current, correctionAlpha);
  const groundY = terrainHeightAt(localPositionRef.current);
  const clearedVerticalCorrection = shouldClearVerticalCorrection({
    groundY,
    movementState: localMovementStateRef.current,
    positionY: localPositionRef.current.y,
    verticalVelocity: localVerticalVelocityRef.current,
  });
  if (clearedVerticalCorrection) {
    visualCorrectionOffsetRef.current.y = 0;
    if (jumpDebugFrame.trace) {
      pushJumpDebug({
        phase: 'visual-correction:clear-y',
        frameId: jumpDebugFrame.frameId,
        localPosition: vectorDebug(localPositionRef.current),
        visualOffset: vectorDebug(visualCorrectionOffsetRef.current),
        groundY: Number(groundY.toFixed(4)),
        localClientTick: localClientTickRef.current,
        localTick: localTickRef.current,
        verticalVelocity: Number(localVerticalVelocityRef.current.toFixed(4)),
        movementState: localMovementStateRef.current ? { ...localMovementStateRef.current } : null,
        correctionOffsetLength: Number(visualCorrectionOffsetRef.current.length().toFixed(4)),
      });
    }
  }

  metrics.pendingTickCount = predictedTicksRef.current.length;
  metrics.predictedTickCount = predictedTicksRef.current.length;
  metrics.localTick = localTickRef.current;
  metrics.localClientTick = localClientTickRef.current;
  metrics.visualCorrectionOffset = visualCorrectionOffsetRef.current.length();

  const tickAlpha = snappedAfterTickOverflow
    ? 1
    : THREE.MathUtils.clamp(predictionAccumulatorRef.current / LOCAL_PREDICTION_TICK_DT, 0, 1);
  renderPositionRef.current
    .copy(previousPredictedTickPositionRef.current)
    .lerp(currentPredictedTickPositionRef.current, tickAlpha)
    .add(visualCorrectionOffsetRef.current);
  const localMovementState = localMovementStateRef.current ?? createMovementState(localPositionRef.current, currentInput);

  if (jumpDebugFrame.trace) {
    pushJumpDebug({
      phase: 'frame:render',
      frameId: jumpDebugFrame.frameId,
      input: inputDebug(currentInputRef.current),
      localPosition: vectorDebug(localPositionRef.current),
      renderPosition: vectorDebug(renderPositionRef.current),
      visualOffset: vectorDebug(visualCorrectionOffsetRef.current),
      previousPredictedPosition: vectorDebug(previousPredictedTickPositionRef.current),
      currentPredictedPosition: vectorDebug(currentPredictedTickPositionRef.current),
      groundY: Number(groundY.toFixed(4)),
      localClientTick: localClientTickRef.current,
      localTick: localTickRef.current,
      acknowledgedClientTick: metrics.acknowledgedClientTick,
      latestServerTick: latestTransform ? Number(latestTransform.serverTick) : null,
      verticalVelocity: Number(localVerticalVelocityRef.current.toFixed(4)),
      jumpWasPressed: localJumpWasPressedRef.current,
      movementState: localMovementStateRef.current ? { ...localMovementStateRef.current } : null,
      pendingTickCount: predictedTicksRef.current.length,
      correctionOffsetLength: Number(visualCorrectionOffsetRef.current.length().toFixed(4)),
      tickAlpha: Number(tickAlpha.toFixed(4)),
    });
  }

  groupRef.current.position.copy(renderPositionRef.current);
  groupRef.current.rotation.y = toVisualYaw(localRotationYRef.current);

  if (cameraOrbitResettingRef.current) {
    cameraOrbitYawRef.current = THREE.MathUtils.damp(
      cameraOrbitYawRef.current,
      0,
      CAMERA_ORBIT_RESET_DAMPING,
      dt,
    );
    cameraOrbitPitchRef.current = THREE.MathUtils.damp(
      cameraOrbitPitchRef.current,
      0,
      CAMERA_ORBIT_RESET_DAMPING,
      dt,
    );

    if (
      Math.abs(cameraOrbitYawRef.current) < 0.001 &&
      Math.abs(cameraOrbitPitchRef.current) < 0.001
    ) {
      cameraOrbitYawRef.current = 0;
      cameraOrbitPitchRef.current = 0;
      cameraOrbitResettingRef.current = false;
    }
  }

  updateLocalCamera({
    audioListenerPositionRef,
    camera,
    cameraOffsetRef,
    cameraPitch: THREE.MathUtils.clamp(
      cameraPitchRef.current + cameraOrbitPitchRef.current,
      CAMERA_MIN_PITCH,
      CAMERA_MAX_PITCH,
    ),
    cameraRotationMatrixRef,
    cameraRotationRef,
    localRotationY: localRotationYRef.current + cameraOrbitYawRef.current,
    renderPosition: renderPositionRef.current,
  });

  if (typeof window !== 'undefined') {
    window.__playerDebug = {
      simPosition: localPositionRef.current.clone(),
      visualOffset: visualCorrectionOffsetRef.current.clone(),
      renderPosition: renderPositionRef.current.clone(),
      cameraPosition: camera.position.clone(),
      offsetLength: visualCorrectionOffsetRef.current.length(),
      cameraFollowSource: 'renderPositionRef',
      localServerTick: latestTransform?.serverTick ?? null,
      localCorrectionError: metrics.localCorrectionError,
      serverPredictedPositionDelta: metrics.serverPredictedPositionDelta,
      jumpDebugLogLength: window.__jumpDebugLog?.length ?? 0,
    };
  }

  logLocalFrameDebug({
    camera,
    debugRefs,
    dt,
    latestTransform,
    localPositionRef,
    renderPositionRef,
  });

  updateWizardAimTargets({
    camera,
    capabilities,
    fireballAimDirectionRef,
    fireballLineRef,
    fireballTargetRef,
    isDead,
    lightningAimDirectionRef,
    lightningAimPointRef,
    lightningHorizontalOffsetRef,
    lightningReticleRef,
    lightningTargetRef,
    lightningTerrainNormalRef,
    localRotationY: localRotationYRef.current,
    renderPositionRef,
    selectedWizardSpell,
  });

  return {
    airborneForAnimation: localMovementState.isAirborne,
    movementAnimationDirection: getLocalMovementAnimationDirection(currentInput),
    movingForAnimation: isMoving(currentInput),
    sprintingForAnimation: localMovementState.sprintActive,
  };
}

function inputAckFields(latestInputAck: PlayerInputAck | undefined): {
  lastInputSeq: number;
  lastProcessedClientTick: number;
} {
  return {
    lastInputSeq: latestInputAck?.lastInputSeq ?? 0,
    lastProcessedClientTick: latestInputAck?.lastProcessedClientTick ?? 0,
  };
}

function reconcileLocalPrediction({
  latestTransform,
  latestInputAck,
  lastReconciledClientTickRef,
  lastReconciledSeqRef,
  lastReconciledServerTickRef,
  localPositionRef,
  localVerticalVelocityRef,
  localJumpWasPressedRef,
  localMovementStateRef,
  localLocomotionStateRef,
  metrics,
  predictedTicksRef,
  localClientTickRef,
  localTickRef,
  previousPredictedTickPositionRef,
  currentPredictedTickPositionRef,
  renderPositionRef,
  visualCorrectionOffsetRef,
  jumpDebugFrame,
}: {
  latestTransform: PlayerTransform | undefined;
  latestInputAck: PlayerInputAck | undefined;
  lastReconciledClientTickRef: MutableRefObject<number>;
  lastReconciledSeqRef: MutableRefObject<number>;
  lastReconciledServerTickRef: MutableRefObject<PlayerTransform['serverTick'] | null>;
  localPositionRef: MutableRefObject<THREE.Vector3>;
  localVerticalVelocityRef: MutableRefObject<number>;
  localJumpWasPressedRef: MutableRefObject<boolean>;
  localMovementStateRef: MutableRefObject<MovementState | null>;
  localLocomotionStateRef: MutableRefObject<LocomotionState | null>;
  metrics: NetMetrics;
  predictedTicksRef: MutableRefObject<PredictedTick[]>;
  localClientTickRef: MutableRefObject<number>;
  localTickRef: MutableRefObject<number>;
  previousPredictedTickPositionRef: MutableRefObject<THREE.Vector3>;
  currentPredictedTickPositionRef: MutableRefObject<THREE.Vector3>;
  renderPositionRef: MutableRefObject<THREE.Vector3>;
  visualCorrectionOffsetRef: MutableRefObject<THREE.Vector3>;
  jumpDebugFrame?: JumpDebugFrame;
}) {
  if (!latestTransform) return;

  const lastReconciledServerTick = lastReconciledServerTickRef.current;
  const { lastInputSeq: acknowledgedInputSeq, lastProcessedClientTick: acknowledgedClientTick } =
    inputAckFields(latestInputAck);
  metrics.acknowledgedInputSeq = acknowledgedInputSeq;
  metrics.acknowledgedClientTick = acknowledgedClientTick;
  metrics.latestServerTick = Number(latestTransform.serverTick);
  metrics.localTick = localTickRef.current;
  metrics.localClientTick = localClientTickRef.current;

  if (jumpDebugFrame?.trace) {
    pushJumpDebug({
      phase: 'reconcile:start',
      frameId: jumpDebugFrame.frameId,
      localPosition: vectorDebug(localPositionRef.current),
      renderPosition: vectorDebug(renderPositionRef.current),
      visualOffset: vectorDebug(visualCorrectionOffsetRef.current),
      serverPosition: vectorDebug(new THREE.Vector3(
        latestTransform.position.x,
        latestTransform.position.y,
        latestTransform.position.z,
      )),
      groundY: Number(terrainHeightAt(localPositionRef.current).toFixed(4)),
      localClientTick: localClientTickRef.current,
      localTick: localTickRef.current,
      acknowledgedClientTick,
      lastReconciledClientTick: lastReconciledClientTickRef.current,
      latestServerTick: Number(latestTransform.serverTick),
      verticalVelocity: Number(localVerticalVelocityRef.current.toFixed(4)),
      jumpWasPressed: localJumpWasPressedRef.current,
      movementState: localMovementStateRef.current ? { ...localMovementStateRef.current } : null,
      pendingTickCount: predictedTicksRef.current.length,
      correctionOffsetLength: Number(visualCorrectionOffsetRef.current.length().toFixed(4)),
    });
  }

  if (
    lastReconciledServerTick !== null &&
    compareServerTicks(latestTransform.serverTick, lastReconciledServerTick) <= 0 &&
    acknowledgedClientTick <= lastReconciledClientTickRef.current
  ) {
    if (jumpDebugFrame?.trace) {
      pushJumpDebug({
        phase: 'reconcile:skip-stale-server',
        frameId: jumpDebugFrame.frameId,
        localPosition: vectorDebug(localPositionRef.current),
        serverPosition: vectorDebug(new THREE.Vector3(
          latestTransform.position.x,
          latestTransform.position.y,
          latestTransform.position.z,
        )),
        localClientTick: localClientTickRef.current,
        localTick: localTickRef.current,
        acknowledgedClientTick,
        lastReconciledClientTick: lastReconciledClientTickRef.current,
        latestServerTick: Number(latestTransform.serverTick),
        pendingTickCount: predictedTicksRef.current.length,
      });
    }
    return;
  }

  if (acknowledgedClientTick <= lastReconciledClientTickRef.current) {
    lastReconciledServerTickRef.current = latestTransform.serverTick;
    lastReconciledSeqRef.current = Math.max(lastReconciledSeqRef.current, acknowledgedInputSeq);
    localClientTickRef.current = Math.max(localClientTickRef.current, acknowledgedClientTick);
    if (jumpDebugFrame?.trace) {
      pushJumpDebug({
        phase: 'reconcile:skip-repeated-ack',
        frameId: jumpDebugFrame.frameId,
        localPosition: vectorDebug(localPositionRef.current),
        serverPosition: vectorDebug(new THREE.Vector3(
          latestTransform.position.x,
          latestTransform.position.y,
          latestTransform.position.z,
        )),
        localClientTick: localClientTickRef.current,
        localTick: localTickRef.current,
        acknowledgedClientTick,
        lastReconciledClientTick: lastReconciledClientTickRef.current,
        latestServerTick: Number(latestTransform.serverTick),
        pendingTickCount: predictedTicksRef.current.length,
      });
    }
    return;
  }

  const posBeforeSnap = renderPositionRef.current.clone();
  const ticksAdvanced = lastReconciledServerTick === null
    ? 0
    : Math.max(0, serverTickDelta(latestTransform.serverTick, lastReconciledServerTick));
  // lastProcessedClientTick is the server acknowledgement for local prediction.
  // Server tick tells us an authoritative simulation tick happened, but it does
  // not prove which client movement command was processed during that tick.
  const firstUnackedTickIndex = predictedTicksRef.current.findIndex(
    tick => tick.clientTickAtTick > acknowledgedClientTick,
  );
  const droppedTickCount = firstUnackedTickIndex === -1
    ? predictedTicksRef.current.length
    : firstUnackedTickIndex;
  const droppedTicks = predictedTicksRef.current.slice(0, droppedTickCount);
  predictedTicksRef.current = predictedTicksRef.current.slice(droppedTickCount);

  if (
    droppedTicks.length > 0 &&
    !droppedTicks.some(tick => tick.clientTickAtTick === acknowledgedClientTick)
  ) {
    metrics.seqMismatchCount += 1;
  }

  const serverPosition = new THREE.Vector3(
    latestTransform.position.x,
    latestTransform.position.y,
    latestTransform.position.z,
  );
  metrics.serverPredictedPositionDelta = localPositionRef.current.distanceTo(serverPosition);
  const replayPosition = serverPosition.clone();
  let replayVerticalVelocity = latestTransform.movementState.isGrounded
    ? 0
    : (predictedTicksRef.current[0]?.verticalVelocityBefore ?? localVerticalVelocityRef.current);
  let replayJumpWasPressed = predictedTicksRef.current[0]?.jumpWasPressedBefore ?? localJumpWasPressedRef.current;
  let replayMovementState = { ...latestTransform.movementState };

  let replayLocomotionState: LocomotionState | null = null;
  for (const pending of predictedTicksRef.current) {
    const tickResult = simulateMovementTick(
      replayPosition,
      pending.rotationY,
      pending.input,
      LOCAL_PREDICTION_TICK_DT,
      replayVerticalVelocity,
      replayJumpWasPressed,
      replayMovementState,
    );
    replayVerticalVelocity = tickResult.verticalVelocity;
    replayJumpWasPressed = tickResult.wasJumpPressed;
    replayMovementState = tickResult.movementState;
    replayLocomotionState = tickResult.locomotionState;
  }

  const reconciliationError = localPositionRef.current.distanceTo(replayPosition);
  const preserveLocalVerticalPrediction = shouldPreserveLocalVerticalPrediction({
    localMovementState: localMovementStateRef.current,
    localPosition: localPositionRef.current,
    localVerticalVelocity: localVerticalVelocityRef.current,
  });
  if (jumpDebugFrame?.trace) {
    pushJumpDebug({
      phase: 'reconcile:after-replay',
      frameId: jumpDebugFrame.frameId,
      localPosition: vectorDebug(localPositionRef.current),
      renderPosition: vectorDebug(renderPositionRef.current),
      visualOffset: vectorDebug(visualCorrectionOffsetRef.current),
      previousPredictedPosition: vectorDebug(previousPredictedTickPositionRef.current),
      currentPredictedPosition: vectorDebug(currentPredictedTickPositionRef.current),
      serverPosition: vectorDebug(serverPosition),
      groundY: Number(terrainHeightAt(replayPosition).toFixed(4)),
      localClientTick: localClientTickRef.current,
      localTick: localTickRef.current,
      acknowledgedClientTick,
      lastReconciledClientTick: lastReconciledClientTickRef.current,
      latestServerTick: Number(latestTransform.serverTick),
      verticalVelocity: Number(replayVerticalVelocity.toFixed(4)),
      jumpWasPressed: replayJumpWasPressed,
      movementState: replayMovementState,
      pendingTickCount: predictedTicksRef.current.length,
      droppedTickCount,
      reconciliationError: Number(reconciliationError.toFixed(4)),
      correctionOffsetLength: Number(visualCorrectionOffsetRef.current.length().toFixed(4)),
      note: `replayPosition=${JSON.stringify(vectorDebug(replayPosition))}; preserveLocalVertical=${preserveLocalVerticalPrediction}`,
    });
  }
  metrics.localCorrectionError = reconciliationError;
  metrics.pendingTickCount = predictedTicksRef.current.length;
  metrics.predictedTickCount = predictedTicksRef.current.length;
  metrics.tickAlignmentDrift = ticksAdvanced - droppedTickCount;
  metrics.visualCorrectionOffset = visualCorrectionOffsetRef.current.length();
  lastReconciledClientTickRef.current = acknowledgedClientTick;
  lastReconciledSeqRef.current = acknowledgedInputSeq;
  lastReconciledServerTickRef.current = latestTransform.serverTick;
  localClientTickRef.current = Math.max(localClientTickRef.current, acknowledgedClientTick);

  if (!preserveLocalVerticalPrediction) {
    localMovementStateRef.current = replayMovementState;
    localLocomotionStateRef.current = replayLocomotionState;
    localVerticalVelocityRef.current = replayVerticalVelocity;
    localJumpWasPressedRef.current = replayJumpWasPressed;
  }

  if (reconciliationError > RECONCILIATION_EPSILON_METERS) {
    const correctedPosition = replayPosition.clone();
    if (preserveLocalVerticalPrediction) {
      correctedPosition.y = localPositionRef.current.y;
    } else {
      localVerticalVelocityRef.current = replayVerticalVelocity;
      localJumpWasPressedRef.current = replayJumpWasPressed;
    }
    localPositionRef.current.copy(correctedPosition);
    previousPredictedTickPositionRef.current.copy(correctedPosition);
    currentPredictedTickPositionRef.current.copy(correctedPosition);

    visualCorrectionOffsetRef.current.copy(posBeforeSnap).sub(localPositionRef.current);
    if (preserveLocalVerticalPrediction) {
      visualCorrectionOffsetRef.current.y = 0;
    }
    if (visualCorrectionOffsetRef.current.length() > VISUAL_CORRECTION_SNAP_METERS) {
      visualCorrectionOffsetRef.current.set(0, 0, 0);
    }
    if (jumpDebugFrame?.trace) {
      pushJumpDebug({
        phase: 'reconcile:apply-correction',
        frameId: jumpDebugFrame.frameId,
        localPosition: vectorDebug(localPositionRef.current),
        renderPosition: vectorDebug(renderPositionRef.current),
        visualOffset: vectorDebug(visualCorrectionOffsetRef.current),
        previousPredictedPosition: vectorDebug(previousPredictedTickPositionRef.current),
        currentPredictedPosition: vectorDebug(currentPredictedTickPositionRef.current),
        serverPosition: vectorDebug(serverPosition),
        groundY: Number(terrainHeightAt(localPositionRef.current).toFixed(4)),
        localClientTick: localClientTickRef.current,
        localTick: localTickRef.current,
        acknowledgedClientTick,
        lastReconciledClientTick: lastReconciledClientTickRef.current,
        latestServerTick: Number(latestTransform.serverTick),
        verticalVelocity: Number(localVerticalVelocityRef.current.toFixed(4)),
        jumpWasPressed: localJumpWasPressedRef.current,
        movementState: localMovementStateRef.current ? { ...localMovementStateRef.current } : null,
        pendingTickCount: predictedTicksRef.current.length,
        droppedTickCount,
        reconciliationError: Number(reconciliationError.toFixed(4)),
        correctionOffsetLength: Number(visualCorrectionOffsetRef.current.length().toFixed(4)),
        note: preserveLocalVerticalPrediction
          ? 'preserved local airborne vertical prediction; applied horizontal correction only'
          : undefined,
      });
    }
  }
}

function simulatePredictedTick({
  input,
  rotationY,
  localPositionRef,
  localVerticalVelocityRef,
  localJumpWasPressedRef,
  localMovementStateRef,
  localLocomotionStateRef,
}: {
  input: InputState;
  rotationY: number;
  localPositionRef: MutableRefObject<THREE.Vector3>;
  localVerticalVelocityRef: MutableRefObject<number>;
  localJumpWasPressedRef: MutableRefObject<boolean>;
  localMovementStateRef: MutableRefObject<MovementState | null>;
  localLocomotionStateRef: MutableRefObject<LocomotionState | null>;
}) {
  const tickResult = simulateMovementTick(
    localPositionRef.current,
    rotationY,
    input,
    LOCAL_PREDICTION_TICK_DT,
    localVerticalVelocityRef.current,
    localJumpWasPressedRef.current,
    localMovementStateRef.current,
  );
  localVerticalVelocityRef.current = tickResult.verticalVelocity;
  localJumpWasPressedRef.current = tickResult.wasJumpPressed;
  localMovementStateRef.current = tickResult.movementState;
  localLocomotionStateRef.current = tickResult.locomotionState;
}

function snapToServerTransform({
  latestTransform,
  latestInputAck,
  currentInputRef,
  localPositionRef,
  localVerticalVelocityRef,
  localJumpWasPressedRef,
  localMovementStateRef,
  localLocomotionStateRef,
  metrics,
  localClientTickRef,
  localTickRef,
  predictedTicksRef,
  previousPredictedTickPositionRef,
  currentPredictedTickPositionRef,
  visualCorrectionOffsetRef,
  jumpDebugFrame,
}: {
  latestTransform: PlayerTransform;
  latestInputAck: PlayerInputAck | undefined;
  currentInputRef: MutableRefObject<InputState>;
  localPositionRef: MutableRefObject<THREE.Vector3>;
  localVerticalVelocityRef: MutableRefObject<number>;
  localJumpWasPressedRef: MutableRefObject<boolean>;
  localMovementStateRef: MutableRefObject<MovementState | null>;
  localLocomotionStateRef: MutableRefObject<LocomotionState | null>;
  metrics: NetMetrics;
  localClientTickRef: MutableRefObject<number>;
  localTickRef: MutableRefObject<number>;
  predictedTicksRef: MutableRefObject<PredictedTick[]>;
  previousPredictedTickPositionRef: MutableRefObject<THREE.Vector3>;
  currentPredictedTickPositionRef: MutableRefObject<THREE.Vector3>;
  visualCorrectionOffsetRef: MutableRefObject<THREE.Vector3>;
  jumpDebugFrame?: JumpDebugFrame;
}) {
  const ack = inputAckFields(latestInputAck);
  localPositionRef.current.set(
    latestTransform.position.x,
    latestTransform.position.y,
    latestTransform.position.z,
  );
  localVerticalVelocityRef.current = 0;
  localJumpWasPressedRef.current = false;
  localMovementStateRef.current = { ...latestTransform.movementState };
  localLocomotionStateRef.current = null;
  metrics.lastSentClientTick = ack.lastProcessedClientTick;
  currentInputRef.current.clientTick = ack.lastProcessedClientTick;
  currentInputRef.current.sequence = Math.max(currentInputRef.current.sequence, ack.lastInputSeq);
  localClientTickRef.current = ack.lastProcessedClientTick;
  localTickRef.current = Number(latestTransform.serverTick);
  predictedTicksRef.current = [];
  previousPredictedTickPositionRef.current.copy(localPositionRef.current);
  currentPredictedTickPositionRef.current.copy(localPositionRef.current);
  visualCorrectionOffsetRef.current.set(0, 0, 0);

  if (jumpDebugFrame?.trace) {
    pushJumpDebug({
      phase: 'snap:server-transform',
      frameId: jumpDebugFrame.frameId,
      input: inputDebug(currentInputRef.current),
      localPosition: vectorDebug(localPositionRef.current),
      renderPosition: vectorDebug(localPositionRef.current),
      visualOffset: vectorDebug(visualCorrectionOffsetRef.current),
      previousPredictedPosition: vectorDebug(previousPredictedTickPositionRef.current),
      currentPredictedPosition: vectorDebug(currentPredictedTickPositionRef.current),
      serverPosition: vectorDebug(new THREE.Vector3(
        latestTransform.position.x,
        latestTransform.position.y,
        latestTransform.position.z,
      )),
      groundY: Number(terrainHeightAt(localPositionRef.current).toFixed(4)),
      localClientTick: localClientTickRef.current,
      localTick: localTickRef.current,
      acknowledgedClientTick: ack.lastProcessedClientTick,
      latestServerTick: Number(latestTransform.serverTick),
      verticalVelocity: localVerticalVelocityRef.current,
      jumpWasPressed: localJumpWasPressedRef.current,
      movementState: localMovementStateRef.current ? { ...localMovementStateRef.current } : null,
      pendingTickCount: predictedTicksRef.current.length,
      correctionOffsetLength: Number(visualCorrectionOffsetRef.current.length().toFixed(4)),
      note: 'hard reset to authoritative transform',
    });
  }
}

function serverTickDelta(current: PlayerTransform['serverTick'], previous: PlayerTransform['serverTick']): number {
  return Number(current) - Number(previous);
}

function compareServerTicks(left: PlayerTransform['serverTick'], right: PlayerTransform['serverTick']): number {
  const delta = serverTickDelta(left, right);
  return delta === 0 ? 0 : Math.sign(delta);
}

function updateLocalCamera({
  audioListenerPositionRef,
  camera,
  cameraOffsetRef,
  cameraPitch,
  cameraRotationMatrixRef,
  cameraRotationRef,
  localRotationY,
  renderPosition,
}: {
  audioListenerPositionRef: MutableRefObject<THREE.Vector3>;
  camera: THREE.Camera;
  cameraOffsetRef: MutableRefObject<THREE.Vector3>;
  cameraPitch: number;
  cameraRotationMatrixRef: MutableRefObject<THREE.Matrix4>;
  cameraRotationRef: MutableRefObject<THREE.Euler>;
  localRotationY: number;
  renderPosition: THREE.Vector3;
}) {
  cameraRotationRef.current.set(cameraPitch, localRotationY, 0, 'YXZ');
  cameraOffsetRef.current.set(0, CAMERA_HEIGHT, CAMERA_DISTANCE);
  cameraRotationMatrixRef.current.makeRotationFromEuler(cameraRotationRef.current);
  cameraOffsetRef.current.applyMatrix4(cameraRotationMatrixRef.current);
  camera.position.copy(renderPosition).add(cameraOffsetRef.current);
  camera.rotation.copy(cameraRotationRef.current);
  setAudioListenerWorldPosition(
    audioListenerPositionRef.current
      .copy(renderPosition)
      .addScaledVector(camera.up, AUDIO_LISTENER_HEIGHT),
  );
}

function logLocalFrameDebug({
  camera,
  debugRefs,
  dt,
  latestTransform,
  localPositionRef,
  renderPositionRef,
}: {
  camera: THREE.Camera;
  debugRefs: LocalPlayerFrameOptions['debugRefs'];
  dt: number;
  latestTransform: PlayerTransform | undefined;
  localPositionRef: MutableRefObject<THREE.Vector3>;
  renderPositionRef: MutableRefObject<THREE.Vector3>;
}) {
  const simToRenderError = localPositionRef.current.distanceTo(renderPositionRef.current);
  const shouldLogByTime = performance.now() - debugRefs.lastLogAtRef.current >= DEBUG_LOG_INTERVAL_MS;
  const serverTickChanged = latestTransform?.serverTick !== debugRefs.lastServerTickRef.current;
  const simChanged = debugRefs.lastSimLogPositionRef.current.distanceTo(localPositionRef.current) > DEBUG_POSITION_EPSILON;
  const renderChanged = debugRefs.lastRenderLogPositionRef.current.distanceTo(renderPositionRef.current) > DEBUG_POSITION_EPSILON;
  const cameraChanged = debugRefs.lastCameraLogPositionRef.current.distanceTo(camera.position) > DEBUG_POSITION_EPSILON;

  if (ENABLE_PLAYER_DEBUG_LOGS && shouldLogByTime && (serverTickChanged || simChanged || renderChanged || cameraChanged)) {
    debugRefs.lastLogAtRef.current = performance.now();
    debugRefs.lastServerTickRef.current = latestTransform?.serverTick ?? null;
    debugRefs.lastSimLogPositionRef.current.copy(localPositionRef.current);
    debugRefs.lastRenderLogPositionRef.current.copy(renderPositionRef.current);
    debugRefs.lastCameraLogPositionRef.current.copy(camera.position);

    console.log(
      '[FRAME]',
      `time=${performance.now().toFixed(1)}`,
      `dt=${dt.toFixed(4)}`,
      `simToRenderError=${simToRenderError.toFixed(4)}`,
    );
  }
}

function updateWizardAimTargets({
  camera,
  capabilities,
  fireballAimDirectionRef,
  fireballLineRef,
  fireballTargetRef,
  isDead,
  lightningAimDirectionRef,
  lightningAimPointRef,
  lightningHorizontalOffsetRef,
  lightningReticleRef,
  lightningTargetRef,
  lightningTerrainNormalRef,
  localRotationY,
  renderPositionRef,
  selectedWizardSpell,
}: {
  camera: THREE.Camera;
  capabilities: ClassCapabilities;
  fireballAimDirectionRef: MutableRefObject<THREE.Vector3>;
  fireballLineRef: MutableRefObject<THREE.Line | null>;
  fireballTargetRef: MutableRefObject<THREE.Vector3>;
  isDead: boolean;
  lightningAimDirectionRef: MutableRefObject<THREE.Vector3>;
  lightningAimPointRef: MutableRefObject<THREE.Vector3>;
  lightningHorizontalOffsetRef: MutableRefObject<THREE.Vector3>;
  lightningReticleRef: MutableRefObject<THREE.Group | null>;
  lightningTargetRef: MutableRefObject<THREE.Vector3>;
  lightningTerrainNormalRef: MutableRefObject<THREE.Vector3>;
  localRotationY: number;
  renderPositionRef: MutableRefObject<THREE.Vector3>;
  selectedWizardSpell: 'fireball' | 'lightning';
}) {
  const reticle = lightningReticleRef.current;
  if (reticle) {
    const showLightningTarget =
      capabilities.spells.includes('lightning') && !isDead && selectedWizardSpell === 'lightning';
    reticle.visible = showLightningTarget;

    if (showLightningTarget) {
      const aimDirection = lightningAimDirectionRef.current;
      camera.getWorldDirection(aimDirection).normalize();

      const aimPoint = lightningAimPointRef.current;
      const foundTerrainHit = findTerrainHitAlongRay(
        camera.position,
        aimDirection,
        LIGHTNING_TARGET_DISTANCE + CAMERA_DISTANCE + CAMERA_HEIGHT,
        aimPoint,
      );
      if (!foundTerrainHit) {
        const horizontalAimLength = Math.hypot(aimDirection.x, aimDirection.z);
        if (horizontalAimLength > 0.001) {
          aimPoint.set(
            renderPositionRef.current.x + (aimDirection.x / horizontalAimLength) * LIGHTNING_AIM_FALLBACK_DISTANCE,
            0,
            renderPositionRef.current.z + (aimDirection.z / horizontalAimLength) * LIGHTNING_AIM_FALLBACK_DISTANCE,
          );
          aimPoint.y = terrainHeightAt(aimPoint);
        } else {
          aimPoint.copy(renderPositionRef.current);
        }
      }

      const horizontalOffset = lightningHorizontalOffsetRef.current;
      horizontalOffset.set(
        aimPoint.x - renderPositionRef.current.x,
        0,
        aimPoint.z - renderPositionRef.current.z,
      );
      const horizontalDistance = Math.hypot(horizontalOffset.x, horizontalOffset.z);
      if (horizontalDistance > LIGHTNING_TARGET_DISTANCE) {
        horizontalOffset.multiplyScalar(LIGHTNING_TARGET_DISTANCE / horizontalDistance);
      }

      const target = lightningTargetRef.current;
      target.set(
        renderPositionRef.current.x + horizontalOffset.x,
        0,
        renderPositionRef.current.z + horizontalOffset.z,
      );
      target.y = terrainHeightAt(target);
      const terrainNormal = getTerrainNormalAt(target, lightningTerrainNormalRef.current);
      target.addScaledVector(terrainNormal, LIGHTNING_TARGET_Y_OFFSET);
      reticle.position.copy(target);
      reticle.quaternion.setFromUnitVectors(LIGHTNING_RETICLE_UP, terrainNormal);
    }
  }

  const fireballLine = fireballLineRef.current;
  if (!fireballLine) return;

  const showFireballTarget =
    capabilities.spells.includes('fireball') && !isDead && selectedWizardSpell === 'fireball';
  fireballLine.visible = showFireballTarget;

  if (!showFireballTarget) return;

  const aimDirection = fireballAimDirectionRef.current;
  camera.getWorldDirection(aimDirection);
  aimDirection.y = 0;
  if (aimDirection.lengthSq() <= 0.0001) {
    aimDirection.set(
      -Math.sin(localRotationY),
      0,
      -Math.cos(localRotationY),
    );
  }
  aimDirection.normalize();

  const start = renderPositionRef.current;
  const target = fireballTargetRef.current;
  target.set(
    start.x + aimDirection.x * FIREBALL_TARGET_DISTANCE,
    0,
    start.z + aimDirection.z * FIREBALL_TARGET_DISTANCE,
  );
  target.y = terrainHeightAt(target);
  publishFireballAimDebug({
    aimDirection: fireballVectorDebug(aimDirection),
    cameraPosition: fireballVectorDebug(camera.position),
    localRotationY: Number(localRotationY.toFixed(3)),
    renderPosition: fireballVectorDebug(start),
    targetPosition: fireballVectorDebug(target),
  });

  const geometry = fireballLine.geometry as THREE.BufferGeometry;
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  positions.setXYZ(0, start.x, terrainHeightAt(start) + FIREBALL_MARKER_Y_OFFSET, start.z);
  positions.setXYZ(1, target.x, target.y + FIREBALL_MARKER_Y_OFFSET, target.z);
  positions.needsUpdate = true;
  geometry.computeBoundingSphere();
}

function getLocalMovementAnimationDirection(input: InputState): MovementAnimationDirection {
  if (input.left && !input.right) return 'left';
  if (input.right && !input.left) return 'right';
  if (input.forward) return 'forward';
  if (input.backward) return 'back';
  return 'forward';
}

function findTerrainHitAlongRay(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
  out: THREE.Vector3,
): boolean {
  let previousDistance = 0;
  let previousDelta = origin.y - terrainHeightAt(origin);

  for (let distance = LIGHTNING_AIM_RAY_STEP; distance <= maxDistance; distance += LIGHTNING_AIM_RAY_STEP) {
    out.copy(origin).addScaledVector(direction, distance);
    const delta = out.y - terrainHeightAt(out);
    if (delta <= 0) {
      let low = previousDistance;
      let high = distance;
      for (let i = 0; i < 6; i += 1) {
        const mid = (low + high) * 0.5;
        out.copy(origin).addScaledVector(direction, mid);
        if (out.y - terrainHeightAt(out) <= 0) {
          high = mid;
        } else {
          low = mid;
        }
      }
      out.copy(origin).addScaledVector(direction, high);
      out.y = terrainHeightAt(out);
      return true;
    }

    previousDistance = distance;
    previousDelta = delta;
  }

  return previousDelta <= 0;
}

function getTerrainNormalAt(position: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const sampleDistance = LIGHTNING_NORMAL_SAMPLE_DISTANCE;
  const left = sampleHeight(position.x - sampleDistance, position.z);
  const right = sampleHeight(position.x + sampleDistance, position.z);
  const down = sampleHeight(position.x, position.z - sampleDistance);
  const up = sampleHeight(position.x, position.z + sampleDistance);

  out.set(
    left - right,
    sampleDistance * 2,
    down - up,
  );
  return out.normalize();
}
