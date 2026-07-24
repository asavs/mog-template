import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { InputState } from './generated/types';
import { sampleHeight } from './heightmap';
import { STATIC_TERRAIN_BLOCKERS } from './terrainCollision';
import {
  PLAYER_COLLISION_RADIUS,
  PLAYER_SPEED,
  GRAVITY,
  JUMP_FORCE,
  applyJumpPhysics,
  applyMovement,
  createMovementState,
  resolvePlayerMovement,
  simulateMovementTick,
  sprintActiveForState,
} from './movement';

function defaultInput(): InputState {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    jump: false,
    sequence: 0,
    clientTick: 0,
  };
}

describe('movement collision prediction', () => {
  it('clamps predicted movement to the authoritative map bounds', () => {
    const position = new THREE.Vector3(1573, 10000, 0);
    const input = defaultInput();
    input.right = true;

    applyMovement(position, 0, input, 1);

    expect(position.x).toBeCloseTo(1574.03 - PLAYER_COLLISION_RADIUS);
  });

  it('preserves vertical motion while resolving horizontal bounds', () => {
    const current = new THREE.Vector3(1573, 10000, 0);
    const desired = new THREE.Vector3(10000, 4, 0);

    const resolved = resolvePlayerMovement(current, desired);

    expect(resolved.x).toBeCloseTo(1574.03 - PLAYER_COLLISION_RADIUS);
    expect(resolved.y).toBeCloseTo(4);
    expect(resolved.z).toBeCloseTo(0);
  });

  it('blocks predicted movement against the generated castle collider', () => {
    const [castle] = STATIC_TERRAIN_BLOCKERS;
    const current = new THREE.Vector3(
      castle.minX - PLAYER_COLLISION_RADIUS - 0.1,
      4,
      (castle.minZ + castle.maxZ) / 2,
    );
    const desired = new THREE.Vector3(castle.minX, 4, current.z);

    const resolved = resolvePlayerMovement(current, desired);

    expect(resolved.x).toBeCloseTo(current.x);
    expect(resolved.z).toBeCloseTo(current.z);
  });

  it('lands on sampled terrain height instead of flat zero', () => {
    const position = new THREE.Vector3(0, 0, 0);
    const result = applyJumpPhysics(position, defaultInput(), 1 / 20, 0, false);

    expect(position.y).toBeCloseTo(sampleHeight(0, 0));
    expect(result.verticalVelocity).toBe(0);
    expect(result.wasJumpPressed).toBe(false);
  });

  it('keeps grounded movement attached while walking downhill', () => {
    const startX = -1451.068125;
    const startZ = -1135.23375;
    const nextZ = -1125.613125;
    const position = new THREE.Vector3(startX, sampleHeight(startX, startZ), startZ);
    const input = defaultInput();
    input.backward = true;

    applyMovement(position, 0, input, (nextZ - startZ) / PLAYER_SPEED);

    expect(position.z).toBeGreaterThan(startZ);
    expect(position.y).toBeCloseTo(sampleHeight(position.x, position.z));
  });

  it('starts a moving jump from the resolved terrain height', () => {
    const startX = -1451.068125;
    const startZ = -1135.23375;
    const position = new THREE.Vector3(startX, sampleHeight(startX, startZ), startZ);
    const input = defaultInput();
    input.backward = true;
    input.jump = true;

    const result = simulateMovementTick(
      position,
      0,
      input,
      1 / 20,
      0,
      false,
      createMovementState(position, input),
    );

    expect(position.z).toBeGreaterThan(startZ);
    expect(position.y).toBeCloseTo(sampleHeight(position.x, position.z) + JUMP_FORCE * (1 / 20));
    expect(result.verticalVelocity).toBe(JUMP_FORCE);
    expect(result.movementState.isAirborne).toBe(true);
  });

  it('uses pre-move grounded state when jumping across a terrain drop', () => {
    const startX = -205.96875;
    const startZ = 126.28125;
    const position = new THREE.Vector3(startX, sampleHeight(startX, startZ), startZ);
    const input = defaultInput();
    input.left = true;
    input.jump = true;

    const result = simulateMovementTick(
      position,
      0,
      input,
      1 / 20,
      0,
      false,
      createMovementState(position, input),
    );

    expect(position.x).toBeLessThan(startX);
    expect(position.y).toBeGreaterThan(sampleHeight(position.x, position.z) + 0.5);
    expect(result.verticalVelocity).toBe(JUMP_FORCE);
    expect(result.movementState.wasGrounded).toBe(true);
    expect(result.movementState.isAirborne).toBe(true);
  });

  it('keeps jump tuning in a lower and faster target envelope', () => {
    const gravityMagnitude = Math.abs(GRAVITY);
    const apexMeters = (JUMP_FORCE * JUMP_FORCE) / (2 * gravityMagnitude);
    const totalAirtimeSeconds = (2 * JUMP_FORCE) / gravityMagnitude;

    expect(apexMeters).toBeGreaterThan(1.7);
    expect(apexMeters).toBeLessThan(1.9);
    expect(totalAirtimeSeconds).toBeGreaterThan(0.65);
    expect(totalAirtimeSeconds).toBeLessThan(0.75);
  });

  it('separates sprint intent from active sprint state', () => {
    const input = defaultInput();
    input.sprint = true;
    const idleState = createMovementState(new THREE.Vector3(0, sampleHeight(0, 0), 0), input);

    expect(idleState.sprintIntent).toBe(true);
    expect(idleState.sprintActive).toBe(false);

    input.forward = true;
    const movingState = createMovementState(
      new THREE.Vector3(0, sampleHeight(0, 0) + 1, 0),
      input,
      true,
      true,
    );

    expect(movingState.sprintIntent).toBe(true);
    expect(movingState.sprintActive).toBe(true);
    expect(movingState.wasGrounded).toBe(true);
    expect(movingState.isAirborne).toBe(true);
  });

  it('does not activate sprint from a midair sprint press', () => {
    const input = defaultInput();
    input.forward = true;
    input.sprint = true;
    const position = new THREE.Vector3(0, sampleHeight(0, 0) + 1, 0);
    const movementState = createMovementState(position, input, false, false);

    expect(sprintActiveForState(false, input, false)).toBe(false);
    expect(movementState.sprintIntent).toBe(true);
    expect(movementState.sprintActive).toBe(false);

    applyMovement(position, 0, input, 1 / 20, movementState.sprintActive);

    expect(position.z).toBeCloseTo(-PLAYER_SPEED * (1 / 20));
  });

  it('preserves active sprint after a midair sprint release until grounded', () => {
    const input = defaultInput();
    input.forward = true;
    input.sprint = false;

    expect(sprintActiveForState(false, input, true)).toBe(true);
    expect(sprintActiveForState(true, input, true)).toBe(false);
  });
});
