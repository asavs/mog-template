import { describe, expect, it } from 'vitest';
import type {
  PlayerActionState,
  PlayerAnimation,
  PlayerHealth,
} from './generated/types';
import {
  createPlayerRuntimeState,
  removePlayerActionState,
  removePlayerAnimation,
  removePlayerHealth,
  upsertPlayerActionState,
  upsertPlayerAnimation,
  upsertPlayerHealth,
} from './playerRuntime';

function row<T>(identityKey: string, fields: Partial<T> = {}): T {
  return {
    identity: { toHexString: () => identityKey },
    ...fields,
  } as unknown as T;
}

describe('player runtime state', () => {
  it('upserts and replaces each player runtime row', () => {
    const runtime = createPlayerRuntimeState();
    const firstAction = row<PlayerActionState>('alpha');
    const secondAction = row<PlayerActionState>('alpha');
    const firstAnimation = row<PlayerAnimation>('alpha');
    const secondAnimation = row<PlayerAnimation>('alpha');
    const firstHealth = row<PlayerHealth>('alpha');
    const secondHealth = row<PlayerHealth>('alpha');

    upsertPlayerActionState(runtime, firstAction);
    upsertPlayerAnimation(runtime, firstAnimation);
    upsertPlayerHealth(runtime, firstHealth);
    upsertPlayerActionState(runtime, secondAction);
    upsertPlayerAnimation(runtime, secondAnimation);
    upsertPlayerHealth(runtime, secondHealth);

    expect(runtime.actionStates.get('alpha')).toBe(secondAction);
    expect(runtime.animations.get('alpha')).toBe(secondAnimation);
    expect(runtime.health.get('alpha')).toBe(secondHealth);
  });

  it('removes one player without disturbing another player', () => {
    const runtime = createPlayerRuntimeState();
    const betaAction = row<PlayerActionState>('beta');
    const betaAnimation = row<PlayerAnimation>('beta');
    const betaHealth = row<PlayerHealth>('beta');

    upsertPlayerActionState(runtime, row<PlayerActionState>('alpha'));
    upsertPlayerAnimation(runtime, row<PlayerAnimation>('alpha'));
    upsertPlayerHealth(runtime, row<PlayerHealth>('alpha'));
    upsertPlayerActionState(runtime, betaAction);
    upsertPlayerAnimation(runtime, betaAnimation);
    upsertPlayerHealth(runtime, betaHealth);

    removePlayerActionState(runtime, 'alpha');
    removePlayerAnimation(runtime, 'alpha');
    removePlayerHealth(runtime, 'alpha');

    expect(runtime.actionStates.get('beta')).toBe(betaAction);
    expect(runtime.animations.get('beta')).toBe(betaAnimation);
    expect(runtime.health.get('beta')).toBe(betaHealth);
  });

  it('retains stable state and map identities across mutations', () => {
    const runtime = createPlayerRuntimeState();
    const actionStates = runtime.actionStates;
    const animations = runtime.animations;
    const health = runtime.health;

    expect(upsertPlayerActionState(runtime, row<PlayerActionState>('alpha'))).toBe(runtime);
    expect(upsertPlayerAnimation(runtime, row<PlayerAnimation>('alpha'))).toBe(runtime);
    expect(upsertPlayerHealth(runtime, row<PlayerHealth>('alpha'))).toBe(runtime);
    expect(removePlayerActionState(runtime, 'alpha')).toBe(runtime);
    expect(removePlayerAnimation(runtime, 'alpha')).toBe(runtime);
    expect(removePlayerHealth(runtime, 'alpha')).toBe(runtime);

    expect(runtime.actionStates).toBe(actionStates);
    expect(runtime.animations).toBe(animations);
    expect(runtime.health).toBe(health);
  });
});
