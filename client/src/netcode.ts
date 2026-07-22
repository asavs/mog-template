import * as THREE from 'three';
import type { MovementState, PlayerTransform } from './generated/types';

export const INTERPOLATION_DELAY_MS = 150;
export const MAX_EXTRAPOLATION_MS = 100;
export const SNAPSHOT_BUFFER_MS = 1000;
export const SERVER_TICK_RATE_HZ = 20;
export const RENDER_DELAY_TICKS = 3;
export const MAX_EXTRAPOLATION_TICKS = 2;
export const SNAPSHOT_BUFFER_TICKS = 20;
const MAX_RENDER_TICK_CORRECTION_PER_TICK = 0.1;

export interface TransformSnapshot {
  receivedAt: number;
  position: THREE.Vector3;
  rotationY: number;
  isMoving: boolean;
  movementState: MovementState;
  lastInputSeq: number;
  lastProcessedClientTick: number;
  serverTick: PlayerTransform['serverTick'];
}

export interface NetMetrics {
  fps: number;
  frameCount: number;
  lastFpsAt: number;
  inputSendCount: number;
  inputSendHz: number;
  transformReceiveCount: number;
  transformReceiveHz: number;
  lastRateAt: number;
  latestSnapshotAgeMs: number;
  avgBufferLength: number;
  localCorrectionError: number;
  pendingTickCount: number;
  predictedTickCount: number;
  tickAlignmentDrift: number;
  seqMismatchCount: number;
  acknowledgedInputSeq: number;
  acknowledgedClientTick: number;
  lastSentClientTick: number;
  latestServerTick: number;
  localTick: number;
  localClientTick: number;
  serverPredictedPositionDelta: number;
  visualCorrectionOffset: number;
}

export function createMetrics(): NetMetrics {
  const now = performance.now();
  return {
    fps: 0,
    frameCount: 0,
    lastFpsAt: now,
    inputSendCount: 0,
    inputSendHz: 0,
    transformReceiveCount: 0,
    transformReceiveHz: 0,
    lastRateAt: now,
    latestSnapshotAgeMs: 0,
    avgBufferLength: 0,
    localCorrectionError: 0,
    pendingTickCount: 0,
    predictedTickCount: 0,
    tickAlignmentDrift: 0,
    seqMismatchCount: 0,
    acknowledgedInputSeq: 0,
    acknowledgedClientTick: 0,
    lastSentClientTick: 0,
    latestServerTick: 0,
    localTick: 0,
    localClientTick: 0,
    serverPredictedPositionDelta: 0,
    visualCorrectionOffset: 0,
  };
}

export function toSnapshot(transform: PlayerTransform, receivedAt = performance.now()): TransformSnapshot {
  return {
    receivedAt,
    position: new THREE.Vector3(transform.position.x, transform.position.y, transform.position.z),
    rotationY: transform.rotationY,
    isMoving: transform.isMoving,
    movementState: { ...transform.movementState },
    // Pose channel no longer carries acks (#16); remotes interpolate pose only.
    lastInputSeq: 0,
    lastProcessedClientTick: 0,
    serverTick: transform.serverTick,
  };
}

export class RenderTickClock {
  renderTick = 0;
  latestKnownServerTick: number | null = null;

  observeServerTick(serverTick: PlayerTransform['serverTick']) {
    const tick = Number(serverTick);
    if (!Number.isFinite(tick)) return;
    // Initialize exactly once, on the first observed server tick. Gating on
    // `latestKnownServerTick === null` (rather than `renderTick === 0`) avoids
    // re-initializing when the first ticks are small (tick - RENDER_DELAY_TICKS
    // clamps to 0) or when advance() has already nudged renderTick off zero.
    if (this.latestKnownServerTick === null) {
      this.renderTick = Math.max(0, tick - RENDER_DELAY_TICKS);
    }
    this.latestKnownServerTick = Math.max(this.latestKnownServerTick ?? tick, tick);
  }

  advance(deltaSeconds: number): number {
    const tickDelta = Math.max(0, deltaSeconds) * SERVER_TICK_RATE_HZ;
    this.renderTick += tickDelta;

    if (this.latestKnownServerTick === null) {
      return this.renderTick;
    }

    const targetTick = this.latestKnownServerTick - RENDER_DELAY_TICKS;
    const error = targetTick - this.renderTick;
    const maxCorrection = tickDelta * MAX_RENDER_TICK_CORRECTION_PER_TICK;
    const correction = THREE.MathUtils.clamp(error, -maxCorrection, maxCorrection);
    this.renderTick += correction;
    return this.renderTick;
  }
}

