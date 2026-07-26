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
 *
 * Two more auditions live in LAYERED mode, both driving the same controller
 * rather than a parallel one: PHASED fires `playPhased` directly against three
 * picked clips (only `held` is required, matching the mechanism itself), and
 * CHAIN builds a `ChainSpec` from an ordered pick of clips and fires it through
 * `startChain` / `advanceChain` — the same two calls a drill combo goes
 * through, just assembled from whatever is selected rather than written by
 * hand in `drills.ts`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { AnimationController, maskClipToBands, type AnimationBand } from '../anim';
import type {
  AbilityPlaybackOptions,
  ChainSpec,
  PhasedRuleNames,
} from '../anim/AnimationController';
import { CHAIN_AUDITION_IDLE, ChainAuditionTracker, type ChainAuditionReport } from './chainAudition';
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

/**
 * `playPhased`'s generic (non-guard) rule triplet — see `anim/config.ts`'s
 * `holdEnter` / `holdHeld` / `holdExit`, already built for exactly this: a
 * hold-capable caller that is not guard and has no reason to share its
 * dedicated priority.
 */
const PHASE_RULES: PhasedRuleNames = { enter: 'holdEnter', held: 'holdHeld', exit: 'holdExit' };

/** What the phased-audition panel asks the stage to play. */
export type PhasedAudition = {
  enter: CatalogEntry | null;
  held: CatalogEntry;
  exit: CatalogEntry | null;
  /** Mirrors `playPhased`'s `desired`: true holds, false releases. */
  desired: boolean;
};

/** What the chain-audition panel asks the stage to play. */
export type ChainAudition = {
  /** Picked in order; `steps[0]` is the opener. */
  steps: readonly CatalogEntry[];
  cancelWindow: { fromFraction: number; toFraction: number };
  outsideWindow: 'queue' | 'ignore';
  /** Bump to (re)start the chain from `steps[0]`. */
  startToken: number;
  /** Bump to ask the running chain to advance. */
  advanceToken: number;
};

/**
 * What actually happened, for the panel's "visible cancel-window feedback".
 * An alias, not a fresh shape — `chainAudition.ts` owns the real definition
 * (`ChainAuditionReport`) so the tracker and its consumers can never drift.
 */
