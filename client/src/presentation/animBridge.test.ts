import { describe, expect, it } from 'vitest';
import { ACTION_DEFS, type ActionDef } from '../actions/defs.generated';
import {
  ACTION_PHASE,
  driveAnimationFromActionState,
  driveDeath,
  driveHitReaction,
  phasedKeysFor,
  type PresentationController,
} from './animBridge';

type Call = { method: string; args: unknown[] };

function mockController(): PresentationController & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    playPhased: (...args) => {
      calls.push({ method: 'playPhased', args });
      return true;
    },
    playAbility: (...args) => {
      calls.push({ method: 'playAbility', args });
      return true;
    },
    enterAbilityRecovery: (...args) => {
      calls.push({ method: 'enterAbilityRecovery', args });
    },
    playHitReaction: (...args) => {
      calls.push({ method: 'playHitReaction', args });
      return true;
    },
    playDeath: (...args) => {
      calls.push({ method: 'playDeath', args });
      return true;
    },
  };
}

const HOLD_CAPABLE_UPPER_DEFS = ACTION_DEFS.filter(
  (def): def is ActionDef & { hold: NonNullable<ActionDef['hold']> } =>
    def.hold !== null && def.motionLayer === 'upper',
);

describe('phasedKeysFor', () => {
  it('builds the enter/hold/exit candidate triplet, held unqualified', () => {
    expect(phasedKeysFor('motion.act_guard_hold')).toEqual({
      enter: 'motion.act_guard_hold_enter',
      held: 'motion.act_guard_hold',
      exit: 'motion.act_guard_hold_exit',
    });
  });
});

