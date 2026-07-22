import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { InputState, MovementState, PlayerInputAck, PlayerTransform } from '../generated/types';
import { terrainHeightAt } from '../heightmap';
import { simulateMovementTick, type LocomotionState } from '../movement';
import { createMetrics } from '../netcode';
import {
  LOCAL_PREDICTION_TICK_DT,
  LocalPlayerRuntime,
  shouldClearVerticalCorrection,
} from './localPlayerFrame';

const IDENTITY = { toHexString: () => 'local-player' };
const RECONCILIATION_EPSILON_METERS = 0.12;

type AuthoritySnapshot = {
  transform: PlayerTransform;
  ack: PlayerInputAck;
};

function input(sequence: number, fields: Partial<InputState> = {}): InputState {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    jump: false,
    sequence,
    clientTick: sequence,
    ...fields,
  };
}

function initialMovementState(): MovementState {
  return {
    isGrounded: true,
    wasGrounded: true,
    isAirborne: false,
    sprintIntent: false,
    sprintActive: false,
  };
}

function authorityFromState(state: FakeServerState): AuthoritySnapshot {
  return {
    transform: {
      identity: IDENTITY,
      position: { x: state.position.x, y: state.position.y, z: state.position.z },
      rotationY: state.rotationY,
      isMoving: state.latestInput.forward || state.latestInput.backward || state.latestInput.left || state.latestInput.right,
      movementState: { ...state.movementState },
      serverTick: BigInt(state.serverTick),
      updatedAt: {} as PlayerTransform['updatedAt'],
    } as PlayerTransform,
    ack: {
      identity: IDENTITY,
      lastInputSeq: state.latestInput.sequence,
      lastProcessedClientTick: state.latestInput.clientTick,
      serverTick: BigInt(state.serverTick),
    } as PlayerInputAck,
  };
}

function transformFromState(state: FakeServerState): PlayerTransform {
  return authorityFromState(state).transform;
}

function authorityFromPosition({
  clientTick,
  inputSeq,
  movementState,
  position,
  rotationY = 0,
  serverTick,
}: {
  clientTick: number;
  inputSeq: number;
  movementState: MovementState;
  position: THREE.Vector3;
  rotationY?: number;
  serverTick: number;
}): AuthoritySnapshot {
  return {
    transform: {
      identity: IDENTITY,
      position: { x: position.x, y: position.y, z: position.z },
      rotationY,
      isMoving: false,
      movementState: { ...movementState },
      serverTick: BigInt(serverTick),
      updatedAt: {} as PlayerTransform['updatedAt'],
    } as PlayerTransform,
    ack: {
      identity: IDENTITY,
      lastInputSeq: inputSeq,
      lastProcessedClientTick: clientTick,
      serverTick: BigInt(serverTick),
    } as PlayerInputAck,
  };
}

function transformFromPosition(args: {
  clientTick: number;
  inputSeq: number;
  movementState: MovementState;
  position: THREE.Vector3;
  rotationY?: number;
  serverTick: number;
}): PlayerTransform {
  return authorityFromPosition(args).transform;
}

function ackFromPosition(args: {
  clientTick: number;
  inputSeq: number;
  movementState: MovementState;
  position: THREE.Vector3;
  rotationY?: number;
  serverTick: number;
}): PlayerInputAck {
  return authorityFromPosition(args).ack;
}

class FakeServerState {
  readonly position = new THREE.Vector3();
  rotationY = 0;
  latestInput = input(0);
  movementState = initialMovementState();
  locomotionState: LocomotionState | null = null;
  verticalVelocity = 0;
  wasJumpPressed = false;
  serverTick = 0;

  applyInput(nextInput: InputState, rotationY: number) {
    this.latestInput = { ...nextInput };
    this.rotationY = rotationY;
  }

  step() {
    const tickResult = simulateMovementTick(
      this.position,
      this.rotationY,
      this.latestInput,
      LOCAL_PREDICTION_TICK_DT,
      this.verticalVelocity,
      this.wasJumpPressed,
      this.movementState,
    );
    this.verticalVelocity = tickResult.verticalVelocity;
    this.wasJumpPressed = tickResult.wasJumpPressed;
    this.movementState = tickResult.movementState;
    this.locomotionState = tickResult.locomotionState;
    this.serverTick += 1;
  }
}


