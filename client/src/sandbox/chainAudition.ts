/**
 * The chain-audition panel's own bookkeeping, pulled out of `SandboxStage`'s
 * effects so it can be exercised without a controller, a body, or a frame
 * loop.
 *
 * Four real bugs shipped in the ref-based versions of this (goobreview on
 * PR #110, review rounds 2/3/5/8): the spec identity a fallback actually
 * started got lost across a later `advanceChain` call, `'ignored'` and
 * `'queued'` results never reached the panel because only the audible
 * motion gated the report, a mode switch's fresh controller left the OLD
 * chain's status on screen, and — round 8, after the first extraction — the
 * "clear" button's picks-to-null transition (and, more generally, any
 * re-pick that changes the chain configuration without a mode switch) left
 * the tracker's own identity stale, because nothing told it to reset at
 * THAT particular lifecycle edge.
 *
 * That last one is what changed the design, not just the code: three
 * rounds fixed three different lifecycle edges (start, mode switch, clear)
 * one at a time, and there is no reason to believe those are the last
 * edges anyone will find. So this version does not require a caller to
 * remember to reset anything, ever, at any edge — every read or report
 * operation takes the CALLER'S CURRENT authored spec as an argument, and
 * internally treats a mismatch against its own remembered root spec
 * (including a transition to or from `null`) as "this session is over,"
 * resetting itself before doing anything else. A caller that forgets to
 * call `reset()` at some new edge nobody has thought of yet gets the
 * correct behavior anyway, because there is no edge this doesn't cover —
 * every operation re-validates identity against what's actually true right
 * now, not against what some earlier effect remembered to tell it.
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
 * calls, mode switches, clears, and re-picks it lives through. Owns SESSION
 * IDENTITY: every method that reads or reports takes the caller's current
 * authored spec (`currentSpec`) and treats a mismatch against its own
 * `root` — the spec `start` was actually given — as "no active session for
 * what's current right now," resetting first. See the module doc for why
 * this shape exists.
 */
export class ChainAuditionTracker {
  /** The authored spec identity `start` was actually given. `null` means no session. */
  private root: ChainSpec | null = null;
  /** The exact spec identity `startChain` was actually given — same as `root` today, but kept separate: a future fallback (mirroring `DrillChainTracker`'s remainder slicing) would diverge the two the same way it does there. */
  private running: ChainSpec | null = null;
  private result: ChainAuditionResult | null = null;
  private reportedMotion: string | null | undefined = undefined;
  private reportedResult: ChainAuditionResult | null | undefined = undefined;

  /**
   * Forget everything. Safe, but no longer load-bearing the way it used to
   * be: every method below calls this itself the moment it notices
   * `currentSpec` no longer matches `root`. Kept public for a belt-and-braces
   * call at a controller-recreation boundary (a mode switch tearing down and
   * rebuilding the `AnimationController` the tracker's `running` identity
   * refers to), and because an explicit "nothing is running, full stop" is
   * still a reasonable thing for a caller to want to say directly.
   */
  reset(): void {
    this.root = null;
    this.running = null;
    this.result = null;
    this.reportedMotion = undefined;
    this.reportedResult = undefined;
  }

  /** Reset if the caller has moved on to a different authored spec (including to/from no spec at all) since the last operation. */
  private syncRoot(currentSpec: ChainSpec | null): void {
    if (this.root !== currentSpec) this.reset();
  }

  /**
   * Open a fresh chain from `spec.steps[0]`. Always (re)establishes `spec`
   * as this session's root, whatever was tracked before — a deliberate
   * "start this now" always wins, the same way `enterAbilityRecovery`
   * always forces the recovery window open regardless of what it
   * interrupts.
   */
  start(controller: ChainCapableController, spec: ChainSpec, options?: AbilityPlaybackOptions): boolean {
    const started = controller.startChain(spec, options);
    this.root = started ? spec : null;
    this.running = started ? spec : null;
    this.result = started ? 'started' : 'inactive';
    return started;
  }

  /**
   * Ask the running chain to advance — but only if `currentSpec` is still
   * the spec this session's root actually is. A stale advance (the picks
   * changed since `start`, with no fresh click in between) reports
   * `'inactive'`, the same as no session at all, rather than misfiring
   * `advanceChain` against a chain the caller no longer means.
   */
  advance(
    controller: ChainCapableController | null,
    currentSpec: ChainSpec | null,
    options?: AbilityPlaybackOptions,
  ): ChainAdvanceResult {
    this.syncRoot(currentSpec);
    if (!controller || !this.running || this.root !== currentSpec) {
      this.result = 'inactive';
      return 'inactive';
    }
    const result = controller.advanceChain(this.running, options);
    this.result = result;
    return result;
  }

  /**
   * Report to `onChainState` if EITHER the audible motion or the last
   * result changed since the previous report — including the change FROM a
   * session to no session at all (`syncRoot` makes that explicit here,
   * rather than relying on a caller to have reset first at whatever edge
   * caused it). Motion alone would also drop two real outcomes silently: an
   * `'ignored'` advance plays nothing at all, ever, and a `'queued'` one
   * plays nothing until its window opens, later, on its own.
   *
   * Never reports for a spec that was never started at all (`currentSpec`
   * and `root` both `null`, and always have been) — a caller with nothing
   * configured yet gets silence, not a stream of idle reports it never
   * asked for. Returns whether it reported.
   */
  maybeReport(
    currentSpec: ChainSpec | null,
    activeMotion: string | null,
    onChainState: (report: ChainAuditionReport) => void,
  ): boolean {
    const hadRoot = this.root !== null;
    this.syncRoot(currentSpec);
    if (currentSpec === null && !hadRoot) return false;
    if (activeMotion === this.reportedMotion && this.result === this.reportedResult) return false;
    this.reportedMotion = activeMotion;
    this.reportedResult = this.result;
    onChainState({ activeMotion, lastResult: this.result });
    return true;
  }
}
