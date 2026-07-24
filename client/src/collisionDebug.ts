import type * as THREE from 'three';
import type { InputState, MovementState } from './generated/types';
import { shouldEnableQaGameDebug } from './qaGate';

const COLLISION_DEBUG_RING_SIZE = 600;
let cachedQaDebugEnabled: boolean | null = null;

export type CollisionDebugVec3 = {
  x: number;
  y: number;
  z: number;
};

type CollisionDebugNumber = number | null;

export type CollisionDebugEntry = {
  at: number;
  phase: string;
  input?: Partial<InputState>;
  current?: CollisionDebugVec3;
  desired?: CollisionDebugVec3;
  position?: CollisionDebugVec3;
  resolved?: CollisionDebugVec3;
  serverPosition?: CollisionDebugVec3;
  movementDelta?: CollisionDebugVec3;
  correctionDelta?: CollisionDebugVec3;
  groundNormal?: CollisionDebugVec3 | null;
  movementState?: MovementState | null;
  terrainY?: CollisionDebugNumber;
  groundY?: CollisionDebugNumber;
  castleSupportY?: CollisionDebugNumber;
  castleSupportSource?: string;
  collisionSolver?: string;
  collisionMoved?: CollisionDebugNumber;
  desiredDistance?: CollisionDebugNumber;
  resolvedDistance?: CollisionDebugNumber;
  blockedDistance?: CollisionDebugNumber;
  verticalVelocityBefore?: CollisionDebugNumber;
  verticalVelocityAfter?: CollisionDebugNumber;
  jumpWasPressedBefore?: boolean;
  jumpWasPressedAfter?: boolean;
  wasGrounded?: boolean;
  isStartingJump?: boolean;
  hitCeiling?: boolean;
  hitWall?: boolean;
  grounded?: boolean;
  localClientTick?: CollisionDebugNumber;
  localTick?: CollisionDebugNumber;
  acknowledgedClientTick?: CollisionDebugNumber;
  lastReconciledClientTick?: CollisionDebugNumber;
  latestServerTick?: CollisionDebugNumber;
  pendingTickCount?: CollisionDebugNumber;
  reconciliationError?: CollisionDebugNumber;
  visualCorrectionOffset?: CollisionDebugVec3;
  note?: string;
};

declare global {
  interface Window {
    __collisionDebugConsole?: boolean;
    __collisionDebugEnabled?: boolean;
    __collisionDebugCopy?: () => string;
    __collisionDebugDump?: () => CollisionDebugEntry[];
    __collisionDebugLog?: CollisionDebugEntry[];
  }
}

export function collisionDebugEnabled() {
  if (typeof window === 'undefined') return false;
  if (window.__collisionDebugEnabled === false) return false;
  if (window.__collisionDebugEnabled === true) return true;
  if (cachedQaDebugEnabled === null) {
    cachedQaDebugEnabled = shouldEnableQaGameDebug();
  }
  return cachedQaDebugEnabled;
}

if (typeof window !== 'undefined') {
  window.__collisionDebugDump = () => [...(window.__collisionDebugLog ?? [])];
  window.__collisionDebugCopy = () => JSON.stringify(window.__collisionDebugLog ?? [], null, 2);
}

function round(value: number) {
  return Number(value.toFixed(4));
}

export function collisionVectorDebug(position: THREE.Vector3): CollisionDebugVec3 {
  return {
    x: round(position.x),
    y: round(position.y),
    z: round(position.z),
  };
}

export function collisionInputDebug(input: InputState): Partial<InputState> {
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

export function collisionNumberDebug(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? round(value as number) : null;
}

export function logCollisionDebug(entry: CollisionDebugEntry) {
  if (!collisionDebugEnabled()) return false;

  const normalized: CollisionDebugEntry = {
    ...entry,
    at: round(entry.at),
  };
  const log = window.__collisionDebugLog ?? [];
  log.push(normalized);
  if (log.length > COLLISION_DEBUG_RING_SIZE) {
    log.splice(0, log.length - COLLISION_DEBUG_RING_SIZE);
  }
  window.__collisionDebugLog = log;

  if (window.__collisionDebugConsole !== false) {
    console.log(`[CollisionDebug] ${JSON.stringify(normalized)}`);
  }
  return true;
}
