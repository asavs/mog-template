/**
 * One player's skinned rig: `body.humanoid` (content seam) + a real
 * `AnimationController`, driven every frame from whatever this identity's
 * live rows currently say. The SAME component drives the local player and
 * every remote — see `presentation/animBridge.ts`'s module doc for why that
 * is safe (every `drive*` call is a stateless, idempotent-safe function of
 * its inputs).
 *
 * `local` is present only for the local player: `game/frame.ts` already ran
 * `sim/locomotion.ts`'s FSM this tick and knows the real input axes, so the
 * local body gets a directional gait. A remote has neither — only the coarse
 * booleans `player_transform.movementState` carries — so it falls back to
 * `presentation/locomotionBridge.ts`'s coarser remote mapping.
 */

import { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { ACTION_DEFS } from '../actions/defs.generated';
import { AnimationController } from '../anim';
import {
  ALL_MOTION_KEYS,
  BODY_KEYS,
  MOTION_ACTION,
  MOTION_REACTION,
  resolveBody,
  resolveMotion,
  type ResolvedBody,
} from '../content';
import { driveAnimationFromActionState, type ActionPhase } from '../presentation/animBridge';
import type { Effects } from '../presentation/effects';
import { locomotionKeyForPhase, locomotionKeyForRemoteState, type DirectionalInput } from '../presentation/locomotionBridge';
import { driveDeathReaction, driveHitReaction, driveReactionsFromEvent } from '../presentation/reactions';
import type { LocomotionPhase } from '../sim/locomotion';
import type { GameStore } from './sync';

export type PlayerBodyProps = {
  identityHex: string;
  store: GameStore;
  effects: Effects;
  /**
   * True for exactly one instance (the local player) per scene — see
   * `presentation/reactions.ts`'s module doc: `Effects` is scene-wide, so
   * only one caller may spawn its pooled visuals per event or they would
   * spawn once per witnessing player. Everyone else still gets their own
   * hit-flinch via `driveHitReaction` directly.
   */
  ownsSceneEffects: boolean;
  /**
   * Local player only. Absent for a remote — see module doc. Closures, not
   * plain values: this component's own `useFrame` reads them fresh every
   * frame, but the parent `Scene` only re-renders on player-count changes
   * (its own high-frequency state lives in refs, per `game/frame.ts`'s
   * pattern), so a plain value here would freeze at whatever it was on the
   * last render instead of tracking the live per-tick sim output.
   */
  local?: { phase: () => LocomotionPhase; input: () => DirectionalInput };
};

/** All motion clips, resolved once and shared (by key) across every player instance. */
let sharedClipsPromise: Promise<ReadonlyArray<readonly [string, THREE.AnimationClip | null]>> | null = null;
function allMotionClips() {
  sharedClipsPromise ??= Promise.all(ALL_MOTION_KEYS.map(async key => [key, await resolveMotion(key)] as const));
  return sharedClipsPromise;
}

export function PlayerBody({ identityHex, store, effects, ownsSceneEffects, local }: PlayerBodyProps) {
  const groupRef = useRef<THREE.Group>(null);
  const controllerRef = useRef<AnimationController | null>(null);
  const clipsRef = useRef(new Map<string, THREE.AnimationClip>());
  const processedEventIdsRef = useRef(new Set<string>());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let mounted: ResolvedBody | null = null;

    void (async () => {
      const [resolved, motions] = await Promise.all([resolveBody(BODY_KEYS.humanoid), allMotionClips()]);
      if (disposed || !resolved || !groupRef.current) return;

      mounted = resolved;
      groupRef.current.add(resolved.root);
      for (const [key, clip] of motions) {
        if (clip) clipsRef.current.set(key, clip);
      }

      controllerRef.current = new AnimationController(
        resolved.root,
        key => clipsRef.current.get(key) ?? null,
        {
          guardMotions: {
            enter: MOTION_ACTION.guardHold,
            held: MOTION_ACTION.guardHold,
            exit: MOTION_ACTION.guardHold,
          },
          reactionMotions: { hit: MOTION_REACTION.hit, death: MOTION_REACTION.death },
        },
      );
      setReady(true);
    })();

    return () => {
      disposed = true;
      controllerRef.current?.dispose();
      controllerRef.current = null;
      mounted?.root.removeFromParent();
      setReady(false);
    };
    // Body/controller identity does not depend on which player wears it — only mount once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame((_state, delta) => {
    const controller = controllerRef.current;
    if (!controller) return;
    controller.update(delta);

    controller.setLocomotion(locomotionKey());

    const actionState = store.playerActionState.get(identityHex);
    driveAnimationFromActionState(controller, ACTION_DEFS, {
      actionId: actionState?.actionId ?? '',
      phase: (actionState?.phase ?? 0) as ActionPhase,
    });

    const health = store.playerHealth.get(identityHex);
    driveDeathReaction(controller, { isDead: health?.isDead ?? false });

    driveNewActionEvents(controller);
  });

  function locomotionKey(): string {
    if (local) return locomotionKeyForPhase(local.phase(), local.input());
    const transform = store.playerTransform.get(identityHex);
    const movementState = transform?.movementState;
    return locomotionKeyForRemoteState(
      movementState?.isAirborne ?? false,
      transform?.isMoving ?? false,
      movementState?.sprintActive ?? false,
    );
  }

  /** Each `action_event` row is transient but persists in the store for a few ticks after it
   * fires (see docs/action-pipeline.md's reap window) — react to it exactly once. */
  function driveNewActionEvents(controller: AnimationController): void {
    const processed = processedEventIdsRef.current;
    for (const row of store.actionEvent.values()) {
      const id = String(row.id);
      if (processed.has(id)) continue;
      processed.add(id);

      const targetIsSelf = row.target?.toHexString() === identityHex;
      if (ownsSceneEffects) {
        driveReactionsFromEvent(controller, effects, ACTION_DEFS, {
          id,
          actionId: row.actionId,
          kind: row.kind,
          position: row.position ?? null,
          targetIsSelf,
        });
      } else if (targetIsSelf) {
        driveHitReaction(controller, { kind: row.kind, targetIsSelf });
      }
    }
    if (processed.size > store.actionEvent.size) {
      for (const id of processed) {
        if (!store.actionEvent.has(id)) processed.delete(id);
      }
    }
  }

  return <group ref={groupRef} visible={ready} />;
}
