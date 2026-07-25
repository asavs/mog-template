/**
 * The body in the drill room, running one step at a time.
 *
 * The split with `DrillRoom` is deliberate: the ROOM owns which step is
 * current, and this only plays whatever it is told. That is what makes manual
 * stepping and auto-advance the same mechanism rather than two — pausing is
 * simply nobody advancing the index, and scrubbing backwards is the index
 * moving the other way. A stage that owned its own cursor would need a second
 * path for every one of those.
 *
 * It reports two things upward, and both are about not being lied to:
 * whether the step actually started, and what the running clip is doing to the
 * rig. A step that silently fails to play looks exactly like a bad animation.
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
  STANCES,
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
import { stepSeconds, type Drill, type DrillWidth } from './drills';

/** Why a step is not showing what its label claims. */
export type StepStatus = 'ok' | 'no-clip' | 'refused';

export type StageReport = {
  rig: string;
  /** Tracks of the running clip that actually drive a bone on this body. */
  bound: number;
  total: number;
  byBand: Record<string, number>;
};

export type DrillStageProps = {
  drill: Drill;
  stepIndex: number;
  /** Advancing is the room's job; this just stops accumulating. */
  playing: boolean;
  speed: number;
  /** Replaces the step's own width, for trying an alternative in place. */
  widthOverride: DrillWidth | null;
  /** Bump to fire the current step again without changing it. */
  replayToken: number;
  onStatus: (status: StepStatus) => void;
  onReport: (report: StageReport) => void;
  /** The step has run its course. The room decides what happens next. */
  onElapsed: () => void;
  /**
   * What ended up in each hand, with the bone it hangs from.
   *
   * Handed up so the grip editor can put a gizmo on a held prop. The bone comes
   * with it because a grip is only meaningful relative to the hand — the fist
   * frame is solved from that bone's fingers.
   */
  onEquipped?: (held: readonly HeldProp[]) => void;
};

export type HeldProp = {
  prop: PropKey;
  socket: SocketId;
  object: THREE.Object3D;
  hand: THREE.Object3D;
};

const EMPTY_BANDS: Record<string, number> = {};

