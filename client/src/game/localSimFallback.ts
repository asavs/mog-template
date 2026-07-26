/**
 * Flat-ground-only stand-in for `simulateMovementTick` from `../sim/movement`
 * (agent M's module, landing in a parallel worktree — not present here yet).
 * No slopes, no collision geometry, no acceleration curve: just enough to
 * keep frame.ts's prediction/reconcile/camera loop exercising real code
 * while that module doesn't exist in this tree. `arena.json`'s bounds are
 * intentionally NOT read here — the real sim owns collision.
 *
 * The swap to the real module happens at the single import site in frame.ts
 * marked `// integration: wave2-movement`.
 */

export interface MovementInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
}

export interface MovementSimState {
  position: { x: number; y: number; z: number };
  verticalVelocity: number;
  isGrounded: boolean;
}

const MOVE_SPEED = 5; // m/s
const GRAVITY = -20; // m/s^2
const JUMP_VELOCITY = 7; // m/s
const GROUND_Y = 0;

export function createMovementSimState(position = { x: 0, y: GROUND_Y, z: 0 }): MovementSimState {
  return { position: { ...position }, verticalVelocity: 0, isGrounded: true };
}

/**
 * Advances one fixed tick. `rotationY` supplies facing so movement is
 * camera-relative (W always means "forward"); `movementFraction` is the
 * action-gate value from `actions/gates.ts` (0 = rooted, 1 = full speed).
 */
export function simulateMovementTickFallback(
  state: MovementSimState,
  input: MovementInput,
  rotationY: number,
  movementFraction: number,
  dtSeconds: number,
): MovementSimState {
  const axisX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const axisZ = (input.forward ? 1 : 0) - (input.backward ? 1 : 0);
  const length = Math.hypot(axisX, axisZ);
  const speed = MOVE_SPEED * movementFraction;

  let worldX = 0;
  let worldZ = 0;
  if (length > 0) {
    const sin = Math.sin(rotationY);
    const cos = Math.cos(rotationY);
    // Forward is -Z at rotationY=0 (matching game/frame.ts's computeOrbitCamera and
    // input/useInput.ts's aimVectorFor); right is +X. Rotating (axisX, -axisZ) by yaw:
    worldX = ((axisX * cos - axisZ * sin) / length) * speed;
    worldZ = ((-axisX * sin - axisZ * cos) / length) * speed;
  }

  let verticalVelocity = state.verticalVelocity;
  let isGrounded = state.isGrounded;
  let y = state.position.y;

  if (isGrounded && input.jump) {
    verticalVelocity = JUMP_VELOCITY;
    isGrounded = false;
  }
  verticalVelocity += GRAVITY * dtSeconds;
  y += verticalVelocity * dtSeconds;
  if (y <= GROUND_Y) {
    y = GROUND_Y;
    verticalVelocity = 0;
    isGrounded = true;
  }

  return {
    position: {
      x: state.position.x + worldX * dtSeconds,
      y,
      z: state.position.z + worldZ * dtSeconds,
    },
    verticalVelocity,
    isGrounded,
  };
}
