/**
 * The chain-audition panel's own bookkeeping, pulled out of `SandboxStage`'s
 * effects so it can be exercised without a controller, a body, or a frame
 * loop.
 *
 * Three real bugs shipped in the refs-inline version of this (goobreview on
 * PR #110, review rounds 2/3/5): the spec identity a fallback actually
 * started got lost across a later `advanceChain` call, `'ignored'` and
 * `'queued'` results never reached the panel because only the audible
 * motion gated the report, and a mode switch's fresh controller left the
 * OLD chain's status on screen. All three are the same shape of bug — this
 * object's idea of "what's running" drifting from what's actually true —
 * so they get one small, tested surface instead of three ad hoc ref resets
 * scattered across effects.
 */

import type { AbilityPlaybackOptions, ChainAdvanceResult, ChainSpec } from '../anim/AnimationController';

export type ChainAuditionResult = ChainAdvanceResult | 'started';

/** What actually happened, for the panel's "visible cancel-window feedback". */
export type ChainAuditionReport = {
  /** The clip currently audible on the overlay or override layer, if any. */
  activeMotion: string | null;
  /** Outcome of the most recent `startChain`/`advanceChain` call. */
  lastResult: ChainAuditionResult | null;
};

/** What the panel shows when nothing is running — the shape every reset produces. */
export const CHAIN_AUDITION_IDLE: ChainAuditionReport = { activeMotion: null, lastResult: null };

/** The minimal controller surface this needs — the real one and a test double both satisfy it. */
export type ChainCapableController = {
  startChain(chain: ChainSpec, options?: AbilityPlaybackOptions): boolean;
  advanceChain(chain: ChainSpec, options?: AbilityPlaybackOptions): ChainAdvanceResult;
};

/**
 * One chain audition's state, across however many `startChain`/`advanceChain`
 * calls and mode switches it lives through. Exists so `SandboxStage` has
 * exactly one place that decides "is this still the chain that's running"
 * and "has anything actually changed since I last told the panel" — both are
 * easy to get wrong ad hoc (see the module doc), and only need to be gotten
 * right once.
 */
export class ChainAuditionTracker {
  private spec: ChainSpec | null = null;
  private result: ChainAuditionResult | null = null;
  private reportedMotion: string | null | undefined = undefined;
  private reportedResult: ChainAuditionResult | null | undefined = undefined;

  /**
   * The spec identity `advanceChain` must be called against — `null` when
   * nothing is running. `advanceChain`'s own contract is identity, not
   * structural equality: this is the one place that identity is remembered,
   * so nothing downstream re-derives it (and gets it wrong) from scratch.
   */
  get activeSpec(): ChainSpec | null {
    return this.spec;
  }

  /**
   * Back to nothing running, nothing reported. Call this whenever the
   * controller a `startChain`/`advanceChain` would land on has been (or is
   * about to be) replaced by a new one that knows nothing about this chain —
   * a mode switch tearing down and rebuilding the controller is the one
   * `SandboxStage` hits today, but anything with the same shape (a body
   * change, a future re-mount) needs the same reset.
   */
  reset(): void {
    this.spec = null;
    this.result = null;
    this.reportedMotion = undefined;
    this.reportedResult = undefined;
  }

  /** Open a fresh chain from `spec.steps[0]`, remembering its identity only if it actually started. */
  start(controller: ChainCapableController, spec: ChainSpec, options?: AbilityPlaybackOptions): boolean {
    const started = controller.startChain(spec, options);
    this.spec = started ? spec : null;
    this.result = started ? 'started' : 'inactive';
    return started;
  }

  /** Ask the running chain to advance. `'inactive'` with nothing touched if there is no controller or no active spec. */
  advance(controller: ChainCapableController | null, options?: AbilityPlaybackOptions): ChainAdvanceResult {
    if (!controller || !this.spec) {
      this.result = 'inactive';
      return 'inactive';
    }
    const result = controller.advanceChain(this.spec, options);
    this.result = result;
    return result;
  }

  /**
   * Report to `onChainState` if EITHER the audible motion or the last result
   * changed since the previous report. Motion alone would drop two real
   * outcomes silently: an `'ignored'` advance plays nothing at all, ever,
   * and a `'queued'` one plays nothing until its window opens, later, on its
   * own — comparing both catches every case. Returns whether it reported.
   */
  maybeReport(activeMotion: string | null, onChainState: (report: ChainAuditionReport) => void): boolean {
    if (activeMotion === this.reportedMotion && this.result === this.reportedResult) return false;
    this.reportedMotion = activeMotion;
    this.reportedResult = this.result;
    onChainState({ activeMotion, lastResult: this.result });
    return true;
  }
}