export function DrillStage({
  drill,
  stepIndex,
  playing,
  speed,
  widthOverride,
  replayToken,
  onStatus,
  onReport,
  onElapsed,
  onEquipped,
}: DrillStageProps) {
  const groupRef = useRef<THREE.Group>(null);
  const [body, setBody] = useState<ResolvedBody | null>(null);
  const controllerRef = useRef<AnimationController | null>(null);
  const clipsRef = useRef(new Map<string, THREE.AnimationClip>());
  const elapsedRef = useRef(0);
  /** Whether this step's recovery window has been opened yet. */
  const cancelledRef = useRef(false);

  const callbacks = useRef({ onStatus, onReport, onElapsed, onEquipped });
  useEffect(() => {
    callbacks.current = { onStatus, onReport, onElapsed, onEquipped };
  });

  const step = drill.steps[stepIndex];
  const width = widthOverride ?? step?.width ?? 'full';

  // --- body, clips and controller -------------------------------------------
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
      // Steps name library clips, most of which are bound to no key at all.
      for (const [name, clip] of await loadLibraryClips()) clipsRef.current.set(name, clip);

      const controller = new AnimationController(
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
      controllerRef.current = controller;

      callbacks.current.onReport({
        rig: describeRigBinding(inspectRigBinding(resolved.root)),
        bound: 0,
        total: 0,
        byBand: EMPTY_BANDS,
      });
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

  // --- the routine's stance -------------------------------------------------
  useEffect(() => {
    if (!body) return;
    const stance = drill.stance;
    controllerRef.current?.setStance(stance === null ? null : STANCES[stance].poses);
  }, [body, drill]);

  // --- what the hands hold --------------------------------------------------
  useEffect(() => {
    if (!body || !drill.stance) return;
    let disposed = false;
    const held: HeldProp[] = [];

    for (const slot of STANCES[drill.stance].slots) {
      const bone = body.bones[slot.socket as SocketId];
      if (!bone) continue;
      void (async () => {
        const object = await resolveProp(slot.prop as PropKey);
        if (disposed || !object) return;
        applyGrip(object, slot.prop, slot.socket, bone);
        bone.add(object);
        held.push({
          prop: slot.prop as PropKey,
          socket: slot.socket as SocketId,
          object,
          hand: bone,
        });
        callbacks.current.onEquipped?.([...held]);
      })();
    }

    return () => {
      disposed = true;
      for (const entry of held) entry.object.removeFromParent();
      callbacks.current.onEquipped?.([]);
    };
  }, [body, drill]);

  // --- apply the current step ------------------------------------------------
  useEffect(() => {
    const controller = controllerRef.current;
    if (!body || !controller || !step) return;

    elapsedRef.current = 0;
    cancelledRef.current = false;
    controller.setLocomotion(step.gait);

    if (!step.action) {
      callbacks.current.onStatus('ok');
      callbacks.current.onReport({
        rig: describeRigBinding(inspectRigBinding(body.root)),
        bound: 0,
        total: 0,
        byBand: EMPTY_BANDS,
      });
      return;
    }

    const clip = clipsRef.current.get(step.action);
    if (!clip) {
      callbacks.current.onStatus('no-clip');
      return;
    }

    const played = width === 'full'
      ? controller.playAbility(step.action, { upperBodyOnly: false })
      : controller.playAbility(step.action, {
        upperBodyOnly: true,
        // Above zero narrows the claim to the arms, leaving the lower spine to
        // the gait. See the width note in `drills.ts`.
        movement: width === 'arms' ? 0.8 : 0,
      });
    callbacks.current.onStatus(played ? 'ok' : 'refused');

    const binding = inspectClipBinding(clip, body.root);
    callbacks.current.onReport({
      rig: describeRigBinding(inspectRigBinding(body.root)),
      bound: binding.bound.length,
      total: binding.bound.length + binding.unbound.length,
      byBand: binding.byBand,
    });
  }, [body, step, width, replayToken]);

  // --- clock ----------------------------------------------------------------
  useFrame((_, delta) => {
    const controller = controllerRef.current;
    if (!controller) return;

    controller.mixer.timeScale = speed;
    controller.update(delta);

    if (!playing || !step) return;
    elapsedRef.current += delta;

    // Open the recovery window on time, so the NEXT step can cut in rather than
    // queue behind this one. Gameplay is meant to own ability timing, so the
    // drill goes through the same door the game would.
    if (
      step.cancelAfter !== undefined
      && !cancelledRef.current
      && elapsedRef.current >= step.cancelAfter / Math.max(speed, 0.05)
    ) {
      cancelledRef.current = true;
      controller.enterAbilityRecovery();
    }

    // Slowing playback has to stretch the dwell too, or half the routine cuts
    // away mid-clip the moment you slow it down to look at something.
    const clipLength = step.action
      ? clipsRef.current.get(step.action)?.duration ?? null
      : null;
    if (elapsedRef.current >= stepSeconds(step, clipLength) / Math.max(speed, 0.05)) {
      elapsedRef.current = 0;
      callbacks.current.onElapsed();
    }
  });

  return <group ref={groupRef} />;
}

/**
 * Every clip in every staged pack, by the name it carries in the file.
 *
 * Loaded here rather than handed in because the drill room has no catalog and
 * wants none — it is not browsing clips, it is running named ones.
 */
async function loadLibraryClips(): Promise<Map<string, THREE.AnimationClip>> {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
  const clips = new Map<string, THREE.AnimationClip>();
  try {
    const response = await fetch(`${base}/anim-lib/index.json`);
    if (!response.ok) return clips;
    const data = (await response.json()) as { libraries?: { file: string }[] };
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    await Promise.all(
      (data.libraries ?? []).map(async ({ file }) => {
        const gltf = await loader.loadAsync(`${base}/anim-lib/${file}`);
        for (const clip of gltf.animations) clips.set(clip.name, clip);
      }),
    );
  } catch {
    // No packs staged is a legitimate state; the room says so per step.
  }
  return clips;
}
