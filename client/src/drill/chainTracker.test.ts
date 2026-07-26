/**
 * `DrillChainTracker` covers the leak class that shipped four times in
 * `DrillStage.tsx`'s inline ref version of this decision (PR #110,
 * goobreview review rounds 1/2/4/6): the recovery window never opened for
 * manual/fallback plays, a fallback's sliced-spec identity got lost across a
 * later `advanceChain` call, a skip AHEAD within the correctly-identified
 * running chain silently landed on the wrong step, and — the round-6 finding
 * that closed this file's own round-4 fix — an index-only sequential check
 * couldn't tell two DIFFERENT chains with steps at the same index apart. One
 * (or more) tests per shipped bug, named for the round that found it, plus
 * the surrounding contract.
 */

import { describe, expect, it } from 'vitest';
import type { ChainAdvanceResult, ChainSpec } from '../anim/AnimationController';
import { DrillChainTracker, type ChainCapableController } from './chainTracker';

type Call = { method: string; args: unknown[] };

/** A controller double that plays along with, or refuses, whatever the test wants. */
function mockController(opts: {
  playResult?: boolean;
  startResult?: boolean;
  advanceResult?: ChainAdvanceResult;
} = {}): ChainCapableController & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    enterAbilityRecovery: (...args) => {
      calls.push({ method: 'enterAbilityRecovery', args });
    },
    playAbility: (...args) => {
      calls.push({ method: 'playAbility', args });
      return opts.playResult ?? true;
    },
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

const SWORD_CHAIN: ChainSpec = {
  steps: ['sword_a', 'sword_b', 'sword_c'],
  cancelWindow: { fromFraction: 0.5, toFraction: 1 },
  outsideWindow: 'queue',
};

const PUNCH_CHAIN: ChainSpec = {
  steps: ['jab', 'cross', 'hook'],
  cancelWindow: { fromFraction: 0.5, toFraction: 1 },
  outsideWindow: 'queue',
};