export function pushSnapshot(
  buffers: Map<string, TransformSnapshot[]>,
  identityKey: string,
  snapshot: TransformSnapshot,
  renderTickClock?: RenderTickClock,
) {
  const buffer = buffers.get(identityKey) ?? [];
  renderTickClock?.observeServerTick(snapshot.serverTick);

  // Deduplicate by serverTick: a retransmission or a repeated tick would
  // otherwise accumulate and make interpolation across the buffer ambiguous.
  // The most recently received snapshot for a tick wins ("later" snapshot).
  const serverTick = Number(snapshot.serverTick);
  const existingIndex = buffer.findIndex((entry) => Number(entry.serverTick) === serverTick);
  if (existingIndex === -1) {
    buffer.push(snapshot);
    buffer.sort((a, b) => Number(a.serverTick) - Number(b.serverTick));
  } else {
    buffer[existingIndex] = snapshot;
  }

  const cutoff = Number(snapshot.serverTick) - SNAPSHOT_BUFFER_TICKS;
  while (buffer.length > 2 && Number(buffer[0].serverTick) < cutoff) {
    buffer.shift();
  }

  buffers.set(identityKey, buffer);
}

export function sampleBuffer(
  buffer: TransformSnapshot[] | undefined,
  renderTick: number,
): TransformSnapshot | null {
  if (!buffer || buffer.length === 0) return null;
  if (buffer.length === 1) return cloneSnapshot(buffer[0]);

  const earliestTick = Number(buffer[0].serverTick);
  if (renderTick <= earliestTick) {
    let earliestIndex = 0;
    while (
      earliestIndex + 1 < buffer.length &&
      Number(buffer[earliestIndex + 1].serverTick) === earliestTick
    ) {
      earliestIndex += 1;
    }
    return cloneSnapshot(buffer[earliestIndex]);
  }

  for (let index = 0; index < buffer.length - 1; index++) {
    const to = buffer[index + 1];
    const toTick = Number(to.serverTick);

    if (renderTick < toTick) {
      // `to` is the first snapshot strictly after renderTick, so buffer[index]
      // is the last snapshot at or before it. When ticks are duplicated, this
      // collapses them to the latest one, so the sampled value stays continuous
      // as renderTick crosses an integer tick boundary.
      const from = buffer[index];
      const fromTick = Number(from.serverTick);
      const span = toTick - fromTick;
      const alpha = span > 0 ? THREE.MathUtils.clamp((renderTick - fromTick) / span, 0, 1) : 1;
      return {
        receivedAt: to.receivedAt,
        position: from.position.clone().lerp(to.position, alpha),
        rotationY: lerpAngleValue(from.rotationY, to.rotationY, alpha),
        isMoving: to.isMoving,
        movementState: { ...to.movementState },
        lastInputSeq: to.lastInputSeq,
        lastProcessedClientTick: to.lastProcessedClientTick,
        serverTick: to.serverTick,
      };
    }
  }

  const latest = buffer[buffer.length - 1];
  const previous = buffer[buffer.length - 2];
  const latestTick = Number(latest.serverTick);
  const previousTick = Number(previous.serverTick);
  const extrapolateTicks = Math.min(renderTick - latestTick, MAX_EXTRAPOLATION_TICKS);

  if (!previous || extrapolateTicks <= 0 || latestTick <= previousTick) return cloneSnapshot(latest);

  const span = latestTick - previousTick;
  const velocity = latest.position.clone().sub(previous.position).multiplyScalar(1 / span);
  return {
    ...cloneSnapshot(latest),
    position: latest.position.clone().add(velocity.multiplyScalar(extrapolateTicks)),
  };
}

export function updateRates(metrics: NetMetrics, now = performance.now()) {
  const elapsed = now - metrics.lastRateAt;
  if (elapsed < 500) return;

  metrics.inputSendHz = metrics.inputSendCount / (elapsed / 1000);
  metrics.transformReceiveHz = metrics.transformReceiveCount / (elapsed / 1000);
  metrics.inputSendCount = 0;
  metrics.transformReceiveCount = 0;
  metrics.lastRateAt = now;
}

function cloneSnapshot(snapshot: TransformSnapshot): TransformSnapshot {
  return {
    ...snapshot,
    position: snapshot.position.clone(),
    movementState: { ...snapshot.movementState },
  };
}

function lerpAngleValue(from: number, to: number, alpha: number): number {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * alpha;
}
