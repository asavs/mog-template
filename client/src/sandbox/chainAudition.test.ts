/**
 * `ChainAuditionTracker` covers the leak class that shipped three times in
 * `SandboxStage.tsx`'s inline ref version of this bookkeeping (PR #110,
 * goobreview review rounds 2/3/5): a chain-fallback identity forgotten
 * across a later call, `'ignored'`/`'queued'` results never reaching the
 * panel because only the audible motion gated the report, and a mode
 * switch's fresh controller leaving stale status on screen. One test per
 * shipped bug, plus the surrounding contract.
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
  it('starts with nothing running', () => {
    const tracker = new ChainAuditionTracker();
    expect(tracker.activeSpec).toBeNull();
  });

  it('remembers the spec identity only when startChain actually succeeds', () => {
    const tracker = new ChainAuditionTracker();
    expect(tracker.start(mockController({ startResult: false }), JAB_CROSS)).toBe(false);
    expect(tracker.activeSpec).toBeNull();

    expect(tracker.start(mockController({ startResult: true }), JAB_CROSS)).toBe(true);
    expect(tracker.activeSpec).toBe(JAB_CROSS);
  });

  it('advances against the SAME spec identity start gave it — not a freshly-built structural copy', () => {
    const tracker = new ChainAuditionTracker();
    const controller = mockController({ advanceResult: 'advanced' });
    tracker.start(controller, JAB_CROSS);

    tracker.advance(controller);

    // The whole point of remembering identity: advanceChain's own contract is
    // identity, not structural equality (see AnimationController.advanceChain's
    // doc comment) — a caller that rebuilt an equivalent-looking spec object
    // per call, the way the drill's original fallback bug did, would silently
    // desync from whatever the controller is actually tracking.
    const call = controller.calls.find(c => c.method === 'advanceChain')!;
    expect(call.args[0]).toBe(JAB_CROSS);
  });

  it('reports "inactive" and touches nothing when advancing with no active spec', () => {
    const tracker = new ChainAuditionTracker();
    const controller = mockController();
    expect(tracker.advance(controller)).toBe('inactive');
    expect(controller.calls).toHaveLength(0);
    expect(tracker.activeSpec).toBeNull();
  });

  it('reports "inactive" and touches nothing when advancing with no controller', () => {
    const tracker = new ChainAuditionTracker();
    tracker.start(mockController(), JAB_CROSS);
    expect(tracker.advance(null)).toBe('inactive');
  });

  it('reset() clears the running chain — the mode-switch bug', () => {
    // SandboxStage.tsx rebuilds a brand-new AnimationController on every
    // mode switch (layered <-> raw); the OLD controller's chain is gone, but
    // nothing told the tracker until this reset existed — reviewer round 5.
    const tracker = new ChainAuditionTracker();
    const controller = mockController();
    tracker.start(controller, JAB_CROSS);
    expect(tracker.activeSpec).toBe(JAB_CROSS);

    tracker.reset();

    expect(tracker.activeSpec).toBeNull();
    // advancing against a DIFFERENT (freshly built) controller after a reset
    // must not silently resurrect the old chain.
    expect(tracker.advance(mockController())).toBe('inactive');
  });

  it('reset() clears whatever was last reported too, so the next report always fires', () => {
    const tracker = new ChainAuditionTracker();
    const reports: unknown[] = [];
    tracker.start(mockController(), JAB_CROSS);
    tracker.maybeReport('jab', report => reports.push(report));
    expect(reports).toHaveLength(1);

    tracker.reset();
    tracker.start(mockController(), JAB_CROSS);
    // Same motion string as before the reset — without the reset clearing
    // `reportedMotion` too, this would be mistaken for "nothing changed"
    // and silently dropped.
    tracker.maybeReport('jab', report => reports.push(report));
    expect(reports).toHaveLength(2);
  });

  describe('maybeReport', () => {
    it('reports when the motion changes', () => {
      const tracker = new ChainAuditionTracker();
      tracker.start(mockController(), JAB_CROSS);
      const reports: unknown[] = [];

      expect(tracker.maybeReport('jab', r => reports.push(r))).toBe(true);
      expect(tracker.maybeReport('jab', r => reports.push(r))).toBe(false);
      expect(tracker.maybeReport('cross', r => reports.push(r))).toBe(true);
      expect(reports).toEqual([
        { activeMotion: 'jab', lastResult: 'started' },
        { activeMotion: 'cross', lastResult: 'started' },
      ]);
    });

    it("reports an 'ignored' advance even though nothing audible changed", () => {
      // The exact shape of the bug from review round 3: an ignored click
      // plays nothing at all, ever — motion alone would never notice it.
      const tracker = new ChainAuditionTracker();
      const controller = mockController({ advanceResult: 'ignored' });
      tracker.start(controller, JAB_CROSS);
      const reports: unknown[] = [];
      tracker.maybeReport('jab', r => reports.push(r));

      tracker.advance(controller); // still playing 'jab'; nothing to interrupt
      const reported = tracker.maybeReport('jab', r => reports.push(r));

      expect(reported).toBe(true);
      expect(reports.at(-1)).toEqual({ activeMotion: 'jab', lastResult: 'ignored' });
    });

    it("reports a 'queued' advance even though nothing audible changed yet", () => {
      const tracker = new ChainAuditionTracker();
      const controller = mockController({ advanceResult: 'queued' });
      tracker.start(controller, JAB_CROSS);
      const reports: unknown[] = [];
      tracker.maybeReport('jab', r => reports.push(r));

      tracker.advance(controller);
      const reported = tracker.maybeReport('jab', r => reports.push(r));

      expect(reported).toBe(true);
      expect(reports.at(-1)).toEqual({ activeMotion: 'jab', lastResult: 'queued' });
    });

    it('does not report when neither motion nor result changed', () => {
      const tracker = new ChainAuditionTracker();
      tracker.start(mockController(), JAB_CROSS);
      const reports: unknown[] = [];
      tracker.maybeReport('jab', r => reports.push(r));
      tracker.maybeReport('jab', r => reports.push(r));
      tracker.maybeReport('jab', r => reports.push(r));
      expect(reports).toHaveLength(1);
    });
  });

  it('a fallback chain (a different spec, e.g. a sliced remainder) replaces the tracked identity outright', () => {
    const tracker = new ChainAuditionTracker();
    tracker.start(mockController(), JAB_CROSS);
    expect(tracker.activeSpec).toBe(JAB_CROSS);

    tracker.start(mockController(), HOOK);
    expect(tracker.activeSpec).toBe(HOOK);
  });
});

describe('CHAIN_AUDITION_IDLE', () => {
  it('is the shape every reset reports — nothing running, nothing to say', () => {
    expect(CHAIN_AUDITION_IDLE).toEqual({ activeMotion: null, lastResult: null });
  });
});
