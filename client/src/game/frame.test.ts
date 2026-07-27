import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { MovementState } from '../input/intents';
import { NetcodeMetrics } from '../perf/metrics';
import {
  computeOrbitCamera,
  createFrameRuntimeState,
  predictTick,
  reconcileLocalPrediction,
  stepFrame,
  type FrameRuntimeState,
  type PredictedTick,
  type StepFrameContext,
} from './frame';
import { createGameStore, type GameStore } from './sync';

const STILL: MovementState = { forward: false, backward: false, left: false, right: false, jump: false };
const WALK_FORWARD: MovementState = { ...STILL, forward: true };

function tick(clientTick: number, overrides: Partial<PredictedTick> = {}): PredictedTick {
  const base: PredictedTick = {
    clientTick,
    input: WALK_FORWARD,
    rotationY: 0,
    movementFraction: 1,
    result: {
      position: { x: 0, y: 0, z: -clientTick * 0.25 },
      rotationY: 0,
      verticalVelocity: 0,
      wasJumpPressed: false,
      sprintActive: false,
    },
  };
  return { ...base, ...overrides };
}

describe('predictTick', () => {
  it('advances position for held forward input and leaves it alone when idle', () => {
    const sim = { position: { x: 0, y: 0, z: 0 }, rotationY: 0, verticalVelocity: 0, wasJumpPressed: false, sprintActive: false };
    const moved = predictTick(sim, WALK_FORWARD, 0, 1);
    expect(moved.position.z).toBeLessThan(0); // forward is -Z at yaw 0

    const stillSim = predictTick(sim, STILL, 0, 1);
    expect(stillSim.position).toEqual(sim.position);
  });

  it('scales distance by movementFraction (the action-gate value)', () => {
    const sim = { position: { x: 0, y: 0, z: 0 }, rotationY: 0, verticalVelocity: 0, wasJumpPressed: false, sprintActive: false };
    const rooted = predictTick(sim, WALK_FORWARD, 0, 0);
    expect(rooted.position).toEqual(sim.position);

    const half = predictTick(sim, WALK_FORWARD, 0, 0.5);
    const full = predictTick(sim, WALK_FORWARD, 0, 1);
    expect(Math.abs(half.position.z)).toBeCloseTo(Math.abs(full.position.z) / 2, 5);
  });
});

describe('reconcileLocalPrediction', () => {
  it('drops every tick the server already processed', () => {
    const predicted = [tick(1), tick(2), tick(3)];
    const { remaining } = reconcileLocalPrediction(predicted, { x: 0, y: 0, z: -0.5 }, 2);
    expect(remaining.map(t => t.clientTick)).toEqual([3]);
  });

  it('snaps position to the server value and replays the remaining ticks forward from it', () => {
    const predicted = [tick(1), tick(2)];
    // Server disagrees with what tick 1 predicted — simulate a correction.
    const { sim, remaining } = reconcileLocalPrediction(predicted, { x: 10, y: 0, z: 0 }, 1);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].clientTick).toBe(2);
    // Replaying tick 2's forward-walk input from x=10 moves further in -Z, not back to the
    // originally-predicted position — reconcile discards the stale prediction entirely.
    expect(sim.position.x).toBe(10);
    expect(sim.position.z).toBeLessThan(0);
  });

  it('carries vertical velocity/rotation/sprint state from the first remaining tick, not a hard reset', () => {
    const predicted = [
      tick(1, {
        result: { position: { x: 0, y: 1, z: 0 }, rotationY: 0, verticalVelocity: 6, wasJumpPressed: true, sprintActive: false },
      }),
    ];
    const { sim } = reconcileLocalPrediction(predicted, { x: 0, y: 1, z: 0 }, 0);
    // After replaying the one remaining tick (which itself applies gravity), velocity has moved
    // on from 6 but the assertion that matters is that it did NOT reset to 0 mid-air: a hard
    // reset here would cancel an in-flight jump the moment the server acks an earlier tick.
    expect(sim.verticalVelocity).toBeGreaterThan(0);
    expect(sim.position.y).toBeGreaterThan(0);
  });

  it('is a no-op when nothing is pending', () => {
    const { sim, remaining } = reconcileLocalPrediction([], { x: 3, y: 0, z: 4 }, 0);
    expect(remaining).toEqual([]);
    expect(sim.position).toEqual({ x: 3, y: 0, z: 4 });
  });
});