describe('driveAnimationFromActionState', () => {
  it('plays every def\'s motion on entering windup, upper vs full per motionLayer, width via windup movement', () => {
    for (const def of ACTION_DEFS) {
      const controller = mockController();
      driveAnimationFromActionState(controller, ACTION_DEFS, {
        actionId: def.id,
        phase: ACTION_PHASE.windup,
        phaseStartedTick: 1n,
      });

      const abilityCalls = controller.calls.filter(call => call.method === 'playAbility');
      expect(abilityCalls, `${def.id} should fire exactly one playAbility on windup`).toHaveLength(1);
      expect(abilityCalls[0]!.args).toEqual([
        def.motion,
        { upperBodyOnly: def.motionLayer === 'upper', movement: def.movement.windup },
      ]);
    }
  });

  it('fires the motion again on active (idempotent from the caller\'s point of view)', () => {
    for (const def of ACTION_DEFS) {
      const controller = mockController();
      driveAnimationFromActionState(controller, ACTION_DEFS, {
        actionId: def.id,
        phase: ACTION_PHASE.active,
        phaseStartedTick: 1n,
      });
      expect(controller.calls.filter(call => call.method === 'playAbility')).toHaveLength(1);
    }
  });

  it('opens the recovery window on recovery, for any def, and plays no motion', () => {
    for (const def of ACTION_DEFS) {
      const controller = mockController();
      driveAnimationFromActionState(controller, ACTION_DEFS, {
        actionId: def.id,
        phase: ACTION_PHASE.recovery,
        phaseStartedTick: 1n,
      });
      expect(controller.calls.filter(call => call.method === 'playAbility')).toHaveLength(0);
      expect(controller.calls.filter(call => call.method === 'enterAbilityRecovery')).toHaveLength(1);
    }
  });

  it('plays no motion and opens no recovery window while idle', () => {
    const controller = mockController();
    driveAnimationFromActionState(controller, ACTION_DEFS, { actionId: '', phase: ACTION_PHASE.idle, phaseStartedTick: 0n });

    expect(controller.calls.filter(call => call.method === 'playAbility')).toHaveLength(0);
    expect(controller.calls.filter(call => call.method === 'enterAbilityRecovery')).toHaveLength(0);
  });

  it('runs the phased path for every hold-capable, upper-layer def, and only those', () => {
    // Sanity: today that is exactly `block`. If a future def adds another
    // upper-layer hold, this test (and the loop below) covers it for free —
    // that is the point of driving it off `ACTION_DEFS` rather than a name.
    expect(HOLD_CAPABLE_UPPER_DEFS.map(def => def.id)).toEqual(['block']);

    for (const def of HOLD_CAPABLE_UPPER_DEFS) {
      const controller = mockController();
      driveAnimationFromActionState(controller, ACTION_DEFS, {
        actionId: def.id,
        phase: ACTION_PHASE.held,
        phaseStartedTick: 1n,
      });

      const phasedCalls = controller.calls.filter(call => call.method === 'playPhased');
      // One phased call per hold-capable upper def in the whole table, not
      // just the one matching the current action — the others are how a
      // held pose the player just let go of gets released.
      expect(phasedCalls).toHaveLength(HOLD_CAPABLE_UPPER_DEFS.length);

      const own = phasedCalls.find(call => call.args[0] === true);
      expect(own?.args).toEqual([true, phasedKeysFor(def.motion), { enter: 'holdEnter', held: 'holdHeld', exit: 'holdExit' }]);

      // No `playAbility` for a hold-capable def while it's held — it is
      // entirely phased-driven.
      expect(controller.calls.filter(call => call.method === 'playAbility')).toHaveLength(0);
    }
  });

  it('releases a hold-capable def\'s phase (desired=false) when it is not the active action', () => {
    const controller = mockController();
    driveAnimationFromActionState(controller, ACTION_DEFS, {
      actionId: 'attack_light',
      phase: ACTION_PHASE.windup,
      phaseStartedTick: 1n,
    });

    const blockDef = ACTION_DEFS.find(def => def.id === 'block')!;
    const phasedCalls = controller.calls.filter(call => call.method === 'playPhased');
    expect(phasedCalls).toHaveLength(1);
    expect(phasedCalls[0]!.args).toEqual([
      false,
      phasedKeysFor(blockDef.motion),
      { enter: 'holdEnter', held: 'holdHeld', exit: 'holdExit' },
    ]);
  });

  it('is presentation-silent for a full-layer hold-capable def while charging, and plays the swing on release', () => {
    const heavy = ACTION_DEFS.find(def => def.id === 'attack_heavy')!;
    expect(heavy.hold?.mode).toBe('charge');
    expect(heavy.motionLayer).toBe('full');

    const charging = mockController();
    driveAnimationFromActionState(charging, ACTION_DEFS, {
      actionId: 'attack_heavy',
      phase: ACTION_PHASE.charging,
      phaseStartedTick: 1n,
    });
    expect(charging.calls.filter(call => call.method === 'playAbility')).toHaveLength(0);

    const released = mockController();
    driveAnimationFromActionState(released, ACTION_DEFS, {
      actionId: 'attack_heavy',
      phase: ACTION_PHASE.windup,
      phaseStartedTick: 2n,
    });
    expect(released.calls.filter(call => call.method === 'playAbility')).toEqual([
      { method: 'playAbility', args: [heavy.motion, { upperBodyOnly: false, movement: heavy.movement.windup }] },
    ]);
  });

  // Regression for the "one cast loops forever" bug: this function is called
  // every render frame with whatever the row currently says, and a real
  // `AnimationController` clears its own overlay slot as soon as a one-shot
  // ability clip finishes playing — even if gameplay hasn't reported Recovery
  // yet (see `animBridge.ts`'s `lastFiredAbilityEdge` doc). Before the edge
  // check existed, calling this repeatedly for a row parked in the SAME
  // phase — exactly what happens when render frames outpace server ticks, or
  // the row simply hasn't changed yet — fired a fresh `playAbility` every
  // single call, which on the real controller replays the clip from frame 0
  // each time. The mock here always returns `true` and never clears its own
  // state (unlike the real controller), so without the bridge's own edge
  // check this test would see one `playAbility` call per invocation — 20 of
  // them — not one.
  it('fires playAbility exactly once for 20 same-phase row updates in a row (edge, not level)', () => {
    const def = ACTION_DEFS.find(d => d.motionLayer === 'upper') ?? ACTION_DEFS[0]!;
    const controller = mockController();
    const row = { actionId: def.id, phase: ACTION_PHASE.active, phaseStartedTick: 7n } as const;

    for (let i = 0; i < 20; i += 1) {
      driveAnimationFromActionState(controller, ACTION_DEFS, row);
    }

    expect(controller.calls.filter(call => call.method === 'playAbility')).toHaveLength(1);
  });

  it('fires playAbility again when phaseStartedTick advances even though actionId and phase repeat (a fast combo revisiting the same phase)', () => {
    const def = ACTION_DEFS.find(d => d.motionLayer === 'upper') ?? ACTION_DEFS[0]!;
    const controller = mockController();

    driveAnimationFromActionState(controller, ACTION_DEFS, { actionId: def.id, phase: ACTION_PHASE.windup, phaseStartedTick: 1n });
    driveAnimationFromActionState(controller, ACTION_DEFS, { actionId: def.id, phase: ACTION_PHASE.windup, phaseStartedTick: 1n });
    driveAnimationFromActionState(controller, ACTION_DEFS, { actionId: def.id, phase: ACTION_PHASE.windup, phaseStartedTick: 5n });

    expect(controller.calls.filter(call => call.method === 'playAbility')).toHaveLength(2);
  });

  it('is unaffected by server_tick-style noise: the edge key is (actionId, phase, phaseStartedTick) only', () => {
    // The real row also carries `server_tick`, advancing every tick — not part
    // of `ActionStateRow`, and deliberately not part of the edge key. Nothing
    // to assert on that field directly (it isn't in the type), but this test
    // documents the intent: repeated identical rows below are exactly what a
    // ticking-but-unchanged `server_tick` would look like from this bridge's
    // point of view, and must stay a no-op.
    const def = ACTION_DEFS.find(d => d.motionLayer === 'upper') ?? ACTION_DEFS[0]!;
    const controller = mockController();
    const row = { actionId: def.id, phase: ACTION_PHASE.windup, phaseStartedTick: 3n } as const;

    driveAnimationFromActionState(controller, ACTION_DEFS, row);
    driveAnimationFromActionState(controller, ACTION_DEFS, row);
    driveAnimationFromActionState(controller, ACTION_DEFS, row);

    expect(controller.calls.filter(call => call.method === 'playAbility')).toHaveLength(1);
  });
});

describe('driveHitReaction', () => {
  it('reacts to a hit event targeting self', () => {
    const controller = mockController();
    driveHitReaction(controller, { kind: 'hit', targetIsSelf: true });
    expect(controller.calls).toEqual([{ method: 'playHitReaction', args: [] }]);
  });

  it('ignores a hit event targeting someone else', () => {
    const controller = mockController();
    driveHitReaction(controller, { kind: 'hit', targetIsSelf: false });
    expect(controller.calls).toHaveLength(0);
  });

  it('ignores non-hit event kinds', () => {
    const controller = mockController();
    driveHitReaction(controller, { kind: 'blocked', targetIsSelf: true });
    driveHitReaction(controller, { kind: 'miss', targetIsSelf: true });
    expect(controller.calls).toHaveLength(0);
  });
});

describe('driveDeath', () => {
  it('plays death once the health row reports dead', () => {
    const controller = mockController();
    driveDeath(controller, { isDead: true });
    expect(controller.calls).toEqual([{ method: 'playDeath', args: [] }]);
  });

  it('does nothing while alive', () => {
    const controller = mockController();
    driveDeath(controller, { isDead: false });
    expect(controller.calls).toHaveLength(0);
  });
});
