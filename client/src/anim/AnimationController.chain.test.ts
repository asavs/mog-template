/**
 * The chain mechanism: an ordered attack run as data, replacing the drill's
 * hand-timed `cancelAfter` stopwatches. `startChain` plays the opener;
 * `advanceChain` asks to move to the next step, and the controller — not the
 * caller — decides whether that lands as a crossfade, a queued advance, or
 * nothing, based on where playback actually is in the current step's clip.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MOG_BONES } from '../content/rig';
import { AnimationController, type ChainSpec } from './AnimationController';
import { maskClipToOverlay } from './mask';

function clip(name: string, duration: number): THREE.AnimationClip {
  return new THREE.AnimationClip(name, duration, [
    new THREE.VectorKeyframeTrack(
      `${MOG_BONES.spine2}.position`,
      [0, duration],
      [0, 0, 0, 1, 0, 0],
    ),
  ]);
}

function rig(): THREE.Object3D {
  const root = new THREE.Group();
  for (const name of [MOG_BONES.spine2, MOG_BONES.spine, MOG_BONES.leftUpperLeg]) {
    const bone = new THREE.Bone();
    bone.name = name;
    root.add(bone);
  }
  return root;
}

const CLIPS = [
  clip('jab', 0.4),
  clip('cross', 0.4),
  clip('hook', 0.4),
];

function controllerWithChain(): AnimationController {
  const byName = new Map(CLIPS.map(value => [value.name, value]));
  return new AnimationController(rig(), key => byName.get(key) ?? null);
}

function settle(controller: AnimationController, seconds: number): void {
  const step = 1 / 120;
  for (let elapsed = 0; elapsed < seconds; elapsed += step) controller.update(step);
}

/** Window covers the back half of each 0.4s step: 0.2s to 0.4s. */
const JAB_CROSS_HOOK: ChainSpec = {
  steps: ['jab', 'cross', 'hook'],
  cancelWindow: { fromFraction: 0.5, toFraction: 1 },
};

