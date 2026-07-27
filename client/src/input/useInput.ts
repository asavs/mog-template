/**
 * The thin React shell: DOM listeners in, `intents.ts` reducers through, two
 * reducer calls out. This is the only place in the client allowed to touch
 * keyboard/mouse DOM events for gameplay — everything else (gates, camera,
 * HUD) consumes what this hook already resolved.
 *
 * Two independent cadences drive `update_player_input`, matching the salvaged
 * v1 pattern (`git show 9f9fc5c:client/src/hooks/usePlayerActions.ts`):
 *  - event-driven: the instant the movement/jump vector changes, send it.
 *  - heartbeat: every tick period (50ms @ 20Hz) while any movement/jump axis
 *    is held, resend — so mouse-look rotation and packet loss don't leave the
 *    server holding a stale vector. Pure idle never resends.
 *
 * `action_input` sends on every physical edge (never batched, never gated by
 * the client-side hold-threshold mirror — see intents.ts's module doc).
 *
 * Note what those two cadences mean for `InputState.clientTick`: sends are NOT
 * evenly spaced in time — a burst of direction changes fires several in a single
 * tick period. So a counter incremented per send cannot double as a tick number.
 * `clientTick` therefore comes from the predictor (`clientTickRef`, see
 * `UseInputOptions`), and only `sequence` counts messages.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { SLOT_BINDINGS } from '../actions/defs.generated';
import type { DbConnection } from '../generated';
import { InputEdge, type InputState, type Vector3 } from '../generated/types';
import {
  createIntentState,
  createMovementState,
  handleKeyDown,
  handleKeyUp,
  handleMouseDown,
  handleMouseUp,
  holdTicksFor,
  setPointerLocked,
  type EditableTargetLike,
  type IntentResult,
  type IntentState,
  type MovementState,
} from './intents';
import { BOUND_KEY_CODES } from './keymap';

/** Matches ACTIONS_TICK_RATE (client/src/actions/defs.generated.ts) — the wire tick period. */
const TICK_PERIOD_MS = 50;
const CAMERA_YAW_SENSITIVITY = 0.0025;
const CAMERA_PITCH_SENSITIVITY = 0.0025;
const MIN_PITCH = -1.3;
const MAX_PITCH = 1.3;

/** Only hold-capable slots (SLOT_BINDINGS.holdAction !== null) have a threshold worth mirroring. */
const HOLD_THRESHOLD_TICKS_BY_SLOT: ReadonlyMap<string, number> = new Map(
  SLOT_BINDINGS.filter(binding => binding.holdAction !== null).map(binding => [
    binding.slot,
    binding.holdThresholdTicks,
  ]),
);

function isHeld(movement: MovementState): boolean {
  return movement.forward || movement.backward || movement.left || movement.right || movement.jump;
}

function aimVectorFor(rotationY: number, pitch: number): Vector3 {
  const cosPitch = Math.cos(pitch);
  return {
    x: -Math.sin(rotationY) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(rotationY) * cosPitch,
  };
}

export interface UseInputOptions {
  connRef: MutableRefObject<DbConnection | null>;
  /** Gates every reducer call — false while not joined, or while dead. */
  active: boolean;
  /**
   * The predictor's client-tick counter, written once per predicted tick by
   * `game/frame.ts`'s `predictPendingTicks`. `sendMovement` READS it to stamp
   * `InputState.clientTick`; it never advances it.
   *
   * That asymmetry is the point. The server echoes this number back as
   * `player_input_ack.lastProcessedClientTick`, and `frame.ts` slices its predicted-tick
   * buffer against the echo — so the number has to come from the buffer's own numbering
   * or the slice is comparing two unrelated counters. It briefly did: this hook used to
   * own a private counter incremented per SEND (once per key edge, plus a 20/s heartbeat)
   * while the predictor counted 20/s sim ticks including idle ones. See
   * `frame.ts`'s `StepFrameContext.clientTickRef` for the measured consequences.
   *
   * `sequence` stays this hook's own strictly-increasing per-send counter — it is the
   * server's replay/dedupe guard (`net.rs`: `if input.sequence <= last_input_seq { return }`),
   * a different job that genuinely does need one increment per message.
   */
  clientTickRef: MutableRefObject<number>;
  /** Presentation-only: fires once per hold when a slot crosses the server's holdThresholdTicks. */
  onHoldThresholdCrossed?: (slot: string) => void;
  /**
   * Instrumentation-only: fires with the sequence number of an input the instant it goes on
   * the wire. This hook exists because the send timestamp is knowable nowhere else — the ack
   * that closes the round trip (`player_input_ack.lastInputSeq`) lands in `game/frame.ts`,
   * which never sees the moment of sending. Like `onHoldThresholdCrossed`, it must not
   * influence anything sent; see `perf/metrics.ts` for the consumer.
   */
  onInputSent?: (sequence: number) => void;
}

export interface UseInputResult {
  movementRef: MutableRefObject<Readonly<MovementState>>;
  /** Facing yaw, also what gets sent as `update_player_input`'s rotationY. */
  rotationYRef: MutableRefObject<number>;
  /** Camera-only pitch; the server has no notion of vertical facing. */
  pitchRef: MutableRefObject<number>;
  locked: boolean;
  requestPointerLock: (element: Element) => void;
}

