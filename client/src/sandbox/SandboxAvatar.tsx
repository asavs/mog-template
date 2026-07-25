/**
 * Mounts a body from the content seam and drives it through the layered
 * animation controller.
 *
 * This component knows nothing about where the body, the motion, or the prop
 * came from — procedural placeholder and imported asset arrive identically.
 */

import { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { AnimationController } from '../anim';
import {
  ALL_MOTION_KEYS,
  BODY_KEYS,
  MOTION_ACTION,
  MOTION_REACTION,
  SOCKETS,
  STANCES,
  applyGrip,
  describeRigBinding,
  inspectClipBinding,
  inspectRigBinding,
  resolveBody,
  resolveMotion,
  resolveProp,
  type MotionKey,
  type PropKey,
  type ResolvedBody,
  type StanceKey,
} from '../content';

/** One-shot request. `nonce` lets the same motion be fired repeatedly. */
export type SandboxTrigger = {
  key: MotionKey;
  kind: 'overlay' | 'fullBody' | 'hit' | 'death';
  /** Fraction of move speed the action permits; narrows the mask above zero. */
  movement: number;
  nonce: number;
};

type SandboxAvatarProps = {
  /** Called once the body loads, with a human-readable rig binding summary. */
  onRigReport?: (lines: string[]) => void;
  locomotion: MotionKey;
  stance: StanceKey;
  guard: boolean;
  /** Extra prop in the right hand, for eyeballing a grip outside any loadout. */
  gripTest: PropKey | null;
  trigger: SandboxTrigger | null;
};

export function SandboxAvatar({
  onRigReport,
  locomotion,
  stance,
  guard,
  gripTest,
  trigger,
}: SandboxAvatarProps) {
  const reportRef = useRef(onRigReport);
  reportRef.current = onRigReport;
  const groupRef = useRef<THREE.Group>(null);
  const controllerRef = useRef<AnimationController | null>(null);
  const [body, setBody] = useState<ResolvedBody | null>(null);

  // Latest requested selections, readable from the build effect without making
  // the body depend on them — changing gait must never rebuild the skeleton.
  const locomotionRef = useRef(locomotion);
  locomotionRef.current = locomotion;
  const stanceRef = useRef(stance);
  stanceRef.current = stance;

  useEffect(() => {
    let disposed = false;
    let mounted: ResolvedBody | null = null;

    void (async () => {
      // The controller looks clips up synchronously while the seam resolves
      // asynchronously, so every motion is resolved once, up front, and then
      // served from a map.
      const [resolved, entries] = await Promise.all([
        resolveBody(BODY_KEYS.humanoid),
        Promise.all(
          ALL_MOTION_KEYS.map(async key => [key, await resolveMotion(key)] as const),
        ),
      ]);
      if (disposed || !resolved || !groupRef.current) return;

      mounted = resolved;
      groupRef.current.add(resolved.root);

      const clips = new Map<string, THREE.AnimationClip>();
      for (const [key, clip] of entries) {
        if (clip) clips.set(key, clip);
      }

      const controller = new AnimationController(
        resolved.root,
        key => clips.get(key) ?? null,
        {
          // Placeholder art has one guard clip rather than enter/held/exit.
          guardMotions: {
            enter: MOTION_ACTION.guardHold,
            held: MOTION_ACTION.guardHold,
            exit: MOTION_ACTION.guardHold,
          },
          reactionMotions: { hit: MOTION_REACTION.hit, death: MOTION_REACTION.death },
        },
      );
      controllerRef.current = controller;
      // Start the selected gait here: the controller only exists once the body
      // has loaded, so the effects below have nothing to talk to before now.
      controller.setLocomotion(locomotionRef.current);
      controller.setStance(STANCES[stanceRef.current].motion);

      // How much of an imported asset actually binds is the first thing you
      // want to know and the last thing three.js will tell you — an unbound
      // track is silently dropped, not an error.
      const rig = inspectRigBinding(resolved.root);
      const dead = [...clips.entries()]
        .map(([key, clip]) => [key, inspectClipBinding(clip, resolved.root)] as const)
        .filter(([, report]) => report.coverage < 1);
      reportRef.current?.([
        describeRigBinding(rig),
        ...(rig.extra.length ? [`${rig.extra.length} unnamed bones on this rig`] : []),
        ...dead.map(([key, report]) =>
          `${key}: ${report.unbound.length} dead track(s)`),
      ]);

      setBody(resolved);
    })();

    return () => {
      disposed = true;
      controllerRef.current?.dispose();
      controllerRef.current = null;
      mounted?.root.removeFromParent();
      setBody(null);
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setLocomotion(locomotion);
  }, [locomotion, body]);

  useEffect(() => {
    controllerRef.current?.setStance(STANCES[stance].motion);
  }, [stance, body]);

  useEffect(() => {
    controllerRef.current?.setGuard(guard);
  }, [guard, body]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !trigger) return;

    switch (trigger.kind) {
      case 'overlay':
        controller.playAbility(trigger.key, {
          upperBodyOnly: true,
          movement: trigger.movement,
        });
        break;
      case 'fullBody':
        controller.playAbility(trigger.key, { upperBodyOnly: false });
        break;
      case 'hit':
        controller.playHitReaction(trigger.key);
        break;
      case 'death':
        controller.playDeath(trigger.key);
        break;
    }
  }, [trigger]);

  // Equip the stance's loadout: each slot attaches its prop to a hand socket,
  // positioned by the shared grip table rather than by the mesh itself.
  useEffect(() => {
    if (!body) return;

    let disposed = false;
    const attached: THREE.Object3D[] = [];

    for (const slot of STANCES[stance].slots) {
      const socket = body.bones[slot.socket];
      if (!socket) continue;
      void (async () => {
        const object = await resolveProp(slot.prop);
        if (disposed || !object) return;
        applyGrip(object, slot.prop, slot.socket, socket);
        socket.add(object);
        attached.push(object);
      })();
    }

    return () => {
      disposed = true;
      for (const object of attached) object.removeFromParent();
    };
  }, [body, stance]);

  useEffect(() => {
    const socket = body?.bones[SOCKETS.rightHand];
    if (!socket || !gripTest) return;

    let disposed = false;
    let attached: THREE.Object3D | null = null;

    void (async () => {
      const object = await resolveProp(gripTest);
      if (disposed || !object) return;
      applyGrip(object, gripTest, SOCKETS.rightHand, socket);
      attached = object;
      socket.add(object);
    })();

    return () => {
      disposed = true;
      attached?.removeFromParent();
    };
  }, [body, gripTest]);

  useFrame((_, delta) => {
    controllerRef.current?.update(delta);
  });

  return <group ref={groupRef} />;
}
