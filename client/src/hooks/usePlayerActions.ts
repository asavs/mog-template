import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import type { Identity } from 'spacetimedb';
import type { DbConnection } from '../generated';
import type { InputState, Vector3 } from '../generated/types';
import type { NetMetrics } from '../netcode';
import type { PlayerRuntimeState } from '../playerRuntime';
import type { GameWorldPlayerActions } from '../components/GameWorld';

const ROTATION_SEND_INTERVAL_MS = 1000 / 30;
const ROTATION_SEND_EPSILON = 0.01;
const MOVEMENT_INPUT_SEND_INTERVAL_MS = 50;

type UsePlayerActionsOptions = {
  connRef: MutableRefObject<DbConnection | null>;
  identity: Identity | null;
  inputRef: MutableRefObject<InputState>;
  isDead: boolean;
  isJoined: boolean;
  isJoinedRef: MutableRefObject<boolean>;
  metricsRef: MutableRefObject<NetMetrics>;
  playerRuntimeRef: MutableRefObject<PlayerRuntimeState>;
  rotationYRef: MutableRefObject<number>;
};

type UsePlayerActionsResult = {
  gameWorldPlayerActions: GameWorldPlayerActions;
  sendInputNow: (force?: boolean) => void;
};

type SentInputState = {
  backward: boolean;
  forward: boolean;
  jump: boolean;
  left: boolean;
  right: boolean;
  rotationY: number;
  sprint: boolean;
};

function isLocalPlayerDead(
  identity: Identity | null,
  playerRuntimeRef: MutableRefObject<PlayerRuntimeState>,
): boolean {
  return !!identity && (playerRuntimeRef.current.health.get(identity.toHexString())?.isDead ?? false);
}

function currentSentInputState(input: InputState, rotationY: number): SentInputState {
  return {
    backward: input.backward,
    forward: input.forward,
    jump: input.jump,
    left: input.left,
    right: input.right,
    rotationY,
    sprint: input.sprint,
  };
}

function isSameSentInputState(a: SentInputState | null, b: SentInputState): boolean {
  return !!a &&
    a.backward === b.backward &&
    a.forward === b.forward &&
    a.jump === b.jump &&
    a.left === b.left &&
    a.right === b.right &&
    a.rotationY === b.rotationY &&
    a.sprint === b.sprint;
}

/** True when held movement/jump warrants a periodic force-resend. */
export function inputNeedsForceResend(input: InputState): boolean {
  return input.forward
    || input.backward
    || input.left
    || input.right
    || input.jump
    || input.sprint;
}

export function prepareClientTickForSend({
  acknowledgedClientTick,
  input,
  inputChanged,
  lastSentClientTick,
}: {
  acknowledgedClientTick: number;
  input: InputState;
  inputChanged: boolean;
  lastSentClientTick: number;
}): boolean {
  if (inputChanged) {
    input.clientTick = Math.max(
      input.clientTick,
      acknowledgedClientTick + 1,
      lastSentClientTick + 1,
    );
  }
  return input.clientTick > acknowledgedClientTick && input.clientTick > lastSentClientTick;
}

/**
 * Gate for reducer sends.
 * - Change-based sends always proceed (key up/down, rotation).
 * - Forced interval sends only while movement/jump is active, so pure idle
 *   does not mint new sequences that would rebroadcast player_input_ack rows.
 */
export function shouldSendPlayerInput({
  force,
  input,
  inputChanged,
}: {
  force: boolean;
  input: InputState;
  inputChanged: boolean;
}): boolean {
  if (inputChanged) return true;
  if (!force) return false;
  return inputNeedsForceResend(input);
}

