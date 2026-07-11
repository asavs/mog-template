import { describe, expect, it } from 'vitest';
import { canRequestAction } from './playerActions';

describe('action input gating', () => {
  it('allows the first request before the server action state arrives', () => {
    expect(canRequestAction(undefined, 'attack', 1000, 0)).toBe(true);
  });

  it('blocks repeated requests while the client is waiting for server state', () => {
    expect(canRequestAction(undefined, 'attack', 1000, 1500)).toBe(false);
  });

  it('uses authoritative attack and block flags once action state is available', () => {
    const attacking = {
      currentAction: 'attacking',
      canAttack: false,
      canBlock: false,
    };

    expect(canRequestAction(attacking, 'attack', 1000, 0)).toBe(false);
    expect(canRequestAction(attacking, 'block', 1000, 0)).toBe(false);
  });

  it('allows actions again when the authoritative state returns to idle', () => {
    const idle = {
      currentAction: 'idle',
      canAttack: true,
      canBlock: true,
    };

    expect(canRequestAction(idle, 'attack', 1000, 0)).toBe(true);
    expect(canRequestAction(idle, 'block', 1000, 0)).toBe(true);
  });

  it('blocks actions during authoritative idle recovery', () => {
    const recovering = {
      currentAction: 'idle',
      canAttack: false,
      canBlock: false,
    };

    expect(canRequestAction(recovering, 'attack', 1000, 0)).toBe(false);
    expect(canRequestAction(recovering, 'block', 1000, 0)).toBe(false);
  });
});