function createRuntime() {
  const group = new THREE.Group();
  const camera = new THREE.PerspectiveCamera();
  const rotationYRef = { current: 0 };
  const runtime = new LocalPlayerRuntime({
    camera,
    characterClass: 'knight',
    groupRef: { current: group },
    identityKey: 'local-player',
    jumpAnimationName: 'jump',
    rotationYRef,
    selectedWizardSpell: 'fireball',
    toVisualYaw: rotationY => rotationY,
  });
  return { runtime, group, camera, rotationYRef };
}

function runScenario(inputsByTick: (tick: number) => InputState, latencyTicks: number) {
  const server = new FakeServerState();
  const { runtime } = createRuntime();
  const metrics = createMetrics();
  const snapshots: Array<{ deliverTick: number; authority: AuthoritySnapshot }> = [
    { deliverTick: 0, authority: authorityFromState(server) },
  ];
  const authoritativeByTick = new Map<number, THREE.Vector3>([[0, server.position.clone()]]);
  let latestTransform: PlayerTransform | undefined;
  let latestInputAck: PlayerInputAck | undefined;

  for (let tick = 0; tick < 90; tick += 1) {
    const delivered = snapshots.filter(snapshot => snapshot.deliverTick === tick);
    if (delivered.length > 0) {
      const authority = delivered[delivered.length - 1].authority;
      latestTransform = authority.transform;
      latestInputAck = authority.ack;
    }

    const currentInput = inputsByTick(tick + 1);
    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform,
      latestInputAck,
      metrics,
    });

    server.applyInput(currentInput, 0);
    server.step();
    authoritativeByTick.set(server.serverTick, server.position.clone());
    snapshots.push({
      deliverTick: tick + latencyTicks + 1,
      authority: authorityFromState(server),
    });

    const debug = runtime.getPredictionDebugState();
    const expected = authoritativeByTick.get(debug.localTick);
    expect(expected, `missing authoritative tick ${debug.localTick}`).toBeDefined();
    expect(debug.localPosition.distanceTo(expected!)).toBeLessThan(0.000001);
    expect(debug.movementState).toEqual(server.movementState);
    expect(debug.locomotionState?.phase).toBe(server.locomotionState?.phase);
    expect(metrics.localCorrectionError).toBeLessThan(0.000001);
  }
}

function replayFromAcknowledgement(
  latestTransform: PlayerTransform,
  latestInputAck: PlayerInputAck,
  sentInputsByClientTick: Map<number, { input: InputState; rotationY: number }>,
  currentClientTick: number,
): THREE.Vector3 {
  const replayPosition = new THREE.Vector3(
    latestTransform.position.x,
    latestTransform.position.y,
    latestTransform.position.z,
  );
  let replayMovementState = { ...latestTransform.movementState };
  let replayVerticalVelocity = latestTransform.movementState.isGrounded ? 0 : 0;
  let replayJumpWasPressed = false;

  for (let clientTick = latestInputAck.lastProcessedClientTick + 1; clientTick <= currentClientTick; clientTick += 1) {
    const pending = sentInputsByClientTick.get(clientTick);
    if (!pending) continue;

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
  }

  return replayPosition;
}

