import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { MovementState } from './generated/types';
import {
  MAX_EXTRAPOLATION_TICKS,
  RENDER_DELAY_TICKS,
  pushSnapshot,
  RenderTickClock,
  sampleBuffer,
  SERVER_TICK_RATE_HZ,
  type TransformSnapshot,
} from './netcode';

function movementState(): MovementState {
  return {
    isGrounded: true,
    wasGrounded: true,
    isAirborne: false,
    sprintIntent: false,
    sprintActive: false,
  };
}

function snapshot(serverTick: number, receivedAt: number, x = serverTick): TransformSnapshot {
  return {
    receivedAt,
    position: new THREE.Vector3(x, 0, 0),
    rotationY: serverTick * 0.01,
    isMoving: true,
    movementState: movementState(),
    lastInputSeq: serverTick,
    lastProcessedClientTick: serverTick,
    serverTick: BigInt(serverTick),
  };
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function bufferFromDeliveredSnapshots(snapshots: TransformSnapshot[]) {
  const buffers = new Map<string, TransformSnapshot[]>();
  for (const delivered of snapshots) {
    pushSnapshot(buffers, 'remote-player', delivered);
  }
  return buffers.get('remote-player') ?? [];
}

function sampledPositions(buffer: TransformSnapshot[], renderTicks: number[]) {
  return renderTicks.map((renderTick) => {
    const sample = sampleBuffer(buffer, renderTick);
    expect(sample, `missing sample at tick ${renderTick}`).not.toBeNull();
    return sample!.position.x;
  });
}

describe('tick-based remote interpolation', () => {
  it('samples the same positions when exact 20 Hz ticks arrive with deterministic jitter', () => {
    const random = seededRandom(43);
    const tickCount = 20;
    const jittered = Array.from({ length: tickCount }, (_, tick) => {
      const idealArrivalMs = tick * (1000 / SERVER_TICK_RATE_HZ);
      const jitterMs = (random() - 0.5) * 80;
      return snapshot(tick, idealArrivalMs + jitterMs);
    }).sort((a, b) => a.receivedAt - b.receivedAt);
    const jitterFree = Array.from({ length: tickCount }, (_, tick) => (
      snapshot(tick, tick * (1000 / SERVER_TICK_RATE_HZ))
    ));

    const renderTicks = Array.from({ length: 39 }, (_, index) => index * 0.5);
    expect(sampledPositions(bufferFromDeliveredSnapshots(jittered), renderTicks)).toEqual(
      sampledPositions(bufferFromDeliveredSnapshots(jitterFree), renderTicks),
    );
  });

  it('caps extrapolation at two server ticks and then holds that projected position', () => {
    const buffer = [snapshot(10, 500, 10), snapshot(11, 550, 14)];

    expect(sampleBuffer(buffer, 12)!.position.x).toBe(18);
    expect(sampleBuffer(buffer, 13)!.position.x).toBe(22);
    expect(sampleBuffer(buffer, 20)!.position.x).toBe(14 + 4 * MAX_EXTRAPOLATION_TICKS);
  });

  it('uses the later snapshot when equal server ticks are sampled', () => {
    const buffer = [snapshot(5, 250, 1), snapshot(5, 260, 2), snapshot(6, 300, 4)];

    expect(sampleBuffer(buffer, 5)!.position.x).toBe(2);
    expect(sampleBuffer(buffer, 5.5)!.position.x).toBe(3);
  });

  it('stays continuous across a duplicated interior tick', () => {
    // Duplicate tick 6 (positions 4 then 5). Crossing the integer boundary must
    // not teleport: exactly at 6 and just past 6 should agree on the later dup.
    const buffer = [snapshot(5, 250, 0), snapshot(6, 260, 4), snapshot(6, 270, 5), snapshot(7, 300, 10)];

    expect(sampleBuffer(buffer, 6)!.position.x).toBe(5);
    expect(sampleBuffer(buffer, 6.0001)!.position.x).toBeCloseTo(5, 3);
  });

  it('deduplicates snapshots pushed with the same server tick', () => {
    const buffers = new Map<string, TransformSnapshot[]>();
    pushSnapshot(buffers, 'p', snapshot(6, 260, 4));
    pushSnapshot(buffers, 'p', snapshot(6, 270, 5));
    const buffer = buffers.get('p')!;

    expect(buffer).toHaveLength(1);
    expect(buffer[0].position.x).toBe(5);
  });

  it('converges toward latestTick minus render delay without overshoot oscillation', () => {
    const clock = new RenderTickClock();
    let latestTick = 100;
    clock.observeServerTick(BigInt(latestTick));
    clock.renderTick = 80;

    let previousError = Infinity;
    for (let frame = 0; frame < 220; frame += 1) {
      latestTick += 1;
      clock.observeServerTick(BigInt(latestTick));
      clock.advance(1 / SERVER_TICK_RATE_HZ);

      const targetTick = latestTick - RENDER_DELAY_TICKS;
      const error = targetTick - clock.renderTick;
      expect(error).toBeGreaterThanOrEqual(-0.000001);
      expect(error).toBeLessThanOrEqual(previousError + 0.000001);
      previousError = error;
    }

    expect(Math.abs(previousError)).toBeLessThan(0.000001);
  });
});
