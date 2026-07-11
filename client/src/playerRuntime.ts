import type {
  PlayerActionState,
  PlayerAnimation,
  PlayerHealth,
} from './generated/types';

export interface PlayerRuntimeState {
  actionStates: Map<string, PlayerActionState>;
  animations: Map<string, PlayerAnimation>;
  health: Map<string, PlayerHealth>;
}

export function createPlayerRuntimeState(): PlayerRuntimeState {
  return {
    actionStates: new Map(),
    animations: new Map(),
    health: new Map(),
  };
}

export function upsertPlayerActionState(
  runtime: PlayerRuntimeState,
  actionState: PlayerActionState,
) {
  runtime.actionStates.set(actionState.identity.toHexString(), actionState);
  return runtime;
}

export function removePlayerActionState(runtime: PlayerRuntimeState, identityKey: string) {
  runtime.actionStates.delete(identityKey);
  return runtime;
}

export function upsertPlayerAnimation(runtime: PlayerRuntimeState, animation: PlayerAnimation) {
  runtime.animations.set(animation.identity.toHexString(), animation);
  return runtime;
}

export function removePlayerAnimation(runtime: PlayerRuntimeState, identityKey: string) {
  runtime.animations.delete(identityKey);
  return runtime;
}

export function upsertPlayerHealth(runtime: PlayerRuntimeState, health: PlayerHealth) {
  runtime.health.set(health.identity.toHexString(), health);
  return runtime;
}

export function removePlayerHealth(runtime: PlayerRuntimeState, identityKey: string) {
  runtime.health.delete(identityKey);
  return runtime;
}