function runDelayedInputScenario({
  inputLatencyTicks,
  inputsByTick,
  rotationByTick = () => 0,
  ticks,
  transformLatencyTicks,
}: {
  inputLatencyTicks: number;
  inputsByTick: (tick: number) => InputState;
  rotationByTick?: (tick: number) => number;
  ticks: number;
  transformLatencyTicks: number;
}) {
  const server = new FakeServerState();
  const { runtime } = createRuntime();
  const metrics = createMetrics();
  const sentInputsByClientTick = new Map<number, { input: InputState; rotationY: number }>();
  const inputCommands: Array<{ deliverTick: number; input: InputState; rotationY: number }> = [];
  const snapshots: Array<{ deliverTick: number; authority: AuthoritySnapshot }> = [
    { deliverTick: 0, authority: authorityFromState(server) },
  ];
  let latestTransform: PlayerTransform | undefined;
  let latestInputAck: PlayerInputAck | undefined;

  for (let tick = 0; tick < ticks; tick += 1) {
    const deliveredSnapshots = snapshots.filter(snapshot => snapshot.deliverTick === tick);
    if (deliveredSnapshots.length > 0) {
      const authority = deliveredSnapshots[deliveredSnapshots.length - 1].authority;
      latestTransform = authority.transform;
      latestInputAck = authority.ack;
    }

    const currentInput = inputsByTick(tick + 1);
    const rotationY = rotationByTick(tick + 1);
    runtime.localRotationYRef.current = rotationY;

    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform,
      latestInputAck,
      metrics,
    });
    sentInputsByClientTick.set(currentInput.clientTick, {
      input: { ...currentInput },
      rotationY,
    });

    if (latestTransform && latestInputAck) {
      const expectedPosition = replayFromAcknowledgement(
        latestTransform,
        latestInputAck,
        sentInputsByClientTick,
        currentInput.clientTick,
      );
      const debug = runtime.getPredictionDebugState();
      expect(debug.localPosition.distanceTo(expectedPosition)).toBeLessThan(RECONCILIATION_EPSILON_METERS);
      expect(metrics.acknowledgedInputSeq).toBe(latestInputAck.lastInputSeq);
      expect(metrics.acknowledgedClientTick).toBe(latestInputAck.lastProcessedClientTick);
      expect(metrics.latestServerTick).toBe(Number(latestTransform.serverTick));
      expect(metrics.localTick).toBe(debug.localTick);
    }

    inputCommands.push({
      deliverTick: tick + inputLatencyTicks,
      input: currentInput,
      rotationY,
    });
    const deliveredInputs = inputCommands.filter(command => command.deliverTick === tick);
    for (const command of deliveredInputs) {
      server.applyInput(command.input, command.rotationY);
    }
    server.step();
    snapshots.push({
      deliverTick: tick + transformLatencyTicks + 1,
      authority: authorityFromState(server),
    });
  }
}

