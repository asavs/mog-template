/**
 * The drill stage's own chain-playback bookkeeping, pulled out of
 * `DrillStage.tsx`'s step-apply effect so it can be exercised without a
 * controller, a body, or a frame loop.
 *
 * Four real bugs shipped in the refs-inline version of this across
 * goobreview's review of PR #110:
 *
 * - Round 1: manual step/scrub/fallback plays were silently refused — the
 *   hand-timed `cancelAfter` stopwatch this chain machinery replaced used to
 *   open the recovery window on its own clock, and nothing replaced that
 *   call for the direct `playAbility`/`startChain` sites.
 * - Round 2: after one out-of-sequence fallback, `advanceChain` was called
 *   against `step.chain.spec` (the authored original) forever after, even
 *   though the controller was actually tracking a sliced remainder —
 *   `advanceChain`'s own contract is identity, not structural equality.
 * - Round 4: a skip AHEAD within the correctly-identified, still-running
 *   chain (step 0 played, next click lands on step 2) passed the identity
 *   check and silently landed on step 1's clip while claiming step 2 had
 *   played — `advanceChain` always advances by exactly one and trusts the
 *   caller that the requested step really is next.
 * - Round 6: the round-4 fix compared step INDEX continuity but never spec
 *   IDENTITY, so switching from chain A (at index 0) directly to a
 *   DIFFERENT chain B's index 1 could pass the index check by coincidence
 *   (0 === 1 - 1) and advance chain A instead of falling back to start B.
 *
 * All four are the same shape of bug — this object's idea of "what chain is
 * actually running, and where in it" drifting from what's actually true —
 * so they get one small, tested surface instead of another inline ref patch
 * scheduling a fifth.
 */

import type { AbilityPlaybackOptions, ChainAdvanceResult, ChainSpec } from '../anim/AnimationController';

/** The minimal controller surface this needs — the real one and a test double both satisfy it. */
export type ChainCapableController = {
  enterAbilityRecovery(): void;
  playAbility(key: string, options?: AbilityPlaybackOptions): boolean;
  startChain(chain: ChainSpec, options?: AbilityPlaybackOptions): boolean;
  advanceChain(chain: ChainSpec, options?: AbilityPlaybackOptions): ChainAdvanceResult;
};

/** What a drill step asks the chain machinery for. `null` (or omitted) is a standalone action. */
export type DrillChainStep = {
  /** The authored spec this step belongs to — shared identity with every other step of the same combo. */
  spec: ChainSpec;
  /** This step's place in `spec.steps`. `0` is the opener. */
  index: number;
};

/**
 * One drill's worth of "what chain is running, and where in it" — across
 * however many steps, skips, and combo switches it lives through.
 */
export class DrillChainTracker {
  /**
   * The AUTHORED spec (`step.chain.spec`) the currently-running chain
   * belongs to — NOT necessarily what was actually handed to `startChain`
   * (see `running`). This is what makes the round-6 fix possible: two
   * different chains can have steps at the same index, so index continuity
   * alone can't tell them apart — only tracing back to the same authored
   * spec can.
   */
  private root: ChainSpec | null = null;
  /**
   * The exact spec identity `startChain` was actually given — `root` itself
   * when playing from its own opener, or a sliced remainder when a fallback
   * started partway through. `advanceChain` must be called against THIS,
   * per its own contract (identity, not structural equality) — this is the
   * round-2 fix.
   */
  private running: ChainSpec | null = null;
  /** The absolute (authored, `root`-relative) step index `running` is positioned at. */
  private index: number | null = null;

  /** Nothing running, nothing remembered — a standalone step, or a fresh controller. */
  reset(): void {
    this.root = null;
    this.running = null;
    this.index = null;
  }

  /**
   * Play whatever `chain` calls for `action` against: a standalone ability
   * (`chain` omitted), a fresh chain opener (`chain.index === 0`), a
   * sequential continuation of the chain already running, or — when none of
   * those apply — a fresh chain scoped to this step's remainder, so any step
   * is watchable on its own rather than silently refusing (round 1) or
   * misusing whatever unrelated chain happens to still be tracked
   * (round 6). Opens the recovery window itself before every direct play or
   * chain start: the drill has no gameplay clock of its own to open it on a
   * timer the way real gameplay does, so it opens it by hand — a no-op
   * unless something is actually still running on the layer this step
   * needs.
   */
  playStep(
    controller: ChainCapableController,
    action: string,
    chain: DrillChainStep | null,
    options: AbilityPlaybackOptions,
  ): boolean {
    if (!chain) {
      this.reset();
      controller.enterAbilityRecovery();
      return controller.playAbility(action, options);
    }

    if (chain.index === 0) {
      controller.enterAbilityRecovery();
      const played = controller.startChain(chain.spec, options);
      this.root = played ? chain.spec : null;
      this.running = played ? chain.spec : null;
      this.index = played ? 0 : null;
      return played;
    }

    // Sequential requires BOTH: the running chain traces back to the SAME
    // authored spec this step belongs to — not a coincidentally-adjacent
    // index on some unrelated chain (round 6) — AND this step really is the
    // very next one `advanceChain` would land on, not a skip (round 4).
    const sequential = this.root === chain.spec && this.index === chain.index - 1;
    const result = sequential && this.running
      ? controller.advanceChain(this.running, options)
      : 'inactive';

    if (result === 'advanced' || result === 'queued') {
      this.index = chain.index;
      return true;
    }

    // Not sequential — stepping here directly from the list, or scrubbing,
    // rather than arriving in sequence from its opener (or arriving from a
    // different chain entirely). Start a fresh chain scoped to the
    // remainder, and remember ITS identity (and the authored spec it traces
    // back to), so the next step in sequence resynchronises onto it instead
    // of falling back again.
    const remainder: ChainSpec = {
      steps: chain.spec.steps.slice(chain.index),
      cancelWindow: chain.spec.cancelWindow,
      outsideWindow: chain.spec.outsideWindow,
    };
    controller.enterAbilityRecovery();
    const played = controller.startChain(remainder, options);
    this.root = played ? chain.spec : null;
    this.running = played ? remainder : null;
    this.index = played ? chain.index : null;
    return played;
  }
}
