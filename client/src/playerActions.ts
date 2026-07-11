import type { PlayerActionState } from './generated/types';

type ActionAbility = 'attack' | 'block';
type ActionGateState = Pick<PlayerActionState, 'currentAction' | 'canAttack' | 'canBlock'>;

export function canRequestAction(
  playerActionState: ActionGateState | undefined,
  ability: ActionAbility,
  nowMs: number,
  requestLockedUntilMs: number,
) {
  if (nowMs < requestLockedUntilMs) return false;
  if (!playerActionState) return true;
  if (playerActionState.currentAction === 'dead') return false;
  return ability === 'attack' ? playerActionState.canAttack : playerActionState.canBlock;
}
