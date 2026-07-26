import { describe, expect, it } from 'vitest';
import { ACTION_DEFS, type ActionDef } from './defs.generated';
import { Phase, actionDefById, deriveGates } from './gates';

const ALL_PHASES = [Phase.Idle, Phase.Charging, Phase.Windup, Phase.Active, Phase.Held, Phase.Recovery];
const someOtherDef: ActionDef = ACTION_DEFS.find(def => def.id === 'roll')!;

describe('deriveGates — idle and unknown', () => {
  it('idle (no action) is fully unrestricted and lets any action start', () => {
    const gates = deriveGates('', Phase.Idle);
    expect(gates.movementFraction).toBe(1);
    expect(gates.canRotate).toBe(true);
    expect(gates.canStartAction(someOtherDef)).toBe(true);
    expect(gates.canStartAction(null)).toBe(false);
  });

  it('an action id the client defs do not know about fails open, not closed', () => {
    const gates = deriveGates('some_future_action', Phase.Windup);
    expect(gates.movementFraction).toBe(1);
    expect(gates.canRotate).toBe(true);
    expect(gates.canStartAction(someOtherDef)).toBe(true);
  });
});

describe('deriveGates over every def and every phase', () => {
  for (const def of ACTION_DEFS) {
    describe(def.id, () => {
      for (const phase of ALL_PHASES) {
        it(`phase ${phase} reports the def's own movement fraction and canRotate`, () => {
          const gates = deriveGates(def.id, phase);
          if (phase === Phase.Idle) {
            expect(gates.movementFraction).toBe(1);
            expect(gates.canRotate).toBe(true);
            return;
          }
          expect(gates.canRotate).toBe(def.canRotate);
          const expectedFraction = {
            [Phase.Charging]: def.movement.charging,
            [Phase.Windup]: def.movement.windup,
            [Phase.Active]: def.movement.active,
            [Phase.Held]: def.movement.held,
            [Phase.Recovery]: def.movement.recovery,
          }[phase as Exclude<typeof phase, typeof Phase.Idle>];
          expect(gates.movementFraction).toBe(expectedFraction);
        });
      }

      it('interrupt policy governs canStartAction identically across every non-idle phase', () => {
        for (const phase of ALL_PHASES) {
          if (phase === Phase.Idle) continue;
          const gates = deriveGates(def.id, phase);
          const canStart = gates.canStartAction(someOtherDef);
          if (def.interrupt === 'always') expect(canStart).toBe(true);
          else if (def.interrupt === 'never') expect(canStart).toBe(false);
          else expect(canStart).toBe(phase === Phase.Recovery);
        }
      });

      it('canStartAction(null) is always false — there is no action to start', () => {
        const gates = deriveGates(def.id, Phase.Windup);
        expect(gates.canStartAction(null)).toBe(false);
      });
    });
  }
});

describe('actionDefById', () => {
  it('resolves every def id from ACTION_DEFS', () => {
    for (const def of ACTION_DEFS) {
      expect(actionDefById(def.id)).toBe(def);
    }
  });

  it('returns undefined for an unknown id', () => {
    expect(actionDefById('nope')).toBeUndefined();
  });
});