describe('DrillChainTracker', () => {
  describe('standalone steps (no chain)', () => {
    it('opens the recovery window and plays directly', () => {
      const tracker = new DrillChainTracker();
      const controller = mockController();

      const played = tracker.playStep(controller, 'act_drink', null, {});

      expect(played).toBe(true);
      expect(controller.calls.map(c => c.method)).toEqual(['enterAbilityRecovery', 'playAbility']);
      expect(controller.calls[1].args[0]).toBe('act_drink');
    });

    it('clears any chain being tracked', () => {
      const tracker = new DrillChainTracker();
      tracker.playStep(mockController(), 'sword_a', { spec: SWORD_CHAIN, index: 0 }, {});

      tracker.playStep(mockController(), 'act_drink', null, {});

      // A later step continuing SWORD_CHAIN must not find anything to
      // advance against — the standalone step in between ended it.
      const controller = mockController();
      const played = tracker.playStep(controller, 'sword_b', { spec: SWORD_CHAIN, index: 1 }, {});
      expect(controller.calls.map(c => c.method)).not.toContain('advanceChain');
      expect(played).toBe(true); // falls back to a fresh remainder instead
    });

    it('reports refused when playAbility itself refuses', () => {
      const tracker = new DrillChainTracker();
      const controller = mockController({ playResult: false });
      expect(tracker.playStep(controller, 'act_drink', null, {})).toBe(false);
    });
  });

  describe('round 1 — recovery window opened before every direct play or chain start', () => {
    it('opens it before a chain opener', () => {
      const tracker = new DrillChainTracker();
      const controller = mockController();
      tracker.playStep(controller, 'sword_a', { spec: SWORD_CHAIN, index: 0 }, {});
      expect(controller.calls.map(c => c.method)).toEqual(['enterAbilityRecovery', 'startChain']);
    });

    it('opens it before an out-of-sequence fallback start', () => {
      const tracker = new DrillChainTracker();
      // Nothing started yet — index 1 with no prior opener falls straight to fallback.
      const controller = mockController();
      tracker.playStep(controller, 'sword_b', { spec: SWORD_CHAIN, index: 1 }, {});
      expect(controller.calls.map(c => c.method)).toEqual(['enterAbilityRecovery', 'startChain']);
    });

    it('does NOT re-open it before a sequential advance — advanceChain/fireNextChainStep already owns that', () => {
      const tracker = new DrillChainTracker();
      const controller = mockController();
      tracker.playStep(controller, 'sword_a', { spec: SWORD_CHAIN, index: 0 }, {});
      controller.calls.length = 0;

      tracker.playStep(controller, 'sword_b', { spec: SWORD_CHAIN, index: 1 }, {});

      expect(controller.calls.map(c => c.method)).toEqual(['advanceChain']);
    });
  });

  describe('round 2 — advanceChain called against the RUNNING identity, not the authored one', () => {
    it('advances against the exact spec object a fallback actually started', () => {
      const tracker = new DrillChainTracker();
      // Land directly on index 1 with nothing running: triggers the
      // remainder fallback, which slices a NEW spec object distinct from
      // SWORD_CHAIN itself.
      tracker.playStep(mockController(), 'sword_b', { spec: SWORD_CHAIN, index: 1 }, {});

      const controller = mockController();
      tracker.playStep(controller, 'sword_c', { spec: SWORD_CHAIN, index: 2 }, {});

      const call = controller.calls.find(c => c.method === 'advanceChain')!;
      // NOT SWORD_CHAIN itself — the sliced remainder from the fallback.
      expect(call.args[0]).not.toBe(SWORD_CHAIN);
      expect((call.args[0] as ChainSpec).steps).toEqual(['sword_b', 'sword_c']);
    });

    it('a fallback resynchronises: the step right after it advances normally, not via another fallback', () => {
      const tracker = new DrillChainTracker();
      tracker.playStep(mockController(), 'sword_b', { spec: SWORD_CHAIN, index: 1 }, {});

      const controller = mockController({ advanceResult: 'advanced' });
      const played = tracker.playStep(controller, 'sword_c', { spec: SWORD_CHAIN, index: 2 }, {});

      expect(played).toBe(true);
      expect(controller.calls.map(c => c.method)).toEqual(['advanceChain']);
    });
  });

  describe('round 4 — a skip AHEAD within the running chain falls back instead of misfiring', () => {
    it('index 0 then index 2 (skipping 1) does not call advanceChain at all', () => {
      const tracker = new DrillChainTracker();
      tracker.playStep(mockController(), 'sword_a', { spec: SWORD_CHAIN, index: 0 }, {});

      const controller = mockController();
      const played = tracker.playStep(controller, 'sword_c', { spec: SWORD_CHAIN, index: 2 }, {});

      expect(controller.calls.map(c => c.method)).toEqual(['enterAbilityRecovery', 'startChain']);
      expect(played).toBe(true);
      // The remainder fallback plays the REQUESTED step (index 2), not
      // whatever a blind single-step advance would have landed on.
      expect((controller.calls[1].args[0] as ChainSpec).steps[0]).toBe('sword_c');
    });
  });

  describe("round 6 — index continuity alone can't tell two different chains apart", () => {
    it('switching from chain A (index 0) to a DIFFERENT chain B at index 1 falls back, never advances A', () => {
      const tracker = new DrillChainTracker();
      tracker.playStep(mockController(), 'sword_a', { spec: SWORD_CHAIN, index: 0 }, {});

      const controller = mockController();
      const played = tracker.playStep(controller, 'cross', { spec: PUNCH_CHAIN, index: 1 }, {});

      // The dangerous outcome this guards against: SWORD_CHAIN's index math
      // happens to line up (0 === 1 - 1), but PUNCH_CHAIN is a completely
      // different spec — advanceChain must never be called with SWORD_CHAIN
      // here.
      expect(controller.calls.map(c => c.method)).toEqual(['enterAbilityRecovery', 'startChain']);
      expect(played).toBe(true);
      const startedSpec = controller.calls[1].args[0] as ChainSpec;
      expect(startedSpec.steps).toEqual(['cross', 'hook']); // PUNCH_CHAIN sliced from index 1
    });

    it('the SAME chain at the SAME relative index still advances normally (not a false positive)', () => {
      const tracker = new DrillChainTracker();
      tracker.playStep(mockController(), 'sword_a', { spec: SWORD_CHAIN, index: 0 }, {});

      const controller = mockController({ advanceResult: 'advanced' });
      const played = tracker.playStep(controller, 'sword_b', { spec: SWORD_CHAIN, index: 1 }, {});

      expect(played).toBe(true);
      expect(controller.calls.map(c => c.method)).toEqual(['advanceChain']);
      expect(controller.calls[0].args[0]).toBe(SWORD_CHAIN);
    });
  });

  describe('general contract', () => {
    it('starts with nothing running', () => {
      const tracker = new DrillChainTracker();
      expect(tracker.playStep(mockController({ advanceResult: 'advanced' }), 'sword_b', { spec: SWORD_CHAIN, index: 1 }, {}))
        .toBe(true); // falls back — nothing was running to advance
    });

    it('a failed chain opener leaves nothing tracked', () => {
      const tracker = new DrillChainTracker();
      tracker.playStep(mockController({ startResult: false }), 'sword_a', { spec: SWORD_CHAIN, index: 0 }, {});

      const controller = mockController();
      tracker.playStep(controller, 'sword_b', { spec: SWORD_CHAIN, index: 1 }, {});

      // Nothing to advance against — falls back to a fresh start, not a
      // doomed advanceChain call against a chain that never actually opened.
      expect(controller.calls.map(c => c.method)).toEqual(['enterAbilityRecovery', 'startChain']);
    });

    it('a failed fallback start leaves nothing tracked either', () => {
      const tracker = new DrillChainTracker();
      tracker.playStep(mockController({ startResult: false }), 'sword_b', { spec: SWORD_CHAIN, index: 1 }, {});

      const controller = mockController();
      tracker.playStep(controller, 'sword_c', { spec: SWORD_CHAIN, index: 2 }, {});

      expect(controller.calls.map(c => c.method)).toEqual(['enterAbilityRecovery', 'startChain']);
    });

    it('reset() clears everything — a mode/body change with nothing left to advance against', () => {
      const tracker = new DrillChainTracker();
      tracker.playStep(mockController(), 'sword_a', { spec: SWORD_CHAIN, index: 0 }, {});

      tracker.reset();

      const controller = mockController();
      tracker.playStep(controller, 'sword_b', { spec: SWORD_CHAIN, index: 1 }, {});
      expect(controller.calls.map(c => c.method)).toEqual(['enterAbilityRecovery', 'startChain']);
    });

    it('a queued advance counts as played, and advances the tracked index', () => {
      const tracker = new DrillChainTracker();
      tracker.playStep(mockController(), 'sword_a', { spec: SWORD_CHAIN, index: 0 }, {});

      const controller = mockController({ advanceResult: 'queued' });
      const played = tracker.playStep(controller, 'sword_b', { spec: SWORD_CHAIN, index: 1 }, {});
      expect(played).toBe(true);

      // The tracker believes index 1 is now current — a further sequential
      // step (index 2) should try to advance again, not fall back.
      const next = mockController({ advanceResult: 'advanced' });
      tracker.playStep(next, 'sword_c', { spec: SWORD_CHAIN, index: 2 }, {});
      expect(next.calls.map(c => c.method)).toEqual(['advanceChain']);
    });

    it("an 'ignored' or 'inactive' advance result falls back rather than claiming success", () => {
      const tracker = new DrillChainTracker();
      tracker.playStep(mockController(), 'sword_a', { spec: SWORD_CHAIN, index: 0 }, {});

      const controller = mockController({ advanceResult: 'ignored' });
      const played = tracker.playStep(controller, 'sword_b', { spec: SWORD_CHAIN, index: 1 }, {});

      expect(controller.calls.map(c => c.method)).toEqual([
        'advanceChain',
        'enterAbilityRecovery',
        'startChain',
      ]);
      expect(played).toBe(true); // the fallback itself succeeds
    });

    it('passes playback options through to every controller call', () => {
      const tracker = new DrillChainTracker();
      const options = { upperBodyOnly: true, movement: 0.8 };
      const controller = mockController();

      tracker.playStep(controller, 'sword_a', { spec: SWORD_CHAIN, index: 0 }, options);

      const startCall = controller.calls.find(c => c.method === 'startChain')!;
      expect(startCall.args[1]).toBe(options);
    });
  });
});
