import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  computeOrbitCamera,
  createFrameRuntimeState,
  predictTick,
  reconcileLocalPrediction,
  stepFrame,
  type PredictedTick,
  type StepFrameContext,
} from './frame';
import { createGameStore, type GameStore } from './sync';
import type { MovementInput } from './localSimFallback';

const STILL: MovementInput = { forward: false, backward: false, left: false, right: false, jump: false };
const WALK_FORWARD: MovementInput = { ...STILL, forward: true };

function tick(clientTick: number, overrides: Partial<PredictedTick> = {}): PredictedTick {
  const base: PredictedTick = {
    clientTick,
    input: WALK_FORWARD,
    rotationY: 0,
    movementFraction: 1,
    result: { position: { x: 0, y: 0, z: -clientTick * 0.25 }, verticalVelocity: 0, isGrounded: true },
  };
  return { ...base, ...overrides };
}

describe('predictTick', () => {
  it('advances position for held forward input and leaves it alone when idle', () => {
    const sim = { position: { x: 0, y: 0, z: 0 }, verticalVelocity: 0, isGrounded: true };
    const moved = predictTick(sim, WALK_FORWARD, 0, 1);
    expect(moved.position.z).toBeLessThan(0); // forward is -Z at yaw 0

    const stillSim = predictTick(sim, STILL, 0, 1);
    expect(stillSim.position).toEqual(sim.position);
  });

  it('scales distance by movementFraction (the action-gate value)', () => {
    const sim = { position: { x: 0, y: 0, z: 0 }, verticalVelocity: 0, isGrounded: true };
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

  it('carries vertical velocity/grounded state from the first remaining tick, not a hard reset', () => {
    const predicted = [tick(1, { result: { position: { x: 0, y: 1, z: 0 }, verticalVelocity: 6, isGrounded: false } })];
    const { sim } = reconcileLocalPrediction(predicted, { x: 0, y: 1, z: 0 }, 0);
    // After replaying the one remaining tick (which itself applies gravity), velocity has moved
    // on from 6 — the assertion that matters is that it did NOT reset to 0/grounded mid-air.
    expect(sim.isGrounded).toBe(false);
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
      ...overrides,
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