export type ChainAuditionState = ChainAuditionReport;

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
  /**
   * Held pose worn under everything else, in layered mode.
   *
   * The reason this exists: a stance is the one thing the clip browser could
   * not show. Sword-and-board is composed from two clips, one per arm, and
   * whether that composition reads is not a question about either clip — so
   * auditioning them individually cannot answer it, and nothing else here does.
   */
  stance: StanceKey | null;
  /** Fraction of move speed the action permits; narrows the overlay above 0. */
  movement: number;
  rightHand: PropKey | null;
  leftHand: PropKey | null;
  /** Bump to replay the current selection from the top. */
  playToken: number;
  onReport: (report: StageReport) => void;
  /** Phased-motion audition, independent of `entry`. Layered mode only. */
  phased?: PhasedAudition | null;
  /** Chain audition, independent of `entry`. Layered mode only. */
  chain?: ChainAudition | null;
  onChainState?: (state: ChainAuditionState) => void;
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
  movement,
  rightHand,
  leftHand,
  playToken,
  onReport,
  phased = null,
  chain = null,
  onChainState,
}: SandboxStageProps) {
  const groupRef = useRef<THREE.Group>(null);
  const [body, setBody] = useState<ResolvedBody | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const controllerRef = useRef<AnimationController | null>(null);
  /** Every clip the controller can resolve, by key or by catalog id. */
  const clipsRef = useRef(new Map<string, THREE.AnimationClip>());
  /** The chain audition's own bookkeeping — see `chainAudition.ts`. */
  const chainTrackerRef = useRef(new ChainAuditionTracker());

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
    // Belt-and-braces: `ChainAuditionTracker` no longer NEEDS this (every
    // operation re-validates its own session identity against the current
    // authored spec — see chainAudition.ts), but a mode switch tearing down
    // the controller and building a fresh one is real enough, and immediate
    // enough, that saying so explicitly costs nothing.
    chainTrackerRef.current.reset();
    onChainState?.(CHAIN_AUDITION_IDLE);

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
    // `onChainState` deliberately excluded — it is `setChainState`, stable
    // across renders, and re-running this effect on its identity would tear
    // down and rebuild the controller for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, mode]);

  // --- stance ---------------------------------------------------------------
  // Declared after the driver effect so the controller exists by the time this
  // runs, and keyed on `mode` as well, so a controller rebuilt by a mode switch
  // re-adopts the pose rather than standing there unarmed.
  useEffect(() => {
    if (mode !== 'layered') return;
    controllerRef.current?.setStance(stance === null ? null : STANCES[stance].poses);
  }, [body, mode, stance]);

  // --- gait -----------------------------------------------------------------
  // Its own effect, not part of playback, so the gait runs with nothing
  // selected. A stance has to be judged against a walk as much as against an
  // attack — that is the entire claim a stance makes, that one pose covers idle
  // and walk and run — and requiring a clip selection to see one moving would
  // hide the half that matters.
  useEffect(() => {
    if (mode !== 'layered') return;
    controllerRef.current?.setLocomotion(baseLocomotion ?? '');
  }, [body, mode, baseLocomotion]);

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

  // --- phased audition -------------------------------------------------------
  // Independent of `entry`: this drives the SAME controller through
  // `playPhased`, with its own three picks, so it can run alongside — or
  // instead of — whatever the browser has selected.
  const phaseEnterId = phased?.enter?.id ?? null;
  const phaseHeldId = phased?.held.id ?? null;
  const phaseExitId = phased?.exit?.id ?? null;
  const phaseDesired = phased?.desired ?? false;
  useEffect(() => {
    if (mode !== 'layered') return;
    const controller = controllerRef.current;
    if (!controller) return;

    if (!phased) {
      // The Held picker resolving back to NONE (or the panel deselecting a
      // phase some other way) must actually tell the controller to release
      // it — returning here and doing nothing would leave whatever was held
      // looping on the rig forever, since nothing else will ever ask it to
      // stop. `held` is required by `PhasedKeys`, but `desired: false`'s own
      // release path (`playPhased`'s exit branch) never reads it — only
      // `ruleNames`, to recognise the overlay as this phase's — so an empty
      // key is safe here.
      controller.playPhased(false, { held: '' }, PHASE_RULES);
      return;
    }

    for (const source of [phased.enter, phased.held, phased.exit]) {
      if (source) clipsRef.current.set(source.id, source.clip);
    }
    controller.playPhased(
      phased.desired,
      { enter: phased.enter?.id, held: phased.held.id, exit: phased.exit?.id },
      PHASE_RULES,
    );
    // Dependencies are the picked ids and the toggle, not `phased` itself — a
    // fresh object every render would otherwise re-fire this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, mode, phaseEnterId, phaseHeldId, phaseExitId, phaseDesired]);

  // --- chain audition ---------------------------------------------------------
  // Two triggers rather than one continuous prop, because `startChain` and
  // `advanceChain` are two different calls with two different meanings — a
  // bumped `startToken` opens a fresh chain from `steps[0]`, a bumped
  // `advanceToken` asks the one already running to continue.
  //
  // `chainSpec` is the CURRENT authored spec — the one argument every
  // `ChainAuditionTracker` operation below takes, so it can tell for itself
  // whether it's still talking about the same session (see chainAudition.ts).
  // Memoized on the pick list and window VALUES rather than built inline in
  // the start effect: `chain` itself (Sandbox.tsx's `chainAudition`) is a
  // fresh object on every start/advance click (its own `useMemo` deps
  // include both tokens), so using `chain` directly here would look like a
  // "new spec" on every click even when the picks never changed — this stays
  // referentially stable across exactly those clicks, changing only when the
  // audition itself actually changes.
  const chainOptions: AbilityPlaybackOptions = { upperBodyOnly: bands !== null, movement };
  const chainSpec: ChainSpec | null = useMemo(() => {
    if (!chain || chain.steps.length === 0) return null;
    return {
      steps: chain.steps.map(source => source.id),
      cancelWindow: chain.cancelWindow,
      outsideWindow: chain.outsideWindow,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain?.steps, chain?.cancelWindow.fromFraction, chain?.cancelWindow.toFraction, chain?.outsideWindow]);

  useEffect(() => {
    if (mode !== 'layered' || !chain || !chainSpec || chain.startToken === 0) return;
    const controller = controllerRef.current;
    if (!controller) return;

    for (const source of chain.steps) clipsRef.current.set(source.id, source.clip);
    // The sandbox has no gameplay clock to open this window on its own timing
    // (unlike `animBridge`'s real Recovery row); a chain audition is a
    // deliberate "start this now" click, so it opens the window itself —
    // a no-op unless a standard clip or a previous chain is still audible.
    controller.enterAbilityRecovery();
    chainTrackerRef.current.start(controller, chainSpec, chainOptions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, mode, chain?.startToken]);

  useEffect(() => {
    if (mode !== 'layered' || !chain || chain.advanceToken === 0) return;
    chainTrackerRef.current.advance(controllerRef.current, chainSpec, chainOptions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, chain?.advanceToken]);

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
    if (mode !== 'layered') {
      mixerRef.current?.update(delta);
      return;
    }
    const controller = controllerRef.current;
    controller?.update(delta);

    // The "visible cancel-window feedback" a chain audition promises: report
    // whenever what is actually audible changes, not only on the click that
    // requested it — a QUEUED advance fires later, on its own, once the
    // window the request was waiting for actually opens. Just hands the
    // CURRENT authored spec to the tracker every frame — no gate on "is
    // there an active session" needed here any more, `maybeReport` decides
    // that for itself against `chainSpec`, and correctly reports the
    // transition to idle the instant the picks change out from under it,
    // whether or not anything remembered to say so first.
    if (onChainState) {
      const state = controller?.getState();
      const activeMotion = state?.overlayMotion ?? state?.overrideMotion ?? null;
      chainTrackerRef.current.maybeReport(chainSpec, activeMotion, onChainState);
    }
  });

  return <group ref={groupRef} />;
}