export function usePlayerActions({
  connRef,
  identity,
  inputRef,
  isDead,
  isJoined,
  isJoinedRef,
  metricsRef,
  playerRuntimeRef,
  rotationYRef,
}: UsePlayerActionsOptions): UsePlayerActionsResult {
  const rotationSendTimeoutRef = useRef<number | null>(null);
  const movementInputIntervalRef = useRef<number | null>(null);
  const lastRotationSentAtRef = useRef(0);
  const lastRotationSentValueRef = useRef(0);
  const lastSentInputStateRef = useRef<SentInputState | null>(null);

  const sendInputNow = useCallback((force = false) => {
    const connection = connRef.current;
    if (!connection || !isJoinedRef.current) return;
    if (isLocalPlayerDead(identity, playerRuntimeRef)) return;

    const input = inputRef.current;
    const sentInputState = currentSentInputState(input, rotationYRef.current);
    const inputChanged = !isSameSentInputState(lastSentInputStateRef.current, sentInputState);
    if (!shouldSendPlayerInput({ force, input, inputChanged })) return;

    const metrics = metricsRef.current;
    if (!prepareClientTickForSend({
      acknowledgedClientTick: metrics.acknowledgedClientTick,
      input,
      inputChanged,
      lastSentClientTick: metrics.lastSentClientTick,
    })) {
      return;
    }

    input.sequence += 1;
    connection.reducers.updatePlayerInput({
      input: { ...input },
      rotationY: rotationYRef.current,
    });

    lastSentInputStateRef.current = sentInputState;
    metrics.lastSentClientTick = input.clientTick;
    metrics.inputSendCount += 1;
    lastRotationSentAtRef.current = performance.now();
    lastRotationSentValueRef.current = rotationYRef.current;
  }, [connRef, identity, inputRef, isJoinedRef, metricsRef, playerRuntimeRef, rotationYRef]);

  const queueRotationSend = useCallback(function queue() {
    if (!isJoinedRef.current) return;

    const delta = Math.abs(Math.atan2(
      Math.sin(rotationYRef.current - lastRotationSentValueRef.current),
      Math.cos(rotationYRef.current - lastRotationSentValueRef.current),
    ));

    if (delta < ROTATION_SEND_EPSILON) return;

    const now = performance.now();
    const elapsed = now - lastRotationSentAtRef.current;
    if (elapsed >= ROTATION_SEND_INTERVAL_MS) {
      sendInputNow();
      return;
    }

    if (rotationSendTimeoutRef.current !== null) return;
    rotationSendTimeoutRef.current = window.setTimeout(() => {
      rotationSendTimeoutRef.current = null;
      queue();
    }, ROTATION_SEND_INTERVAL_MS - elapsed);
  }, [isJoinedRef, sendInputNow, rotationYRef]);

  useEffect(() => {
    lastSentInputStateRef.current = null;
    if (movementInputIntervalRef.current !== null) {
      window.clearInterval(movementInputIntervalRef.current);
      movementInputIntervalRef.current = null;
    }
    if (isJoined && !isDead) {
      sendInputNow(true);
      movementInputIntervalRef.current = window.setInterval(() => {
        sendInputNow(true);
      }, MOVEMENT_INPUT_SEND_INTERVAL_MS);
    }

    return () => {
      if (movementInputIntervalRef.current !== null) {
        window.clearInterval(movementInputIntervalRef.current);
        movementInputIntervalRef.current = null;
      }
    };
  }, [isDead, isJoined, sendInputNow]);

  useEffect(() => {
    return () => {
      if (rotationSendTimeoutRef.current !== null) {
        window.clearTimeout(rotationSendTimeoutRef.current);
      }
      if (movementInputIntervalRef.current !== null) {
        window.clearInterval(movementInputIntervalRef.current);
      }
    };
  }, []);

  const handleRotationChange = useCallback((rotationY: number) => {
    rotationYRef.current = rotationY;
    queueRotationSend();
  }, [queueRotationSend, rotationYRef]);

  const handleSlashAttack = useCallback(() => {
    if (isLocalPlayerDead(identity, playerRuntimeRef)) return;
    connRef.current?.reducers.triggerSlashAttack({});
  }, [connRef, identity, playerRuntimeRef]);

  const handleBlockStart = useCallback(() => {
    if (isLocalPlayerDead(identity, playerRuntimeRef)) return;
    connRef.current?.reducers.startBlock({});
  }, [connRef, identity, playerRuntimeRef]);

  const handleBlockStop = useCallback(() => {
    if (isLocalPlayerDead(identity, playerRuntimeRef)) return;
    connRef.current?.reducers.stopBlock({});
  }, [connRef, identity, playerRuntimeRef]);

  const handleLightningStrike = useCallback((targetPosition: Vector3) => {
    if (isLocalPlayerDead(identity, playerRuntimeRef)) return;
    connRef.current?.reducers.triggerLightningStrike({ targetPosition });
  }, [connRef, identity, playerRuntimeRef]);

  const handleFireballCast = useCallback((targetPosition: Vector3) => {
    if (isLocalPlayerDead(identity, playerRuntimeRef)) return;
    connRef.current?.reducers.triggerFireball({ targetPosition });
  }, [connRef, identity, playerRuntimeRef]);

  const handleDrinkPotion = useCallback(() => {
    if (isLocalPlayerDead(identity, playerRuntimeRef)) return;
    connRef.current?.reducers.triggerDrinkingPotion({});
  }, [connRef, identity, playerRuntimeRef]);

  const gameWorldPlayerActions = useMemo(() => ({
    onBlockStart: handleBlockStart,
    onBlockStop: handleBlockStop,
    onDrinkPotion: handleDrinkPotion,
    onFireballCast: handleFireballCast,
    onLightningStrike: handleLightningStrike,
    onRotationChange: handleRotationChange,
    onSlashAttack: handleSlashAttack,
  }), [
    handleBlockStart,
    handleBlockStop,
    handleDrinkPotion,
    handleFireballCast,
    handleLightningStrike,
    handleRotationChange,
    handleSlashAttack,
  ]);

  return {
    gameWorldPlayerActions,
    sendInputNow,
  };
}