describe('chain', () => {
  it('plays the opener', () => {
    const controller = controllerWithChain();
    expect(controller.startChain(JAB_CROSS_HOOK)).toBe(true);
    expect(controller.getState().overlayMotion).toBe('jab');
  });

  it('advances to the next step inside the cancel window', () => {
    const controller = controllerWithChain();
    controller.startChain(JAB_CROSS_HOOK);
    settle(controller, 0.25); // 0.25 / 0.4 = 0.625, inside [0.5, 1]

    expect(controller.advanceChain(JAB_CROSS_HOOK)).toBe('advanced');
    expect(controller.getState().overlayMotion).toBe('cross');
  });

  it('ignores an advance requested before the cancel window opens', () => {
    const controller = controllerWithChain();
    controller.startChain(JAB_CROSS_HOOK);
    settle(controller, 0.05); // 0.05 / 0.4 = 0.125, before 0.5

    expect(controller.advanceChain(JAB_CROSS_HOOK)).toBe('ignored');
    expect(controller.getState().overlayMotion).toBe('jab');
  });

  it('ignores an advance requested after the cancel window closes but before the clip ends', () => {
    // A narrower window than the other cases so there is daylight between
    // "past the window" and "the clip is over" — settling all the way to the
    // clip's own end would confuse the two (a finished clip clears the chain
    // outright, which is a different, separately-covered outcome).
    const narrowWindow: ChainSpec = {
      steps: ['jab', 'cross', 'hook'],
      cancelWindow: { fromFraction: 0.3, toFraction: 0.6 },
    };
    const controller = controllerWithChain();
    controller.startChain(narrowWindow);
    settle(controller, 0.35); // 0.35 / 0.4 = 0.875, past 0.6 but jab is still running

    expect(controller.advanceChain(narrowWindow)).toBe('ignored');
    expect(controller.getState().overlayMotion).toBe('jab');
  });

  it('reports inactive once the current step finishes on its own, unadvanced', () => {
    // Nothing chain-specific happens when a step finishes without being
    // advanced — it clears via the ordinary ability-finish path, same as any
    // standalone `playAbility` call. A stale chain reference must not let a
    // later `advanceChain` misfire into whatever comes after.
    const controller = controllerWithChain();
    controller.startChain(JAB_CROSS_HOOK);
    settle(controller, 0.5); // past the 0.4s clip; it has finished and cleared

    expect(controller.getState().overlayMotion).toBeNull();
    expect(controller.advanceChain(JAB_CROSS_HOOK)).toBe('inactive');
  });

  it('queues an early advance and fires it once the window opens, under outsideWindow: "queue"', () => {
    const queueing: ChainSpec = { ...JAB_CROSS_HOOK, outsideWindow: 'queue' };
    const controller = controllerWithChain();
    controller.startChain(queueing);
    settle(controller, 0.05); // well before the window

    expect(controller.advanceChain(queueing)).toBe('queued');
    expect(controller.getState().overlayMotion).toBe('jab');

    // Drive playback into the window without any further explicit call —
    // `update()` itself consumes the queued advance.
    settle(controller, 0.2); // now at ~0.25s, 0.625 of the clip
    expect(controller.getState().overlayMotion).toBe('cross');
  });

  it('blends into a repeated step instead of hard-cutting', () => {
    // steps[0] and steps[1] are the SAME clip — the self-chain case a double
    // jab already had to solve for `playAbility`. The chain mechanism must not
    // reintroduce the hard cut by resetting the outgoing action.
    const repeat: ChainSpec = {
      steps: ['jab', 'jab', 'cross'],
      cancelWindow: { fromFraction: 0.5, toFraction: 1 },
    };
    const controller = controllerWithChain();
    controller.startChain(repeat);
    settle(controller, 0.25);

    const outgoing = controller.mixer.existingAction(
      maskClipToOverlay(CLIPS.find(c => c.name === 'jab')!, 'torso'),
    );
    const reachedBeforeAdvance = outgoing!.time;
    expect(reachedBeforeAdvance).toBeGreaterThan(0);

    expect(controller.advanceChain(repeat)).toBe('advanced');

    // The outgoing action keeps its place and fades from there; reset to zero
    // would mean it got reused as the incoming one, which is the hard cut.
    expect(outgoing!.time).toBeCloseTo(reachedBeforeAdvance);
    expect(controller.getState().overlayMotion).toBe('jab');
  });

  it('reports inactive when asked to advance past the last step', () => {
    const controller = controllerWithChain();
    controller.startChain(JAB_CROSS_HOOK);
    settle(controller, 0.25);
    controller.advanceChain(JAB_CROSS_HOOK);
    settle(controller, 0.25);
    controller.advanceChain(JAB_CROSS_HOOK);
    expect(controller.getState().overlayMotion).toBe('hook');

    expect(controller.advanceChain(JAB_CROSS_HOOK)).toBe('inactive');
    expect(controller.getState().overlayMotion).toBe('hook');
  });

  it('reports inactive when no chain is running, or a different one is', () => {
    const controller = controllerWithChain();
    expect(controller.advanceChain(JAB_CROSS_HOOK)).toBe('inactive');

    const other: ChainSpec = {
      steps: ['jab', 'cross'],
      cancelWindow: { fromFraction: 0.5, toFraction: 1 },
    };
    controller.startChain(JAB_CROSS_HOOK);
    expect(controller.advanceChain(other)).toBe('inactive');
    expect(controller.getState().overlayMotion).toBe('jab');
  });

  it('does not start when the opening step has no clip', () => {
    const controller = controllerWithChain();
    const missing: ChainSpec = {
      steps: ['missing', 'cross'],
      cancelWindow: { fromFraction: 0.5, toFraction: 1 },
    };
    expect(controller.startChain(missing)).toBe(false);
    expect(controller.getState().overlayMotion).toBeNull();
  });
});
