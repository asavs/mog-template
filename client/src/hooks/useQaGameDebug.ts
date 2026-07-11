import { useEffect, useRef } from 'react';
import { shouldEnableQaGameDebug } from '../qaGate';
export { shouldEnableQaGameDebug } from '../qaGate';

export type GameDebugValue = number | boolean | null | undefined;
export type GameDebugChannels = Record<string, GameDebugValue>;
export type QaRemotePlayerPosition = {
  x: number;
  y: number;
  z: number;
};


/**
 * Observability surface for the QA harness. The surface is installed only when
 * the page URL has `?qa` or Vite exposes `VITE_QA_MODE` as a truthy value
 * (`1`, `true`, `yes`, or `on`). With the gate off, callers should avoid
 * mounting this hook so production pays only a cheap flag check.
 *
 * The harness samples window.__gameDebug alongside window.__playerDebug. Values
 * must be numbers or booleans; null/undefined means "no reading this frame".
 */
export const QA_GAME_DEBUG_ENABLED = shouldEnableQaGameDebug();
const MAX_QA_REMOTE_PLAYERS = 4;
const qaRemotePlayerIndexes = new Map<string, number>();
const fallbackChannels: GameDebugChannels = {};

export function publishQaGameDebug(
  channels: GameDebugChannels,
  enabled = QA_GAME_DEBUG_ENABLED,
) {
  if (!enabled || typeof window === 'undefined') return false;

  // Remote-player channels are written in place onto the live debug object by
  // the frame loop (publishQaRemotePlayerRoster/RenderPosition), while local
  // channels arrive here as a brand-new object whenever the bridge re-renders.
  // Carry the remote keys over so replacing the reference never wipes them.
  const previous = window.__gameDebug;
  if (previous && previous !== channels) {
    for (const key of Object.keys(previous)) {
      if (key.startsWith('remote')) channels[key] = previous[key];
    }
  }

  window.__gameDebug = channels;
  return true;
}

function getQaGameDebugChannels(enabled = QA_GAME_DEBUG_ENABLED) {
  if (!enabled || typeof window === 'undefined') return null;

  if (!window.__gameDebug) {
    window.__gameDebug = fallbackChannels;
  }
  return window.__gameDebug;
}

function clearRemotePlayerSlot(channels: GameDebugChannels, index: number) {
  delete channels[`remote${index}_x`];
  delete channels[`remote${index}_y`];
  delete channels[`remote${index}_z`];
}

export function publishQaRemotePlayerRoster(
  identityKeys: readonly string[],
  enabled = QA_GAME_DEBUG_ENABLED,
) {
  const channels = getQaGameDebugChannels(enabled);
  if (!channels) return false;

  qaRemotePlayerIndexes.clear();
  channels.remoteCount = identityKeys.length;

  for (let index = 0; index < MAX_QA_REMOTE_PLAYERS; index += 1) {
    clearRemotePlayerSlot(channels, index);
  }

  const indexedCount = Math.min(identityKeys.length, MAX_QA_REMOTE_PLAYERS);
  for (let index = 0; index < indexedCount; index += 1) {
    qaRemotePlayerIndexes.set(identityKeys[index], index);
  }

  return true;
}

export function publishQaRemotePlayerRenderPosition(
  identityKey: string,
  position: QaRemotePlayerPosition,
  enabled = QA_GAME_DEBUG_ENABLED,
) {
  if (!enabled || typeof window === 'undefined') return false;

  const index = qaRemotePlayerIndexes.get(identityKey);
  if (index === undefined) return false;

  const channels = window.__gameDebug;
  if (!channels) return false;

  channels[`remote${index}_x`] = position.x;
  channels[`remote${index}_y`] = position.y;
  channels[`remote${index}_z`] = position.z;
  return true;
}

export function clearQaGameDebug(channels?: GameDebugChannels) {
  if (typeof window === 'undefined') return;
  if (channels && window.__gameDebug !== channels) return;

  delete window.__gameDebug;
  qaRemotePlayerIndexes.clear();
}

export function useQaGameDebug(channels: GameDebugChannels) {
  // Publish on every channel change; only overwrite the reference so we never
  // delete/re-create window.__gameDebug mid-lifetime (avoids a transient gap a
  // polling harness could observe). publishQaGameDebug is a no-op when the gate
  // is off or window is absent. Track the latest published channels in a ref so
  // the unmount cleanup can guard against tearing down someone else's surface.
  const channelsRef = useRef(channels);
  useEffect(() => {
    channelsRef.current = channels;
    publishQaGameDebug(channels);
  }, [channels]);

  // Tear the surface down when the owner unmounts, but only if the global still
  // points at this component's channels. Under concurrent render / HMR a newer
  // component can mount and take ownership before we unmount; passing the ref
  // lets clearQaGameDebug's guard skip the delete in that case.
  useEffect(() => () => clearQaGameDebug(channelsRef.current), []);
}
