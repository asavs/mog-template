import { describe, expect, it } from 'vitest';
import { deriveGates, Phase } from '../actions/gates';
import type { InputState } from '../generated/types';
import { createArenaGround } from './ground';
import {
  DELTA_TIME,
  GRAVITY,
  JUMP_FORCE,
  PLAYER_SPEED,
  SPRINT_MULTIPLIER,
} from './locomotion';
import {
  simulateMovementTick,
  type PlayerSimState,
} from './movement';

function input(fields: Partial<InputState> = {}): InputState {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    jump: false,
    sequence: 0,
    clientTick: 0,
    ...fields,
  };
}

function state(fields: Partial<PlayerSimState> = {}): PlayerSimState {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotationY: 0,
    verticalVelocity: 0,
    wasJumpPressed: false,
    sprintActive: false,
    ...fields,
  };
}

describe('authoritative movement tick parity', () => {
  const ground = createArenaGround();

  it('does not move while idle', () => {
    const current = state();
    const next = simulateMovementTick(
      current,
      input(),
      0,
      ground,
      DELTA_TIME,
    );

    expect(next.position).toEqual(current.position);
  });

  it('moves forward along negative Z', () => {
    const next = simulateMovementTick(
      state(),
      input({ forward: true }),
      0,
      ground,
      DELTA_TIME,
    );

    expect(next.position.x).toBeCloseTo(0, 4);
    expect(next.position.z).toBeCloseTo(-PLAYER_SPEED * DELTA_TIME, 4);
  });

  it('normalizes diagonal movement', () => {
    const next = simulateMovementTick(
      state(),
      input({ forward: true, right: true }),
      0,
      ground,
      DELTA_TIME,
    );
    const distance = Math.sqrt(
      next.position.x * next.position.x
        + next.position.z * next.position.z,
    );

    expect(distance).toBeCloseTo(PLAYER_SPEED * DELTA_TIME, 4);
  });

  it('uses the sprint multiplier', () => {
    const next = simulateMovementTick(
      state(),
      input({ forward: true, sprint: true }),
      0,
      ground,
      DELTA_TIME,
    );

    expect(next.position.z).toBeCloseTo(
      -(PLAYER_SPEED * SPRINT_MULTIPLIER * DELTA_TIME),
      4,
    );
    expect(next.sprintActive).toBe(true);
  });

  it('changes movement direction with rotation', () => {
    const next = simulateMovementTick(
      state(),
      input({ forward: true }),
      Math.PI / 2,
      ground,
      DELTA_TIME,
    );

    expect(next.position.x).toBeCloseTo(-PLAYER_SPEED * DELTA_TIME, 4);
    expect(next.position.z).toBeCloseTo(0, 4);
  });

  it('moves upward on the first jump tick', () => {
    const next = simulateMovementTick(
      state(),
      input({ jump: true }),
      0,
      ground,
      DELTA_TIME,
    );

    expect(next.position.y).toBeCloseTo(JUMP_FORCE * DELTA_TIME, 4);
    expect(next.verticalVelocity).toBe(JUMP_FORCE);
  });

  it('keeps jump tuning in the lower, faster target envelope', () => {
    const gravityMagnitude = Math.abs(GRAVITY);
    const apexMeters = (JUMP_FORCE * JUMP_FORCE) / (2 * gravityMagnitude);
    const totalAirtime = (2 * JUMP_FORCE) / gravityMagnitude;

    expect(apexMeters).toBeGreaterThan(1.7);
    expect(apexMeters).toBeLessThan(1.9);
    expect(totalAirtime).toBeGreaterThan(0.65);
    expect(totalAirtime).toBeLessThan(0.75);
  });

  it('converges at the north and south wall edges over repeated ticks', () => {
    let north = state();
    let south = state();
    for (let tick = 0; tick < 100; tick += 1) {
      north = simulateMovementTick(
        north,
        input({ forward: true }),
        0,
        ground,
        DELTA_TIME,
      );
      south = simulateMovementTick(
        south,
        input({ backward: true }),
        0,
        ground,
        DELTA_TIME,
      );
    }

    expect(north.position.z).toBeCloseTo(-19.55, 4);
    expect(south.position.z).toBeCloseTo(19.55, 4);
  });

  it('deflects around a pillar without entering its collision radius', () => {
    let current = state({
      position: { x: -10.5, y: 0, z: -8.3 },
    });

    for (let tick = 0; tick < 20; tick += 1) {
      current = simulateMovementTick(
        current,
        input({ forward: true }),
        0,
        ground,
        DELTA_TIME,
      );
      const dx = current.position.x + 10;
      const dz = current.position.z + 10;
      expect(Math.sqrt(dx * dx + dz * dz)).toBeGreaterThanOrEqual(1.3499);
    }

    expect(current.position.x).toBeLessThan(-10.5);
    expect(current.position.z).toBeLessThan(-10);
  });

  it('roots the player during windup for a def whose movement.windup is 0 (attack_heavy) — parity with server player_logic::tests', () => {
    // Mirrors server/spacetimedb/src/player_logic.rs's
    // `movement_fraction_zero_roots_the_player_like_attack_heavys_windup`: both sides derive
    // the SAME fraction from the same def (docs/action-pipeline.md's "movement" field) and
    // must root movement identically, or client prediction would diverge from a server
    // correction the instant an action like this starts.
    const gates = deriveGates('attack_heavy', Phase.Windup);
    expect(gates.movementFraction).toBe(0);

    const next = simulateMovementTick(
      state(),
      input({ forward: true }),
      0,
      ground,
      DELTA_TIME,
      gates.movementFraction,
    );

    expect(next.position).toEqual(state().position);
  });

  it('does not activate sprint from a midair press', () => {
    const next = simulateMovementTick(
      state({ position: { x: 0, y: 1, z: 0 } }),
      input({ forward: true, sprint: true }),
      0,
      ground,
      DELTA_TIME,
    );

    expect(next.sprintActive).toBe(false);
    expect(next.position.z).toBeCloseTo(-PLAYER_SPEED * DELTA_TIME, 4);
  });
});