describe('LocalPlayerRuntime tick prediction', () => {
  it('clears vertical correction when movement state is grounded but height is airborne', () => {
    expect(shouldClearVerticalCorrection({
      groundY: 10,
      movementState: initialMovementState(),
      positionY: 10.25,
      verticalVelocity: 0,
    })).toBe(true);
  });

  it('clears vertical correction when movement state is grounded but vertical velocity remains active', () => {
    expect(shouldClearVerticalCorrection({
      groundY: 10,
      movementState: initialMovementState(),
      positionY: 10,
      verticalVelocity: -0.2,
    })).toBe(true);
  });

  it('keeps normal correction decay when grounded and stable', () => {
    expect(shouldClearVerticalCorrection({
      groundY: 10,
      movementState: initialMovementState(),
      positionY: 10.01,
      verticalVelocity: 0.001,
    })).toBe(false);
  });

  it('positions the camera from render-smoothed local position after reconciliation', () => {
    const { runtime, camera } = createRuntime();
    const metrics = createMetrics();
    const currentInput = input(0);
    let latestTransform = transformFromPosition({
      clientTick: 0,
      inputSeq: 0,
      movementState: initialMovementState(),
      position: new THREE.Vector3(),
      serverTick: 0,
    });
    let latestInputAck = ackFromPosition({
      clientTick: 0,
      inputSeq: 0,
      movementState: initialMovementState(),
      position: new THREE.Vector3(),
      serverTick: 0,
    });

    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform,
      latestInputAck,
      metrics,
    });

    currentInput.right = true;
    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform,
      latestInputAck,
      metrics,
    });

    latestTransform = transformFromPosition({
      clientTick: currentInput.clientTick,
      inputSeq: currentInput.sequence + 1,
      movementState: initialMovementState(),
      position: new THREE.Vector3(-0.5, 0, 0),
      serverTick: 1,
    });


    latestInputAck = ackFromPosition({
      clientTick: currentInput.clientTick,
      inputSeq: currentInput.sequence + 1,
      movementState: initialMovementState(),
      position: new THREE.Vector3(-0.5, 0, 0),
      serverTick: 1,
    });
    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform,
      latestInputAck,
      metrics,
    });

    const debug = runtime.getPredictionDebugState();
    const expectedCameraPosition = debug.renderPosition.clone().add(new THREE.Vector3(0, 2, 5));
    expect(camera.position.distanceTo(expectedCameraPosition)).toBeLessThan(0.000001);
  });

  it('matches a delayed 20 Hz server while holding movement', () => {
    runScenario(tick => input(tick, { forward: true }), 3);
  });

  it('matches a delayed 20 Hz server when jumping during movement', () => {
    runScenario(tick => input(tick, { forward: true, jump: tick >= 8 && tick <= 10 }), 4);
  });

  it('preserves airborne local y during vertical reconciliation correction', () => {
    const { runtime } = createRuntime();
    const metrics = createMetrics();
    const currentInput = input(100);
    const startPosition = new THREE.Vector3();
    startPosition.y = terrainHeightAt(startPosition);
    const initialTransform = transformFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: startPosition,
      serverTick: 100,
    });
    const initialTransformAck = ackFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: startPosition,
      serverTick: 100,
    });

    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: initialTransform,
      latestInputAck: initialTransformAck,
      metrics,
    });

    currentInput.jump = true;
    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: undefined,
      latestInputAck: undefined,
      metrics,
    });

    const beforeAck = runtime.getPredictionDebugState();
    expect(beforeAck.verticalVelocity).toBeGreaterThan(0);
    const authoritativePosition = beforeAck.localPosition.clone();
    authoritativePosition.x += 0.5;
    authoritativePosition.y -= 1.0;
    const ackTransform = transformFromPosition({
      clientTick: 101,
      inputSeq: 100,
      movementState: {
        isGrounded: false,
        wasGrounded: true,
        isAirborne: true,
        sprintIntent: false,
        sprintActive: false,
      },
      position: authoritativePosition,
      serverTick: 101,
    });
    const ackTransformAck = ackFromPosition({
      clientTick: 101,
      inputSeq: 100,
      movementState: {
        isGrounded: false,
        wasGrounded: true,
        isAirborne: true,
        sprintIntent: false,
        sprintActive: false,
      },
      position: authoritativePosition,
      serverTick: 101,
    });

    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: ackTransform,
      latestInputAck: ackTransformAck,
      metrics,
    });

    const afterAck = runtime.getPredictionDebugState();
    expect(afterAck.localPosition.x).toBeCloseTo(authoritativePosition.x, 6);
    expect(afterAck.localPosition.y).toBeCloseTo(beforeAck.localPosition.y, 6);
    expect(afterAck.verticalVelocity).toBeCloseTo(beforeAck.verticalVelocity, 6);
    expect(afterAck.visualCorrectionOffset.y).toBe(0);
    expect(afterAck.renderPosition.y).toBeCloseTo(afterAck.localPosition.y, 6);
  });

  it('does not restart an airborne jump arc when reconciling while falling', () => {
    const { runtime } = createRuntime();
    const metrics = createMetrics();
    const currentInput = input(200);
    const startPosition = new THREE.Vector3();
    startPosition.y = terrainHeightAt(startPosition);

    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: transformFromPosition({
        clientTick: 200,
        inputSeq: 200,
        movementState: initialMovementState(),
        position: startPosition,
        serverTick: 200,
      }),
      latestInputAck: ackFromPosition({
        clientTick: 200,
        inputSeq: 200,
        movementState: initialMovementState(),
        position: startPosition,
        serverTick: 200,
      }),
      metrics,
    });

    currentInput.jump = true;
    for (let tick = 0; tick < 12; tick += 1) {
      currentInput.clientTick = 201 + tick;
      runtime.runFrame({
        currentInput,
        deltaSeconds: LOCAL_PREDICTION_TICK_DT,
        isDead: false,
        jumpAnimationDurationMs: 500,
        latestTransform: undefined,
      latestInputAck: undefined,
        metrics,
      });
    }

    const beforeAck = runtime.getPredictionDebugState();
    expect(beforeAck.movementState?.isAirborne).toBe(true);
    expect(beforeAck.verticalVelocity).toBeLessThan(0);

    const replayPosition = beforeAck.localPosition.clone();
    replayPosition.x += 0.5;
    replayPosition.y += 1.25;
    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: transformFromPosition({
        clientTick: currentInput.clientTick,
        inputSeq: currentInput.sequence,
        movementState: {
          isGrounded: false,
          wasGrounded: false,
          isAirborne: true,
          sprintIntent: false,
          sprintActive: false,
        },
        position: replayPosition,
        serverTick: 220,
      }),
      latestInputAck: ackFromPosition({
        clientTick: currentInput.clientTick,
        inputSeq: currentInput.sequence,
        movementState: {
          isGrounded: false,
          wasGrounded: false,
          isAirborne: true,
          sprintIntent: false,
          sprintActive: false,
        },
        position: replayPosition,
        serverTick: 220,
      }),
      metrics,
    });

    const afterAck = runtime.getPredictionDebugState();
    expect(afterAck.localPosition.x).toBeCloseTo(replayPosition.x, 6);
    expect(afterAck.localPosition.y).toBeCloseTo(beforeAck.localPosition.y, 6);
    expect(afterAck.verticalVelocity).toBeLessThan(0);
    expect(afterAck.visualCorrectionOffset.y).toBe(0);
  });

  it('preserves active jump state when ack state says grounded above terrain', () => {
    const { runtime } = createRuntime();
    const metrics = createMetrics();
    const currentInput = input(100);
    const startPosition = new THREE.Vector3();
    startPosition.y = terrainHeightAt(startPosition);
    const initialTransform = transformFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: startPosition,
      serverTick: 100,
    });
    const initialTransformAck = ackFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: startPosition,
      serverTick: 100,
    });

    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: initialTransform,
      latestInputAck: initialTransformAck,
      metrics,
    });

    currentInput.jump = true;
    currentInput.right = true;
    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: undefined,
      latestInputAck: undefined,
      metrics,
    });

    const beforeAck = runtime.getPredictionDebugState();
    const authoritativePosition = beforeAck.localPosition.clone();
    authoritativePosition.y -= 0.12;
    const groundY = terrainHeightAt(authoritativePosition);
    authoritativePosition.y = Math.max(authoritativePosition.y, groundY + 0.2);

    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: transformFromPosition({
        clientTick: 101,
        inputSeq: 100,
        movementState: initialMovementState(),
        position: authoritativePosition,
        serverTick: 101,
      }),
      latestInputAck: ackFromPosition({
        clientTick: 101,
        inputSeq: 100,
        movementState: initialMovementState(),
        position: authoritativePosition,
        serverTick: 101,
      }),
      metrics,
    });

    const afterAck = runtime.getPredictionDebugState();
    expect(afterAck.movementState?.isAirborne).toBe(true);
    expect(afterAck.localPosition.y).toBeGreaterThan(terrainHeightAt(afterAck.localPosition) + 0.05);
    expect(afterAck.visualCorrectionOffset.y).toBe(0);
    expect(afterAck.renderPosition.y).toBeCloseTo(afterAck.localPosition.y, 6);
  });

  it('clears visual y offset while sprinting across steep terrain height changes', () => {
    const { runtime } = createRuntime();
    const metrics = createMetrics();
    const currentInput = input(100, { forward: true, sprint: true });
    const startPosition = new THREE.Vector3(-30, 0, -28);
    startPosition.y = terrainHeightAt(startPosition);

    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: transformFromPosition({
        clientTick: 100,
        inputSeq: 100,
        movementState: initialMovementState(),
        position: startPosition,
        serverTick: 100,
      }),
      latestInputAck: ackFromPosition({
        clientTick: 100,
        inputSeq: 100,
        movementState: initialMovementState(),
        position: startPosition,
        serverTick: 100,
      }),
      metrics,
    });

    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: undefined,
      latestInputAck: undefined,
      metrics,
    });

    const predicted = runtime.getPredictionDebugState();
    const authoritativePosition = predicted.localPosition.clone();
    authoritativePosition.y = terrainHeightAt(authoritativePosition) + 0.15;

    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: transformFromPosition({
        clientTick: 101,
        inputSeq: 100,
        movementState: initialMovementState(),
        position: authoritativePosition,
        serverTick: 101,
      }),
      latestInputAck: ackFromPosition({
        clientTick: 101,
        inputSeq: 100,
        movementState: initialMovementState(),
        position: authoritativePosition,
        serverTick: 101,
      }),
      metrics,
    });

    const afterAck = runtime.getPredictionDebugState();
    expect(afterAck.localPosition.y).toBeGreaterThan(terrainHeightAt(afterAck.localPosition) + 0.05);
    expect(afterAck.visualCorrectionOffset.y).toBe(0);
    expect(afterAck.renderPosition.y).toBeCloseTo(afterAck.localPosition.y, 6);
  });

  it('does not rebase a pending local jump on a repeated client tick acknowledgement', () => {
    const { runtime } = createRuntime();
    const metrics = createMetrics();
    const currentInput = input(100);
    const startPosition = new THREE.Vector3();
    startPosition.y = terrainHeightAt(startPosition);
    const initialTransform = transformFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: startPosition,
      serverTick: 100,
    });
    const initialTransformAck = ackFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: startPosition,
      serverTick: 100,
    });

    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: initialTransform,
      latestInputAck: initialTransformAck,
      metrics,
    });

    currentInput.jump = true;
    currentInput.clientTick = 101;
    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: undefined,
      latestInputAck: undefined,
      metrics,
    });

    const beforeRepeatedAck = runtime.getPredictionDebugState();
    expect(beforeRepeatedAck.predictedClientTicks).toEqual([101]);

    const airborneState: MovementState = {
      isGrounded: false,
      wasGrounded: true,
      isAirborne: true,
      sprintIntent: false,
      sprintActive: false,
    };

    const newerServerPosition = beforeRepeatedAck.localPosition.clone();
    newerServerPosition.y += 0.35;
    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: transformFromPosition({
        clientTick: 100,
        inputSeq: 100,
        movementState: airborneState,
        position: newerServerPosition,
        serverTick: 101,
      }),
      latestInputAck: ackFromPosition({
        clientTick: 100,
        inputSeq: 100,
        movementState: airborneState,
        position: newerServerPosition,
        serverTick: 101,
      }),
      metrics,
    });

    const debug = runtime.getPredictionDebugState();
    expect(debug.localPosition.y).toBeCloseTo(beforeRepeatedAck.localPosition.y, 6);
    expect(debug.predictedClientTicks).toEqual([101]);
    expect(metrics.localCorrectionError).toBe(0);
  });

  it('matches a delayed 20 Hz server when input changes mid-flight', () => {
    runScenario(tick => input(tick, {
      forward: tick < 30,
      right: tick >= 30,
      jump: tick >= 8 && tick <= 10,
    }), 5);
  });

  it('reconciles by input acknowledgement when input delivery lags transform delivery', () => {
    runDelayedInputScenario({
      inputLatencyTicks: 5,
      transformLatencyTicks: 2,
      ticks: 90,
      inputsByTick: tick => input(tick, {
        forward: tick <= 35,
      }),
    });
  });

  it('does not pull backward after stopping when movement commands arrive late', () => {
    runDelayedInputScenario({
      inputLatencyTicks: 6,
      transformLatencyTicks: 3,
      ticks: 110,
      inputsByTick: tick => input(tick, {
        forward: tick <= 40,
        sprint: tick <= 40,
      }),
    });
  });

  it('handles delayed sprint strafe right commands', () => {
    runDelayedInputScenario({
      inputLatencyTicks: 5,
      transformLatencyTicks: 3,
      ticks: 90,
      inputsByTick: tick => input(tick, {
        right: tick <= 50,
        sprint: tick <= 50,
      }),
    });
  });

  it('handles delayed alternating left and right strafe commands', () => {
    runDelayedInputScenario({
      inputLatencyTicks: 5,
      transformLatencyTicks: 3,
      ticks: 100,
      inputsByTick: tick => input(tick, {
        left: tick <= 80 && Math.floor(tick / 8) % 2 === 0,
        right: tick <= 80 && Math.floor(tick / 8) % 2 === 1,
        sprint: tick <= 80,
      }),
    });
  });

  it('handles delayed sprint strafe commands while rotation changes', () => {
    runDelayedInputScenario({
      inputLatencyTicks: 5,
      transformLatencyTicks: 3,
      ticks: 100,
      rotationByTick: tick => tick * 0.02,
      inputsByTick: tick => input(tick, {
        right: tick <= 70,
        sprint: tick <= 70,
      }),
    });
  });

  it('reconciles alternating sprint-strafe with changing rotation and delayed input delivery', () => {
    runDelayedInputScenario({
      inputLatencyTicks: 6,
      transformLatencyTicks: 3,
      ticks: 130,
      rotationByTick: tick => Math.sin(tick * 0.17) * 0.9,
      inputsByTick: tick => input(tick, {
        forward: true,
        left: Math.floor(tick / 10) % 2 === 1,
        right: Math.floor(tick / 10) % 2 === 0,
        sprint: true,
      }),
    });
  });

  it('prediction catches up when an immediate send claims a newer client tick', () => {
    const { runtime } = createRuntime();
    const metrics = createMetrics();
    const currentInput = input(100);
    const initialTransform = transformFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: new THREE.Vector3(),
      serverTick: 100,
    });
    const initialTransformAck = ackFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: new THREE.Vector3(),
      serverTick: 100,
    });

    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: initialTransform,
      latestInputAck: initialTransformAck,
      metrics,
    });

    currentInput.right = true;
    currentInput.clientTick = 151;
    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: undefined,
      latestInputAck: undefined,
      metrics,
    });

    const debug = runtime.getPredictionDebugState();
    expect(currentInput.clientTick).toBe(151);
    expect(debug.localClientTick).toBe(151);
    expect(debug.predictedClientTicks).toEqual([151]);
  });

  it('server ack for an immediate-send tick drops the matching predicted tick', () => {
    const { runtime } = createRuntime();
    const metrics = createMetrics();
    const currentInput = input(100);
    const initialTransform = transformFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: new THREE.Vector3(),
      serverTick: 100,
    });
    const initialTransformAck = ackFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: new THREE.Vector3(),
      serverTick: 100,
    });

    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: initialTransform,
      latestInputAck: initialTransformAck,
      metrics,
    });

    currentInput.left = true;
    currentInput.clientTick = 151;
    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: undefined,
      latestInputAck: undefined,
      metrics,
    });

    const predicted = runtime.getPredictionDebugState();
    const ackTransform = transformFromPosition({
      clientTick: 151,
      inputSeq: 101,
      movementState: predicted.movementState ?? initialMovementState(),
      position: predicted.localPosition,
      serverTick: 101,
    });
    const ackTransformAck = ackFromPosition({
      clientTick: 151,
      inputSeq: 101,
      movementState: predicted.movementState ?? initialMovementState(),
      position: predicted.localPosition,
      serverTick: 101,
    });

    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: ackTransform,
      latestInputAck: ackTransformAck,
      metrics,
    });

    const debug = runtime.getPredictionDebugState();
    expect(debug.localClientTick).toBe(151);
    expect(debug.predictedTickCount).toBe(0);
    expect(debug.predictedClientTicks).toEqual([]);
  });

  it('does not accumulate predicted ticks while dead for 30 seconds', () => {
    const { runtime } = createRuntime();
    const metrics = createMetrics();
    const currentInput = input(150, { right: true });
    const latestTransform = transformFromPosition({
      clientTick: 100,
      inputSeq: 120,
      movementState: initialMovementState(),
      position: new THREE.Vector3(3, 0, 4),
      serverTick: 100,
    });
    const latestInputAck = ackFromPosition({
      clientTick: 100,
      inputSeq: 120,
      movementState: initialMovementState(),
      position: new THREE.Vector3(3, 0, 4),
      serverTick: 100,
    });

    for (let frame = 0; frame < 600; frame += 1) {
      runtime.runFrame({
        currentInput,
        deltaSeconds: LOCAL_PREDICTION_TICK_DT,
        isDead: true,
        jumpAnimationDurationMs: 500,
        latestTransform,
        latestInputAck,
        metrics,
      });
    }

    const debug = runtime.getPredictionDebugState();
    expect(debug.predictedTickCount).toBe(0);
    expect(debug.predictedClientTicks).toEqual([]);
    expect(debug.accumulator).toBe(0);
    expect(debug.localClientTick).toBe(100);
    expect(currentInput.clientTick).toBe(100);
    expect(currentInput.sequence).toBe(150);
    expect(debug.localPosition.distanceTo(new THREE.Vector3(3, 0, 4))).toBeLessThan(0.000001);
  });

  it('dead players snap to authoritative transform without replaying pending predictions', () => {
    const { runtime } = createRuntime();
    const metrics = createMetrics();
    const currentInput = input(100);
    const initialTransform = transformFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: new THREE.Vector3(),
      serverTick: 100,
    });
    const initialTransformAck = ackFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: new THREE.Vector3(),
      serverTick: 100,
    });

    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: initialTransform,
      latestInputAck: initialTransformAck,
      metrics,
    });

    currentInput.right = true;
    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT * 3,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: undefined,
      latestInputAck: undefined,
      metrics,
    });
    expect(runtime.getPredictionDebugState().predictedTickCount).toBeGreaterThan(0);

    const deathTransform = transformFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: new THREE.Vector3(10, 0, -2),
      serverTick: 101,
    });
    const deathTransformAck = ackFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: new THREE.Vector3(10, 0, -2),
      serverTick: 101,
    });

    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT,
      isDead: true,
      jumpAnimationDurationMs: 500,
      latestTransform: deathTransform,
      latestInputAck: deathTransformAck,
      metrics,
    });

    const debug = runtime.getPredictionDebugState();
    expect(debug.predictedTickCount).toBe(0);
    expect(debug.accumulator).toBe(0);
    expect(debug.localPosition.distanceTo(new THREE.Vector3(10, 0, -2))).toBeLessThan(0.000001);
    expect(debug.renderPosition.distanceTo(new THREE.Vector3(10, 0, -2))).toBeLessThan(0.000001);
  });

  it('snap reset aligns stale input and local client ticks to the server ack', () => {
    const { runtime } = createRuntime();
    const metrics = createMetrics();
    const currentInput = input(100);
    const latestTransform = transformFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: new THREE.Vector3(),
      serverTick: 100,
    });
    const latestInputAck = ackFromPosition({
      clientTick: 100,
      inputSeq: 100,
      movementState: initialMovementState(),
      position: new THREE.Vector3(),
      serverTick: 100,
    });

    runtime.runFrame({
      currentInput,
      deltaSeconds: 0,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform,
      latestInputAck,
      metrics,
    });

    currentInput.clientTick = 999;
    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT * 10,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform,
      latestInputAck,
      metrics,
    });

    const debug = runtime.getPredictionDebugState();
    expect(currentInput.clientTick).toBe(100);
    expect(debug.localClientTick).toBe(100);
    expect(debug.predictedTickCount).toBe(0);
  });

  it('resumes prediction after respawn without a client tick jump', () => {
    const { runtime } = createRuntime();
    const metrics = createMetrics();
    const currentInput = input(175, { right: true });
    const deathTransform = transformFromPosition({
      clientTick: 100,
      inputSeq: 120,
      movementState: initialMovementState(),
      position: new THREE.Vector3(1, 0, 1),
      serverTick: 100,
    });
    const deathTransformAck = ackFromPosition({
      clientTick: 100,
      inputSeq: 120,
      movementState: initialMovementState(),
      position: new THREE.Vector3(1, 0, 1),
      serverTick: 100,
    });

    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT,
      isDead: true,
      jumpAnimationDurationMs: 500,
      latestTransform: deathTransform,
      latestInputAck: deathTransformAck,
      metrics,
    });

    runtime.runFrame({
      currentInput,
      deltaSeconds: LOCAL_PREDICTION_TICK_DT,
      isDead: false,
      jumpAnimationDurationMs: 500,
      latestTransform: undefined,
      latestInputAck: undefined,
      metrics,
    });

    const debug = runtime.getPredictionDebugState();
    expect(currentInput.clientTick).toBe(101);
    expect(debug.localClientTick).toBe(101);
    expect(debug.predictedClientTicks).toEqual([101]);
  });
});
