/**
 * `ChainAuditionTracker` covers the leak class that shipped four times in
 * `SandboxStage.tsx`'s bookkeeping for this (PR #110, goobreview review
 * rounds 2/3/5/8): a chain-fallback identity forgotten across a later call,
 * `'ignored'`/`'queued'` results never reaching the panel because only the
 * audible motion gated the report, a mode switch's fresh controller leaving
 * stale status on screen, and — round 8 — the "clear" button's picks-to-null
 * transition leaving the tracker's own identity stale because nothing told
 * it to reset at THAT particular edge.
 *
 * Rounds 2/3/5 get one test each, named for the round. Round 8 is the one
 * that changed the design (see chainAudition.ts's module doc): every
 * `advance`/`maybeReport` call now takes the CALLER'S current authored spec
 * and self-corrects against it, so there is no "forgot to reset at this
 * edge" left to find — a property test alongside the round-8 regression
 * test tries to say that generally, not just for the one edge that was
 * caught.
 */

import { describe, expect, it } from 'vitest';
import type { ChainAdvanceResult, ChainSpec } from '../anim/AnimationController';
import { CHAIN_AUDITION_IDLE, ChainAuditionTracker, type ChainCapableController } from './chainAudition';

type Call = { method: 'startChain' | 'advanceChain'; args: unknown[] };

/** A controller double that plays along with, or refuses, whatever the test wants. */
function mockController(opts: {
  startResult?: boolean;
  advanceResult?: ChainAdvanceResult;
} = {}): ChainCapableController & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    startChain: (...args) => {
      calls.push({ method: 'startChain', args });
      return opts.startResult ?? true;
    },
    advanceChain: (...args) => {
      calls.push({ method: 'advanceChain', args });
      return opts.advanceResult ?? 'advanced';
    },
  };
}

const JAB_CROSS: ChainSpec = {
  steps: ['jab', 'cross'],
  cancelWindow: { fromFraction: 0.5, toFraction: 1 },
};

const HOOK: ChainSpec = {
  steps: ['hook'],
  cancelWindow: { fromFraction: 0.5, toFraction: 1 },
};