export function useInput({
  connRef,
  active,
  clientTickRef,
  onHoldThresholdCrossed,
  onInputSent,
}: UseInputOptions): UseInputResult {
  const intentRef = useRef<IntentState>(createIntentState());
  const movementRef = useRef<MovementState>(createMovementState());
  const rotationYRef = useRef(0);
  const pitchRef = useRef(0);
  const sequenceRef = useRef(0);
  const localTickRef = useRef(0);
  const crossedThresholdRef = useRef<Set<string>>(new Set());
  const [locked, setLocked] = useState(false);

  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const onHoldThresholdCrossedRef = useRef(onHoldThresholdCrossed);
  useEffect(() => {
    onHoldThresholdCrossedRef.current = onHoldThresholdCrossed;
  });
  const onInputSentRef = useRef(onInputSent);
  useEffect(() => {
    onInputSentRef.current = onInputSent;
  });

  const sendMovement = useCallback(() => {
    const connection = connRef.current;
    if (!connection || !activeRef.current) return;
    const movement = movementRef.current;
    sequenceRef.current += 1;
    const input: InputState = {
      forward: movement.forward,
      backward: movement.backward,
      left: movement.left,
      right: movement.right,
      sprint: false, // no default key binds sprint — see input/keymap.ts
      jump: movement.jump,
      sequence: sequenceRef.current,
      clientTick: clientTickRef.current,
    };
    connection.reducers.updatePlayerInput({ input, rotationY: rotationYRef.current });
    onInputSentRef.current?.(input.sequence);
  }, [connRef, clientTickRef]);

  const applyIntentResult = useCallback((result: IntentResult) => {
    intentRef.current = result.state;
    if (result.movement) {
      movementRef.current = result.movement;
      sendMovement();
    }
    if (result.edges.length === 0) return;
    const connection = connRef.current;
    for (const slotEdge of result.edges) {
      if (slotEdge.edge === 'Release') crossedThresholdRef.current.delete(slotEdge.slot);
      if (!connection || !activeRef.current) continue;
      connection.reducers.actionInput({
        slot: slotEdge.slot,
        edge: slotEdge.edge === 'Press' ? InputEdge.Press : InputEdge.Release,
        aim: aimVectorFor(rotationYRef.current, pitchRef.current),
      });
    }
  }, [connRef, sendMovement]);

  // --- tick heartbeat: resend held movement, mirror hold thresholds --------
  useEffect(() => {
    const id = window.setInterval(() => {
      localTickRef.current += 1;
      if (isHeld(movementRef.current)) sendMovement();

      for (const slot of intentRef.current.heldSlotSince.keys()) {
        const threshold = HOLD_THRESHOLD_TICKS_BY_SLOT.get(slot);
        if (!threshold || crossedThresholdRef.current.has(slot)) continue;
        if (holdTicksFor(intentRef.current, slot, localTickRef.current) >= threshold) {
          crossedThresholdRef.current.add(slot);
          onHoldThresholdCrossedRef.current?.(slot);
        }
      }
    }, TICK_PERIOD_MS);
    return () => window.clearInterval(id);
  }, [sendMovement]);

  // --- DOM listeners ---------------------------------------------------------
  useEffect(() => {
    const handleKeyDownEvent = (event: KeyboardEvent) => {
      const target = event.target as EditableTargetLike | null;
      if (intentRef.current.locked && BOUND_KEY_CODES.has(event.code) && !event.repeat) {
        event.preventDefault();
      }
      applyIntentResult(handleKeyDown(intentRef.current, event, target, localTickRef.current));
    };

    const handleKeyUpEvent = (event: KeyboardEvent) => {
      const target = event.target as EditableTargetLike | null;
      applyIntentResult(handleKeyUp(intentRef.current, event, target));
    };

    const handleMouseDownEvent = (event: MouseEvent) => {
      applyIntentResult(handleMouseDown(intentRef.current, event, localTickRef.current));
    };

    const handleMouseUpEvent = (event: MouseEvent) => {
      applyIntentResult(handleMouseUp(intentRef.current, event));
    };

    const handleMouseMoveEvent = (event: MouseEvent) => {
      if (!intentRef.current.locked) return;
      rotationYRef.current -= event.movementX * CAMERA_YAW_SENSITIVITY;
      pitchRef.current = Math.max(
        MIN_PITCH,
        Math.min(MAX_PITCH, pitchRef.current - event.movementY * CAMERA_PITCH_SENSITIVITY),
      );
    };

    const handlePointerLockChange = () => {
      const isLocked = document.pointerLockElement !== null;
      setLocked(isLocked);
      applyIntentResult(setPointerLocked(intentRef.current, isLocked));
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (intentRef.current.locked) event.preventDefault();
    };

    window.addEventListener('keydown', handleKeyDownEvent);
    window.addEventListener('keyup', handleKeyUpEvent);
    document.addEventListener('mousedown', handleMouseDownEvent);
    document.addEventListener('mouseup', handleMouseUpEvent);
    document.addEventListener('mousemove', handleMouseMoveEvent);
    document.addEventListener('pointerlockchange', handlePointerLockChange);
    document.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('blur', handlePointerLockChange);

    return () => {
      window.removeEventListener('keydown', handleKeyDownEvent);
      window.removeEventListener('keyup', handleKeyUpEvent);
      document.removeEventListener('mousedown', handleMouseDownEvent);
      document.removeEventListener('mouseup', handleMouseUpEvent);
      document.removeEventListener('mousemove', handleMouseMoveEvent);
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      document.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('blur', handlePointerLockChange);
    };
  }, [applyIntentResult]);

  const requestPointerLock = useCallback((element: Element) => {
    if (document.pointerLockElement === element) return;
    element.requestPointerLock();
  }, []);

  return { movementRef, rotationYRef, pitchRef, locked, requestPointerLock };
}
