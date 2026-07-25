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
  type StanceKey,
} from '../content';
import type { CatalogEntry } from './catalog';
import { stepSeconds, type Drill } from './drills';

export type PlaybackMode = 'raw' | 'layered' | 'drill';

export type DrillStepStatus = 'ok' | 'no-clip' | 'refused';

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
  /**
   * Held pose worn under everything else, in layered mode.
   *
   * The reason this exists: a stance is the one thing the clip browser could
   * not show. Sword-and-board is composed from two clips, one per arm, and
   * whether that composition reads is not a question about either clip — so
   * auditioning them individually cannot answer it, and nothing else here does.
   */
  stance: StanceKey | null;
  /**
   * Routine to run, in drill mode. Its own stance overrides the one above,
   * because a drill is a whole loadout rather than a setting.
   */
  drill: Drill | null;
  /**
   * Every library clip by name, so a drill can fire clips nobody has bound yet
   * — which is most of what a drill is for.
   */
  clipsByName: ReadonlyMap<string, THREE.AnimationClip>;
  /**
   * Which step is running, and whether it actually started.
   *
   * The status is not decoration. A step that does not play looks exactly like
   * a bad animation — the character carries on doing the previous thing while
   * the label claims otherwise — and the two causes want different fixes, so
   * they are reported apart. `no-clip` means the name is wrong or the pack is
   * not staged; `refused` means the layer was still owned by the last action.
   */
  onDrillStep?: (index: number, status: DrillStepStatus) => void;
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
  stance,
  drill,
  clipsByName,
  onDrillStep,
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

  // Kept current in an effect rather than during render: a ref written while
  // rendering is a mutation React may discard or replay. Initialised from the
  // first value, so the mount effect below already has a usable callback.
  const reportRef = useRef(onReport);
  useEffect(() => {
    reportRef.current = onReport;
  });

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

    if (mode !== 'raw') {
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

  // --- library clips --------------------------------------------------------
  // A drill fires clips by their library name, most of which are bound to no
  // key at all — which is rather the point of running one.
  useEffect(() => {
    for (const [name, clip] of clipsByName) clipsRef.current.set(name, clip);
  }, [clipsByName]);

  // --- stance ---------------------------------------------------------------
  // Declared after the driver effect so the controller exists by the time this
  // runs, and keyed on `mode` as well, so a controller rebuilt by a mode switch
  // re-adopts the pose rather than standing there unarmed. A drill brings its
  // own, because a drill is a whole loadout rather than a setting.
  const activeStance = mode === 'drill' ? drill?.stance ?? null : stance;
  useEffect(() => {
    if (mode === 'raw') return;
    controllerRef.current?.setStance(
      activeStance === null ? null : STANCES[activeStance].poses,
    );
  }, [body, mode, activeStance]);

  // --- gait -----------------------------------------------------------------
  // Its own effect, not part of playback, so the gait runs with nothing
  // selected. A stance has to be judged against a walk as much as against an
  // attack — that is the entire claim a stance makes, that one pose covers idle
  // and walk and run — and requiring a clip selection to see one moving would
  // hide the half that matters. In drill mode the steps own the gait instead.
  useEffect(() => {
    if (mode !== 'layered') return;
    controllerRef.current?.setLocomotion(baseLocomotion ?? '');
  }, [body, mode, baseLocomotion]);

  // --- drill ----------------------------------------------------------------
  const drillRef = useRef({ index: -1, elapsed: 0 });
  const onDrillStepRef = useRef(onDrillStep);
  useEffect(() => {
    onDrillStepRef.current = onDrillStep;
  });

  // Start from the top whenever the routine or the body changes, so a run is
  // the same run every time and a step can be reported by its number.
  useEffect(() => {
    drillRef.current = { index: -1, elapsed: 0 };
  }, [body, mode, drill]);

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
      // The gait and the stance have their own effects; this one only fires the
      // action, so re-selecting a clip does not restart what it plays over.
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
  }, [body, entry, mode, bands, loop, speed, movement, playToken]);

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
    if (mode === 'raw') {
      mixerRef.current?.update(delta);
      return;
    }

    const controller = controllerRef.current;
    if (mode === 'drill' && drill && controller) {
      const state = drillRef.current;
      const current = drill.steps[state.index];
      const dwell = current
        ? stepSeconds(current, clipsByName.get(current.action ?? '')?.duration ?? null)
        : 0;

      state.elapsed += delta;
      if (state.index < 0 || state.elapsed >= dwell) {
        // Wraps, so a routine left running loops rather than ending on whatever
        // its last step happened to be.
        state.index = (state.index + 1) % drill.steps.length;
        state.elapsed = 0;

        const step = drill.steps[state.index];
        controller.setLocomotion(step.gait);

        let status: DrillStepStatus = 'ok';
        if (step.action) {
          const width = step.width ?? 'full';
          if (!clipsByName.has(step.action)) {
            status = 'no-clip';
          } else {
            const played = width === 'full'
              ? controller.playAbility(step.action, { upperBodyOnly: false })
              : controller.playAbility(step.action, {
                upperBodyOnly: true,
                // Above zero narrows the claim to the arms and leaves the lower
                // spine to the gait. See `drills.ts`.
                movement: width === 'arms' ? 0.8 : 0,
              });
            if (!played) status = 'refused';
          }
        }
        onDrillStepRef.current?.(state.index, status);
      }
    }

    controller?.update(delta);
  });

  return <group ref={groupRef} />;
}
