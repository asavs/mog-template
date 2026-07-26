import { describe, expect, it } from 'vitest';
import { ACTION_DEFS } from '../actions/defs.generated';
import { Effects } from './effects';
import { driveDeathReaction, driveReactionsFromEvent, type PresentationController } from './reactions';

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

describe('driveReactionsFromEvent', () => {
  const melee = ACTION_DEFS.find(def => def.effects.some(e => e.kind === 'melee_arc'))!;

  it('flinches the target\'s own controller and spawns the scene-wide visual', () => {
    const controller = mockController();
    const effects = new Effects();

    driveReactionsFromEvent(controller, effects, ACTION_DEFS, {
      id: 'evt-1',
      actionId: melee.id,
      kind: 'hit',
      position: { x: 0, y: 0, z: 0 },
      targetIsSelf: true,
    });

    expect(controller.calls).toEqual([{ method: 'playHitReaction', args: [] }]);
    expect(effects.meleeFlashes.get('evt-1')).toBeDefined();
  });

  it('spawns the visual for a witness without making them flinch', () => {
    const controller = mockController();
    const effects = new Effects();

    driveReactionsFromEvent(controller, effects, ACTION_DEFS, {
      id: 'evt-2',
      actionId: melee.id,
      kind: 'hit',
      position: { x: 0, y: 0, z: 0 },
      targetIsSelf: false,
    });

    expect(controller.calls).toHaveLength(0);
    expect(effects.meleeFlashes.get('evt-2')).toBeDefined();
  });

  it('does not spawn a visual, or flinch, for a miss', () => {
    const controller = mockController();
    const effects = new Effects();

    driveReactionsFromEvent(controller, effects, ACTION_DEFS, {
      id: 'evt-3',
      actionId: melee.id,
      kind: 'miss',
      position: { x: 0, y: 0, z: 0 },
      targetIsSelf: true,
    });

    expect(controller.calls).toHaveLength(0);
    // The visual pool is driven by the def's effect kind, not the event kind
    // — a miss still swings the weapon, so the flash still plays.
    expect(effects.meleeFlashes.get('evt-3')).toBeDefined();
  });

  it('one shared Effects instance is not spawned into twice for two witnesses of the same event', () => {
    const effects = new Effects();
    const eventRow = {
      id: 'evt-4',
      actionId: melee.id,
      kind: 'hit' as const,
      position: { x: 0, y: 0, z: 0 },
    };

    driveReactionsFromEvent(mockController(), effects, ACTION_DEFS, { ...eventRow, targetIsSelf: true });
    driveReactionsFromEvent(mockController(), effects, ACTION_DEFS, { ...eventRow, targetIsSelf: false });

    // Same row id both times, so the pool re-borrows the same slot rather
    // than consuming two of its fixed budget.
    expect(effects.meleeFlashes.entries.filter(e => e.key === 'evt-4')).toHaveLength(1);
  });
});

describe('driveDeathReaction', () => {
  it('plays death on the target controller', () => {
    const controller = mockController();
    driveDeathReaction(controller, { isDead: true });
    expect(controller.calls).toEqual([{ method: 'playDeath', args: [] }]);
  });

  it('does nothing while alive', () => {
    const controller = mockController();
    driveDeathReaction(controller, { isDead: false });
    expect(controller.calls).toHaveLength(0);
  });
});