describe('computeOrbitCamera', () => {
  it('sits behind the facing direction at yaw 0, looking toward +Z from a lifted lookAt', () => {
    const target = new THREE.Vector3(0, 0, 0);
    const { position, lookAt } = computeOrbitCamera(target, 0, 0, 5, 1.6);
    expect(lookAt).toEqual(new THREE.Vector3(0, 1.6, 0));
    // forward at yaw 0 is -Z, so the camera trails toward +Z.
    expect(position.z).toBeCloseTo(5, 5);
    expect(position.x).toBeCloseTo(0, 5);
    expect(position.y).toBeCloseTo(1.6, 5);
  });

  it('rotates around yaw and drops the camera when looking up (trails the facing direction)', () => {
    const target = new THREE.Vector3(0, 0, 0);
    const rotated = computeOrbitCamera(target, Math.PI / 2, 0, 5, 0);
    expect(rotated.position.x).toBeCloseTo(5, 5);
    expect(rotated.position.z).toBeCloseTo(0, 5);

    // Looking up tilts `forward` upward, so the camera — which sits opposite of
    // forward — swings below the level camera, the same way an over-the-shoulder
    // cam dips to keep the character in frame while the view tilts skyward.
    const level = computeOrbitCamera(target, 0, 0, 5, 0);
    const pitched = computeOrbitCamera(target, 0, Math.PI / 4, 5, 0);
    expect(pitched.position.y).toBeLessThan(level.position.y);
  });
});

