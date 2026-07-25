/**
 * The body, and whatever is currently being played on it.
 *
 * Two drivers, because auditioning and verifying are different questions.
 *
 * RAW plays a clip on a bare mixer with nothing else running. No fades, no
 * rules, no locomotion underneath — just the clip, at the speed and loop you
 * asked for. This is how you answer "what IS this animation", which is the
 * question you have when a pack ships eighty-six clips named by someone else.
 *
 * LAYERED runs the same clip through the real `AnimationController`, with a
 * gait underneath and the band mask applied by the same code the game uses.
 * This is how you answer "does it still read when someone is walking", which
 * a clip can fail while looking perfect on its own.
 *
 * Switching modes tears down the driver that is leaving rather than leaving it
 * half-faded on the rig, and every raw play resets the skeleton to its bind
 * pose first — otherwise a masked clip leaves the un-driven bones frozen
 * wherever the previous clip abandoned them, which reads as a broken rig.
 */

import { useEffect, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { AnimationController, maskClipToBands, type AnimationBand } from '../anim';
import {
  ALL_MOTION_KEYS,
  BODY_KEYS,
  MOTION_ACTION,
  MOTION_REACTION,
  SOCKETS,
  applyGrip,
  describeRigBinding,
  inspectClipBinding,
  inspectRigBinding,
  resolveBody,
  resolveMotion,
  resolveProp,
  type PropKey,
  type ResolvedBody,
  type SocketId,
} from '../content';
import type { CatalogEntry } from './catalog';

export type PlaybackMode = 'raw' | 'layered';

export type StageReport = {
  bodyLoaded: boolean;
  rig: string;
  clipName: string | null;
  boundTracks: number;
  totalTracks: number;
  byBand: Record<string, number>;
};

export type SandboxStageProps = {
  entry: CatalogEntry | null;
  mode: PlaybackMode;
  loop: boolean;
  speed: number;
  /** Bands the clip is filtered to. null plays the whole body. */
  bands: readonly AnimationBand[] | null;
  /** Gait running underneath, in layered mode. */
  baseLocomotion: string | null;
  /** Fraction of move speed the action permits; narrows the overlay above 0. */
  movement: number;
  rightHand: PropKey | null;
  leftHand: PropKey | null;
  /** Bump to replay the current selection from the top. */
  playToken: number;
  onReport: (report: StageReport) => void;
};

const EMPTY_BANDS: Record<string, number> = {};

export function SandboxStage({
  entry,
  mode,
  loop,
  speed,
  bands,
  baseLocomotion,
  movement,
  rightHand,
  leftHand,
  playToken,
  onReport,
}: SandboxStageProps) {
  const groupRef = useRef<THREE.Group>(null);
  const [body, setBody] = useState<ResolvedBody | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const controllerRef = useRef<AnimationController | null>(null);
  /** Every clip the controller can resolve, by key or by catalog id. */
  const clipsRef = useRef(new Map<string, THREE.AnimationClip>());

  const reportRef = useRef(onReport);
  reportRef.current = onReport;

  // --- body ---------------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    let mounted: ResolvedBody | null = null;

    void (async () => {
      const [resolved, motions] = await Promise.all([
        resolveBody(BODY_KEYS.humanoid),
        Promise.all(ALL_MOTION_KEYS.map(async key => [key, await resolveMotion(key)] as const)),
      ]);
      if (disposed || !resolved || !groupRef.current) return;

      mounted = resolved;
      groupRef.current.add(resolved.root);

      clipsRef.current.clear();
      for (const [key, clip] of motions) {
        if (clip) clipsRef.current.set(key, clip);
      }

      mixerRef.current = new THREE.AnimationMixer(resolved.root);

      // How much of the rig an imported pack actually reaches is the first
      // thing worth knowing and the last thing three.js will volunteer.
      reportRef.current({
        bodyLoaded: true,
        rig: describeRigBinding(inspectRigBinding(resolved.root)),
        clipName: null,
        boundTracks: 0,
        totalTracks: 0,
        byBand: EMPTY_BANDS,
      });

      setBody(resolved);
    })();

    return () => {
      disposed = true;
      controllerRef.current?.dispose();
      controllerRef.current = null;
      mixerRef.current?.stopAllAction();
      mixerRef.current = null;
      mounted?.root.removeFromParent();
      setBody(null);
    };
  }, []);

  // --- driver, per mode ----------------------------------------------------
  useEffect(() => {
    if (!body) return;

    if (mode === 'layered') {
      mixerRef.current?.stopAllAction();
      const controller = new AnimationController(
        body.root,
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
      controllerRef.current = controller;
      return () => {
        controller.dispose();
        controllerRef.current = null;
      };
    }

    controllerRef.current?.dispose();
    controllerRef.current = null;
    return undefined;
  }, [body, mode]);

  // --- play ----------------------------------------------------------------
  useEffect(() => {
    if (!body || !entry) return;

    const clip = bands ? maskClipToBands(entry.clip, bands) : entry.clip;

    // Report what this clip will actually move on this body BEFORE playing it,
    // so a clip that binds nothing is visibly nothing rather than mysteriously
    // still.
    const binding = inspectClipBinding(entry.clip, body.root);
    reportRef.current({
      bodyLoaded: true,
      rig: describeRigBinding(inspectRigBinding(body.root)),
      clipName: entry.name,
      boundTracks: binding.bound.length,
      totalTracks: binding.bound.length + binding.unbound.length,
      byBand: binding.byBand,
    });

    if (mode === 'layered') {
      const controller = controllerRef.current;
      if (!controller) return;
      controller.setLocomotion(baseLocomotion ?? '');
      clipsRef.current.set(entry.id, entry.clip);
      controller.playAbility(entry.id, {
        upperBodyOnly: bands !== null,
        movement,
      });
      return;
    }

    const mixer = mixerRef.current;
    if (!mixer) return;
    mixer.stopAllAction();
    // Un-driven bones would otherwise hold the previous clip's last frame.
    body.skeleton.pose();
    const action = mixer.clipAction(clip);
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    action.timeScale = speed;
    action.reset().play();

    return () => {
      action.stop();
    };
  }, [body, entry, mode, bands, loop, speed, movement, baseLocomotion, playToken]);

  // --- props ---------------------------------------------------------------
  useEffect(() => {
    if (!body) return;
    let disposed = false;
    const attached: THREE.Object3D[] = [];

    const equip = (prop: PropKey | null, socketId: SocketId) => {
      if (!prop) return;
      const bone = body.bones[socketId];
      if (!bone) return;
      void (async () => {
        const object = await resolveProp(prop);
        if (disposed || !object) return;
        applyGrip(object, prop, socketId, bone);
        bone.add(object);
        attached.push(object);
      })();
    };

    equip(rightHand, SOCKETS.rightHand);
    equip(leftHand, SOCKETS.leftHand);

    return () => {
      disposed = true;
      for (const object of attached) object.removeFromParent();
    };
  }, [body, rightHand, leftHand]);

  useFrame((_, delta) => {
    if (mode === 'layered') controllerRef.current?.update(delta);
    else mixerRef.current?.update(delta);
  });

  return <group ref={groupRef} />;
}