describe('ChainAuditionTracker', () => {
  it('starts with nothing running — an advance against any spec is inactive', () => {
    const tracker = new ChainAuditionTracker();
    const controller = mockController();
    expect(tracker.advance(controller, JAB_CROSS)).toBe('inactive');
    expect(controller.calls).toHaveLength(0);
  });

  it('remembers the spec identity only when startChain actually succeeds', () => {
    const tracker = new ChainAuditionTracker();
    expect(tracker.start(mockController({ startResult: false }), JAB_CROSS)).toBe(false);

    const controller = mockController({ advanceResult: 'advanced' });
    // Nothing running after a failed start — advancing against JAB_CROSS is inactive.
    expect(tracker.advance(controller, JAB_CROSS)).toBe('inactive');
    expect(controller.calls).toHaveLength(0);

    expect(tracker.start(mockController({ startResult: true }), JAB_CROSS)).toBe(true);
    expect(tracker.advance(controller, JAB_CROSS)).toBe('advanced');
    expect(controller.calls).toHaveLength(1);
  });

  it('round 2 — advances against the SAME spec identity start gave it, not a freshly-built structural copy', () => {
    const tracker = new ChainAuditionTracker();
    const controller = mockController({ advanceResult: 'advanced' });
    tracker.start(controller, JAB_CROSS);

    tracker.advance(controller, JAB_CROSS);

    // The whole point of remembering identity: advanceChain's own contract is
    // identity, not structural equality (see AnimationController.advanceChain's
    // doc comment) — a caller that rebuilt an equivalent-looking spec object
    // per call, the way the drill's original fallback bug did, would silently
    // desync from whatever the controller is actually tracking.
    const call = controller.calls.find(c => c.method === 'advanceChain')!;
    expect(call.args[0]).toBe(JAB_CROSS);
  });

  it('reports "inactive" and touches nothing when advancing with no controller', () => {
    const tracker = new ChainAuditionTracker();
    tracker.start(mockController(), JAB_CROSS);
    expect(tracker.advance(null, JAB_CROSS)).toBe('inactive');
  });

  it('advancing against a DIFFERENT spec than what is running reports inactive, not a misfire', () => {
    const tracker = new ChainAuditionTracker();
    tracker.start(mockController(), JAB_CROSS);

    const controller = mockController({ advanceResult: 'advanced' });
    // HOOK was never started — this must not silently advance JAB_CROSS.
    expect(tracker.advance(controller, HOOK)).toBe('inactive');
    expect(controller.calls).toHaveLength(0);
  });

  it('round 5 — reset() clears the running chain, e.g. a mode-switch controller recreation', () => {
    const tracker = new ChainAuditionTracker();
    const controller = mockController();
    tracker.start(controller, JAB_CROSS);

    tracker.reset();

    // advancing against a DIFFERENT (freshly built) controller after a reset
    // must not silently resurrect the old chain.
    expect(tracker.advance(mockController(), JAB_CROSS)).toBe('inactive');
  });

  it('round 8 — advancing against a DIFFERENT spec self-corrects without an explicit reset()', () => {
    // The bug: SandboxStage.tsx's "clear" button (and, more generally, any
    // re-pick) changes the authored spec without a mode switch and without
    // calling `reset()` — nothing else in this test calls it either.
    const tracker = new ChainAuditionTracker();
    tracker.start(mockController(), JAB_CROSS);

    const controller = mockController({ advanceResult: 'advanced' });
    // The picks changed to HOOK (a fresh pick list, or the same tracker
    // instance after a clear-then-repick) with no explicit reset in between.
    expect(tracker.advance(controller, HOOK)).toBe('inactive');
    expect(controller.calls).toHaveLength(0);

    // HOOK now becomes the actual root once genuinely started.
    const started = tracker.start(controller, HOOK);
    expect(started).toBe(true);
    expect(tracker.advance(controller, HOOK)).toBe('advanced');
  });

  it('round 8 — maybeReport self-corrects to idle on a spec mismatch, with no explicit reset()', () => {
    const tracker = new ChainAuditionTracker();
    const controller = mockController();
    tracker.start(controller, JAB_CROSS);
    const reports: unknown[] = [];
    tracker.maybeReport(JAB_CROSS, 'jab', r => reports.push(r));
    expect(reports).toEqual([{ activeMotion: 'jab', lastResult: 'started' }]);

    // The picks were cleared (chainSpec -> null) — no reset() call here either.
    const reportedOnClear = tracker.maybeReport(null, 'jab', r => reports.push(r));
    expect(reportedOnClear).toBe(true);
    // Session is over: lastResult goes back to null even though the clip is
    // (truthfully) still reported as audible — nothing tracked is running
    // for the CURRENT (empty) picks any more.
    expect(reports.at(-1)).toEqual({ activeMotion: 'jab', lastResult: null });

    // Re-picking a DIFFERENT chain, again with no reset() call, correctly
    // starts from a clean slate rather than reporting JAB_CROSS's stale result.
    const startedHook = tracker.start(controller, HOOK);
    expect(startedHook).toBe(true);
    tracker.maybeReport(HOOK, 'hook', r => reports.push(r));
    expect(reports.at(-1)).toEqual({ activeMotion: 'hook', lastResult: 'started' });
  });

  it('property: a stale root never reports once the current spec has moved on', () => {
    // Not one specific edge (mode switch, clear, re-pick) but the general
    // claim the round-8 fix makes: whatever spec was last started, ANY
    // subsequent read against a DIFFERENT current spec (including null)
    // behaves as if nothing is running — never the stale one.
    const specs: (ChainSpec | null)[] = [JAB_CROSS, HOOK, null];
    for (const startedWith of specs) {
      for (const currentSpec of specs) {
        if (startedWith === currentSpec) continue;
        const tracker = new ChainAuditionTracker();
        if (startedWith) tracker.start(mockController(), startedWith);

        const controller = mockController({ advanceResult: 'advanced' });
        expect(tracker.advance(controller, currentSpec)).toBe('inactive');
        expect(controller.calls).toHaveLength(0);

        const reports: unknown[] = [];
        tracker.maybeReport(currentSpec, 'whatever-is-audible', r => reports.push(r));
        if (reports.length > 0) {
          expect(reports[0]).toMatchObject({ lastResult: null });
        }
      }
    }
  });

  describe('maybeReport', () => {
    it('reports when the motion changes', () => {
      const tracker = new ChainAuditionTracker();
      tracker.start(mockController(), JAB_CROSS);
      const reports: unknown[] = [];

      expect(tracker.maybeReport(JAB_CROSS, 'jab', r => reports.push(r))).toBe(true);
      expect(tracker.maybeReport(JAB_CROSS, 'jab', r => reports.push(r))).toBe(false);
      expect(tracker.maybeReport(JAB_CROSS, 'cross', r => reports.push(r))).toBe(true);
      expect(reports).toEqual([
        { activeMotion: 'jab', lastResult: 'started' },
        { activeMotion: 'cross', lastResult: 'started' },
      ]);
    });

    it("round 3 — reports an 'ignored' advance even though nothing audible changed", () => {
      // An ignored click plays nothing at all, ever — motion alone would
      // never notice it.
      const tracker = new ChainAuditionTracker();
      const controller = mockController({ advanceResult: 'ignored' });
      tracker.start(controller, JAB_CROSS);
      const reports: unknown[] = [];
      tracker.maybeReport(JAB_CROSS, 'jab', r => reports.push(r));

      tracker.advance(controller, JAB_CROSS); // still playing 'jab'; nothing to interrupt
      const reported = tracker.maybeReport(JAB_CROSS, 'jab', r => reports.push(r));

      expect(reported).toBe(true);
      expect(reports.at(-1)).toEqual({ activeMotion: 'jab', lastResult: 'ignored' });
    });

    it("round 3 — reports a 'queued' advance even though nothing audible changed yet", () => {
      const tracker = new ChainAuditionTracker();
      const controller = mockController({ advanceResult: 'queued' });
      tracker.start(controller, JAB_CROSS);
      const reports: unknown[] = [];
      tracker.maybeReport(JAB_CROSS, 'jab', r => reports.push(r));

      tracker.advance(controller, JAB_CROSS);
      const reported = tracker.maybeReport(JAB_CROSS, 'jab', r => reports.push(r));

      expect(reported).toBe(true);
      expect(reports.at(-1)).toEqual({ activeMotion: 'jab', lastResult: 'queued' });
    });

    it('does not report when neither motion nor result changed', () => {
      const tracker = new ChainAuditionTracker();
      tracker.start(mockController(), JAB_CROSS);
      const reports: unknown[] = [];
      tracker.maybeReport(JAB_CROSS, 'jab', r => reports.push(r));
      tracker.maybeReport(JAB_CROSS, 'jab', r => reports.push(r));
      tracker.maybeReport(JAB_CROSS, 'jab', r => reports.push(r));
      expect(reports).toHaveLength(1);
    });

    it('never reports for a spec that was never started — no report spam on an untouched panel', () => {
      const tracker = new ChainAuditionTracker();
      const reports: unknown[] = [];
      tracker.maybeReport(null, null, r => reports.push(r));
      tracker.maybeReport(null, null, r => reports.push(r));
      expect(reports).toHaveLength(0);
    });
  });

  it('a fallback chain (a different spec, e.g. a sliced remainder) replaces the tracked identity outright', () => {
    const tracker = new ChainAuditionTracker();
    tracker.start(mockController(), JAB_CROSS);

    tracker.start(mockController(), HOOK);
    const controller = mockController({ advanceResult: 'advanced' });
    expect(tracker.advance(controller, HOOK)).toBe('advanced');
  });
});

describe('CHAIN_AUDITION_IDLE', () => {
  it('is the shape every idle report matches — nothing running, nothing to say', () => {
    expect(CHAIN_AUDITION_IDLE).toEqual({ activeMotion: null, lastResult: null });
  });
});