describe('stepFrame', () => {
  function makeStore(): GameStore {
    return createGameStore();
  }

  function ctx(store: GameStore, overrides: Partial<StepFrameContext> = {}): StepFrameContext {
    return {
      dtSeconds: 1 / 20,
      store,
      localIdentityHex: 'local',
      movement: STILL,
      rotationY: 0,
      pitch: 0,
      movementFraction: 1,
      canRotate: true,
      ...overrides,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function rowAt(position: { x: number; y: number; z: number }, serverTick: bigint): any {
    return {
      identity: { toHexString: () => 'local' },
      position,
      rotationY: 0,
      isMoving: false,
      movementState: { isGrounded: true, wasGrounded: true, isAirborne: false, sprintIntent: false, sprintActive: false },
      serverTick,
      updatedAt: {},
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function ackAt(lastProcessedClientTick: number, serverTick: bigint): any {
    return {
      identity: { toHexString: () => 'local' },
      lastInputSeq: lastProcessedClientTick,
      lastProcessedClientTick,
      serverTick,
    };
  }

  it('initializes local position from the first player_transform row seen for the local identity', () => {
    const store = makeStore();
    store.playerTransform.set('local', {
      identity: { toHexString: () => 'local' },
      position: { x: 1, y: 0, z: 2 },
      rotationY: 0,
      isMoving: false,
      movementState: { isGrounded: true, wasGrounded: true, isAirborne: false, sprintIntent: false, sprintActive: false },
      serverTick: 0n,
      updatedAt: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const runtime = createFrameRuntimeState();
    const render = stepFrame(runtime, ctx(store));
    expect(render.localPosition.x).toBe(1);
    expect(render.localPosition.z).toBe(2);
  });

  it('predicts forward movement over several frames once initialized', () => {
    const store = makeStore();
    store.playerTransform.set('local', {
      identity: { toHexString: () => 'local' },
      position: { x: 0, y: 0, z: 0 },
      rotationY: 0,
      isMoving: false,
      movementState: { isGrounded: true, wasGrounded: true, isAirborne: false, sprintIntent: false, sprintActive: false },
      serverTick: 0n,
      updatedAt: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const runtime = createFrameRuntimeState();
    stepFrame(runtime, ctx(store)); // consumes the init frame
    let render = stepFrame(runtime, ctx(store, { movement: WALK_FORWARD }));
    for (let i = 0; i < 10; i += 1) {
      render = stepFrame(runtime, ctx(store, { movement: WALK_FORWARD }));
    }
    expect(render.localPosition.z).toBeLessThan(0);
    // sim/locomotion's FSM classified the tick as moving-on-ground — exposed for
    // presentation's motion.loco_* key selection (game/App.tsx).
    expect(render.localLocomotionPhase).toBe('grounded_walk');
  });

  it('exposes grounded_idle when there is no movement input', () => {
    const store = makeStore();
    store.playerTransform.set('local', {
      identity: { toHexString: () => 'local' },
      position: { x: 0, y: 0, z: 0 },
      rotationY: 0,
      isMoving: false,
      movementState: { isGrounded: true, wasGrounded: true, isAirborne: false, sprintIntent: false, sprintActive: false },
      serverTick: 0n,
      updatedAt: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const runtime = createFrameRuntimeState();
    stepFrame(runtime, ctx(store));
    const render = stepFrame(runtime, ctx(store));
    expect(render.localLocomotionPhase).toBe('grounded_idle');
  });

  it('reconciles a server-side position change even with no fresh input ack (e.g. roll\'s displace_self)', () => {
    // Not every authoritative position change is input-driven — roll's `displace_self` effect
    // moves the actor server-side without ever touching `update_player_input`, so no
    // `player_input_ack` accompanies it. Reconciliation must still pick it up from the
    // `player_transform` row itself (gated on `serverTick`, not on the ack) or a roll would
    // fire successfully server-side and the local render would never show it moving.
    const store = makeStore();
    store.playerTransform.set('local', rowAt({ x: 0, y: 0, z: 0 }, 0n));
    const runtime = createFrameRuntimeState();
    stepFrame(runtime, ctx(store)); // consumes the init frame — no movement held

    // The server displaces the player 4 units in -Z (roll's distance) with no accompanying ack.
    store.playerTransform.set('local', rowAt({ x: 0, y: 0, z: -4 }, 1n));
    const render = stepFrame(runtime, ctx(store));

    expect(render.localPosition.z).toBeCloseTo(-4, 5);

    // No lingering glide: roll's displacement is bigger than VISUAL_CORRECTION_SNAP_METERS, so it
    // applies instantly (offset cleared to zero) rather than gliding — the NEXT frame (no further
    // store change) stays exactly at -4 instead of sliding back toward the pre-roll position.
    const next = stepFrame(runtime, ctx(store));
    expect(next.localPosition.z).toBeCloseTo(-4, 5);
  });

  it('spreads a genuine reconciliation correction across several frames instead of snapping in one (the #216 teleport fix)', () => {
    // Simulates the state right after a reconcile landed a small, real correction (the kind real
    // network latency produces — not a huge displacement like roll): the physics position
    // (`runtime.local`) has already moved to the corrected spot, but the render is still one
    // frame's worth of lag behind it via `visualCorrectionOffset`. Constructed directly rather
    // than driven through a live reconcile so the test isolates the decay behavior itself.
    const store = makeStore();
    store.playerTransform.set('local', rowAt({ x: 0, y: 0, z: 0 }, 5n));
    const runtime: FrameRuntimeState = createFrameRuntimeState();
    runtime.initializedFromServer = true;
    runtime.lastServerTick = 5n; // matches the store row — reconcileFromStore will no-op below
    runtime.local = { position: { x: 0, y: 0, z: -1 }, rotationY: 0, verticalVelocity: 0, wasJumpPressed: false, sprintActive: false };
    runtime.visualCorrectionOffset = { x: 0, y: 0, z: 1 }; // render started 1 unit behind physics

    const zSamples: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      zSamples.push(stepFrame(runtime, ctx(store)).localPosition.z);
    }

    // The very first frame after the correction does NOT already sit on the corrected physics
    // position (-1) — the old, unsmoothed code would render -1 immediately. It's still between
    // the old render spot (0) and the corrected one (-1).
    expect(zSamples[0]).toBeGreaterThan(-1);
    expect(zSamples[0]).toBeLessThan(0);

    // Monotonic convergence — never overshoots or oscillates away from the physics position.
    for (let i = 1; i < zSamples.length; i += 1) {
      expect(zSamples[i]).toBeLessThanOrEqual(zSamples[i - 1] + 1e-9);
    }
    // Fully settled well within the 1.5s this loop covers.
    expect(zSamples[zSamples.length - 1]).toBeCloseTo(-1, 2);
  });

  it('does not drift or teleport across a movement->idle boundary when the input ack lags several ticks behind (historical #176/#177 signature)', () => {
    const store = makeStore();
    store.playerTransform.set('local', rowAt({ x: 0, y: 0, z: 0 }, 0n));
    const runtime = createFrameRuntimeState();
    stepFrame(runtime, ctx(store)); // init frame — tick 1 predicted, STILL

    // Walk forward for 10 ticks, then release to idle — no ack has arrived for ANY of this yet
    // (real latency: the ack is still in flight).
    let render = stepFrame(runtime, ctx(store, { movement: WALK_FORWARD }));
    for (let i = 0; i < 9; i += 1) {
      render = stepFrame(runtime, ctx(store, { movement: WALK_FORWARD }));
    }
    const zAfterWalking = render.localPosition.z;
    expect(zAfterWalking).toBeLessThan(0);

    for (let i = 0; i < 5; i += 1) {
      render = stepFrame(runtime, ctx(store));
    }
    const zAfterStopping = render.localPosition.z;
    expect(zAfterStopping).toBeCloseTo(zAfterWalking, 5); // genuinely idle: no further drift

    // The ack finally lands, but only acknowledges the first 3 of the 10 walking ticks — the
    // server was several ticks behind the client the whole time, exactly the lagged-ack shape
    // real latency produces. The transform row carries the SAME deterministic replay result a
    // correct client would compute for those 3 ticks, so a correct reconcile is a near-no-op.
    let serverSim = { position: { x: 0, y: 0, z: 0 }, rotationY: 0, verticalVelocity: 0, wasJumpPressed: false, sprintActive: false };
    for (let i = 0; i < 3; i += 1) serverSim = predictTick(serverSim, WALK_FORWARD, 0, 1);
    store.playerInputAck.set('local', ackAt(3, 1n));
    store.playerTransform.set('local', rowAt(serverSim.position, 1n));

    const reconciled = stepFrame(runtime, ctx(store));
    // Crossing the movement->idle boundary with a lagging ack must not register as a large
    // correction: the #176/#177 bug (slicing predicted ticks by raw tick-count/delta rather than
    // by the acked clientTick) discarded unacked movement ticks here and produced drift/teleport.
    expect(Math.abs(reconciled.localPosition.z - zAfterStopping)).toBeLessThan(0.3);
  });

  it('freezes character yaw and predicted movement direction while canRotate is false, but leaves the camera free', () => {
    const store = makeStore();
    store.playerTransform.set('local', {
      identity: { toHexString: () => 'local' },
      position: { x: 0, y: 0, z: 0 },
      rotationY: 0,
      isMoving: false,
      movementState: { isGrounded: true, wasGrounded: true, isAirborne: false, sprintIntent: false, sprintActive: false },
      serverTick: 0n,
      updatedAt: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const runtime = createFrameRuntimeState();
    stepFrame(runtime, ctx(store)); // consumes the init frame, yaw still 0

    // Mouse-look turns the camera to +90deg while walking forward under a canRotate:false gate
    // (e.g. mid-windup on a rooted-facing action like nova).
    const frozen = stepFrame(
      runtime,
      ctx(store, { movement: WALK_FORWARD, rotationY: Math.PI / 2, canRotate: false }),
    );
    // Character facing stays pinned at the pre-freeze yaw — not the live camera yaw.
    expect(frozen.localRotationY).toBeCloseTo(0, 5);
    // Movement direction is governed by the SAME frozen yaw: forward at yaw 0 is -Z, so the
    // player keeps walking -Z rather than swinging toward -X the way a yaw-PI/2 forward would.
    expect(frozen.localPosition.z).toBeLessThan(0);
    expect(frozen.localPosition.x).toBeCloseTo(0, 5);
    // Camera orbit still tracks the live rotationY input untouched by the gate.
    const expectedCamera = computeOrbitCamera(frozen.localPosition, Math.PI / 2, 0);
    expect(frozen.camera.position.x).toBeCloseTo(expectedCamera.position.x, 5);
    expect(frozen.camera.position.z).toBeCloseTo(expectedCamera.position.z, 5);

    // Once canRotate returns (e.g. Recovery ends), the character catches back up to the live
    // camera yaw on the very next predicted tick — no lingering desync.
    const resumed = stepFrame(
      runtime,
      ctx(store, { movement: WALK_FORWARD, rotationY: Math.PI / 2, canRotate: true }),
    );
    expect(resumed.localRotationY).toBeCloseTo(Math.PI / 2, 5);
  });

  it('never renders the local identity as a remote', () => {
    const store = makeStore();
    store.playerTransform.set('local', {
      identity: { toHexString: () => 'local' },
      position: { x: 0, y: 0, z: 0 },
      rotationY: 0,
      isMoving: false,
      movementState: { isGrounded: true, wasGrounded: true, isAirborne: false, sprintIntent: false, sprintActive: false },
      serverTick: 0n,
      updatedAt: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const runtime = createFrameRuntimeState();
    const render = stepFrame(runtime, ctx(store));
    expect(render.remotes.has('local')).toBe(false);
  });
});

/**
 * Instrumentation is additive by contract: `stepFrame` records netcode-feel channels but no
 * branch, ordering, or value in the reconcile path may depend on them. The reconcile behavior
 * itself is guarded by the `stepFrame`/`reconcileLocalPrediction` suites above — these tests
 * assert the channels observe what actually happened.
 */
describe('stepFrame netcode instrumentation', () => {
  function ctx(store: GameStore, overrides: Partial<StepFrameContext> = {}): StepFrameContext {
    return {
      dtSeconds: 1 / 20,
      store,
      localIdentityHex: 'local',
      movement: STILL,
      rotationY: 0,
      pitch: 0,
      movementFraction: 1,
      canRotate: true,
      ...overrides,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function transformRow(position: { x: number; y: number; z: number }, serverTick: bigint): any {
    return {
      identity: { toHexString: () => 'local' },
      position,
      rotationY: 0,
      isMoving: false,
      movementState: { isGrounded: true, wasGrounded: true, isAirborne: false, sprintIntent: false, sprintActive: false },
      serverTick,
      updatedAt: {},
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function ackRow(lastInputSeq: number, lastProcessedClientTick: number): any {
    return {
      identity: { toHexString: () => 'local' },
      lastInputSeq,
      lastProcessedClientTick,
      serverTick: 0n,
    };
  }

  /** A runtime wired to a metrics instance whose clock this test drives by hand. */
  function harness() {
    const clock = { now: 0 };
    const metrics = new NetcodeMetrics({ now: () => clock.now });
    return { clock, metrics, runtime: createFrameRuntimeState(metrics), store: createGameStore() };
  }

  it('records the first authoritative row as an arrival baseline, with nothing to reconcile yet', () => {
    const { clock, metrics, runtime, store } = harness();
    store.playerTransform.set('local', transformRow({ x: 0, y: 0, z: 0 }, 0n));

    clock.now = 1000;
    stepFrame(runtime, ctx(store));

    const snapshot = metrics.refreshSnapshot(1000);
    expect(snapshot.transformArrivalCount).toBe(1);
    // One arrival is not an interval, and initialization is not a correction.
    expect(snapshot.tickIntervalMsLast).toBe(0);
    expect(snapshot.reconcileCount).toBe(0);
  });

  it('measures the pre-smoothing correction magnitude, not the smoothed render delta', () => {
    const { clock, metrics, runtime, store } = harness();
    store.playerTransform.set('local', transformRow({ x: 0, y: 0, z: 0 }, 0n));
    clock.now = 1000;
    stepFrame(runtime, ctx(store));

    // Predict forward a few ticks so the client has drifted from the server's last word.
    for (let index = 0; index < 4; index += 1) {
      clock.now += 50;
      stepFrame(runtime, ctx(store, { movement: WALK_FORWARD }));
    }
    const predictedPosition = { ...runtime.local.position };

    // The server disagrees hard: it puts us 5 units away on X. Acking well past every predicted
    // tick leaves nothing to replay, so the reconciled position IS the server position — which
    // makes the expected correction exactly computable rather than approximated.
    const serverPosition = { x: 5, y: 0, z: 0 };
    store.playerTransform.set('local', transformRow(serverPosition, 1n));
    store.playerInputAck.set('local', ackRow(4, 999));
    clock.now += 50;
    stepFrame(runtime, ctx(store, { movement: WALK_FORWARD }));

    const snapshot = metrics.refreshSnapshot(clock.now);
    expect(snapshot.reconcileCount).toBe(1);
    expect(snapshot.correctionMagnitudeLast).toBeCloseTo(
      Math.hypot(
        serverPosition.x - predictedPosition.x,
        serverPosition.y - predictedPosition.y,
        serverPosition.z - predictedPosition.z,
      ),
      6,
    );
    expect(snapshot.correctionMagnitudeLast).toBeGreaterThan(4);

    // It is measured at the reconcile, BEFORE the same frame predicts forward again — reading
    // it off the post-frame position would fold in an extra tick of movement.
    expect(snapshot.correctionMagnitudeLast).not.toBeCloseTo(
      Math.hypot(
        runtime.local.position.x - predictedPosition.x,
        runtime.local.position.y - predictedPosition.y,
        runtime.local.position.z - predictedPosition.z,
      ),
      6,
    );
  });

  it('records an arrival interval only when the authoritative row actually changed', () => {
    const { clock, metrics, runtime, store } = harness();
    store.playerTransform.set('local', transformRow({ x: 0, y: 0, z: 0 }, 0n));
    clock.now = 1000;
    stepFrame(runtime, ctx(store));

    // Same serverTick on later frames: the row was not republished, so nothing arrived.
    for (let index = 0; index < 5; index += 1) {
      clock.now += 50;
      stepFrame(runtime, ctx(store));
    }
    expect(metrics.refreshSnapshot(clock.now).transformArrivalCount).toBe(1);

    // A changed row IS an arrival, and the interval spans from the previous one.
    store.playerTransform.set('local', transformRow({ x: 0, y: 0, z: -1 }, 1n));
    clock.now += 50;
    stepFrame(runtime, ctx(store));

    const snapshot = metrics.refreshSnapshot(clock.now);
    expect(snapshot.transformArrivalCount).toBe(2);
    expect(snapshot.tickIntervalMsLast).toBe(300);
  });

  it('closes the input round trip when the ack for a sent sequence arrives', () => {
    const { clock, metrics, runtime, store } = harness();
    store.playerTransform.set('local', transformRow({ x: 0, y: 0, z: 0 }, 0n));
    clock.now = 1000;
    stepFrame(runtime, ctx(store));

    // What `useInput`'s onInputSent does at the moment the reducer call goes out.
    metrics.recordInputSent(7, 1000);

    store.playerTransform.set('local', transformRow({ x: 0, y: 0, z: -1 }, 1n));
    store.playerInputAck.set('local', ackRow(7, 1));
    clock.now = 1075;
    stepFrame(runtime, ctx(store));

    const snapshot = metrics.refreshSnapshot(clock.now);
    expect(snapshot.ackSampleCount).toBe(1);
    expect(snapshot.ackRttMsLast).toBe(75);
  });

  it('publishes the smoothing offset still being hidden from the player', () => {
    const { clock, metrics, runtime, store } = harness();
    store.playerTransform.set('local', transformRow({ x: 0, y: 0, z: 0 }, 0n));
    clock.now = 1000;
    stepFrame(runtime, ctx(store));

    for (let index = 0; index < 4; index += 1) {
      clock.now += 50;
      stepFrame(runtime, ctx(store, { movement: WALK_FORWARD }));
    }
    // A correction under the snap threshold glides, so some of it is still being hidden.
    store.playerTransform.set('local', transformRow({ x: 0.5, y: 0, z: -0.5 }, 1n));
    store.playerInputAck.set('local', ackRow(4, 4));
    clock.now += 50;
    const render = stepFrame(runtime, ctx(store, { movement: WALK_FORWARD }));

    const snapshot = metrics.refreshSnapshot(clock.now);
    expect(snapshot.visualCorrectionOffsetLength).toBeGreaterThan(0);
    // And the offset it reports is the one actually applied to the rendered position.
    expect(render.localPosition.x).toBeCloseTo(
      runtime.local.position.x + runtime.visualCorrectionOffset.x,
      6,
    );
  });

  it('records a frame-time sample every frame, so fps reflects the render loop', () => {
    const { clock, metrics, runtime, store } = harness();
    store.playerTransform.set('local', transformRow({ x: 0, y: 0, z: 0 }, 0n));

    for (let index = 0; index < 30; index += 1) {
      clock.now += 1000 / 60;
      stepFrame(runtime, ctx(store, { dtSeconds: 1 / 60 }));
    }

    const snapshot = metrics.refreshSnapshot(clock.now);
    expect(snapshot.fps).toBeCloseTo(60, 0);
  });
});
