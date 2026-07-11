import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearQaGameDebug,
  publishQaGameDebug,
  publishQaRemotePlayerRenderPosition,
  publishQaRemotePlayerRoster,
  shouldEnableQaGameDebug,
} from './useQaGameDebug';

function stubWindow() {
  const testWindow = { location: { search: '' } } as Window & typeof globalThis;
  vi.stubGlobal('window', testWindow);
  return testWindow;
}

describe('QA game debug surface', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes registered channel values when the QA gate is on', () => {
    const testWindow = stubWindow();

    const channels = {
      hp: 42,
      isDead: false,
    };

    expect(publishQaGameDebug(channels, true)).toBe(true);
    expect(testWindow.__gameDebug?.hp).toBe(42);
    expect(testWindow.__gameDebug?.isDead).toBe(false);
  });

  it('does not install window.__gameDebug when the QA gate is off', () => {
    const testWindow = stubWindow();

    expect(publishQaGameDebug({ hp: 42 }, false)).toBe(false);
    expect(testWindow.__gameDebug).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(testWindow, '__gameDebug')).toBe(false);
  });

  it('tears down only the surface it still owns', () => {
    const testWindow = stubWindow();

    const channels = { hp: 42 };
    publishQaGameDebug(channels, true);

    // A newer owner published its own channels; the old owner's cleanup must
    // not delete the active surface.
    const newerChannels = { hp: 7 };
    publishQaGameDebug(newerChannels, true);
    clearQaGameDebug(channels);
    expect(testWindow.__gameDebug).toBe(newerChannels);

    // The current owner's cleanup removes its own surface.
    clearQaGameDebug(newerChannels);
    expect(testWindow.__gameDebug).toBeUndefined();
  });


  it('publishes QA-gated remote render channels and clears stale slots', () => {
    const testWindow = stubWindow();
    const channels = { hp: 42 };
    publishQaGameDebug(channels, true);

    expect(publishQaRemotePlayerRoster(['remote-b', 'remote-c'], true)).toBe(true);
    expect(publishQaRemotePlayerRenderPosition('remote-b', { x: 1, y: 2, z: 3 }, true)).toBe(true);
    expect(publishQaRemotePlayerRenderPosition('remote-c', { x: 4, y: 5, z: 6 }, true)).toBe(true);

    expect(testWindow.__gameDebug?.remoteCount).toBe(2);
    expect(testWindow.__gameDebug?.remote0_x).toBe(1);
    expect(testWindow.__gameDebug?.remote0_y).toBe(2);
    expect(testWindow.__gameDebug?.remote0_z).toBe(3);
    expect(testWindow.__gameDebug?.remote1_x).toBe(4);
    expect(testWindow.__gameDebug?.remote1_y).toBe(5);
    expect(testWindow.__gameDebug?.remote1_z).toBe(6);
    expect(testWindow.__gameDebug?.hp).toBe(42);

    publishQaRemotePlayerRoster(['remote-c'], true);
    expect(publishQaRemotePlayerRenderPosition('remote-c', { x: 7, y: 8, z: 9 }, true)).toBe(true);

    expect(testWindow.__gameDebug?.remoteCount).toBe(1);
    expect(testWindow.__gameDebug?.remote0_x).toBe(7);
    expect(testWindow.__gameDebug?.remote0_y).toBe(8);
    expect(testWindow.__gameDebug?.remote0_z).toBe(9);
    expect(testWindow.__gameDebug?.remote1_x).toBeUndefined();
    expect(testWindow.__gameDebug?.remote1_y).toBeUndefined();
    expect(testWindow.__gameDebug?.remote1_z).toBeUndefined();
  });

  it('preserves remote channels when local channels are republished', () => {
    const testWindow = stubWindow();
    publishQaGameDebug({ hp: 42 }, true);

    publishQaRemotePlayerRoster(['remote-b'], true);
    publishQaRemotePlayerRenderPosition('remote-b', { x: 1, y: 2, z: 3 }, true);

    // The bridge re-creates its channels object whenever local state (hp,
    // effects, ...) changes; remote channels written in place by the frame
    // loop must survive the reference swap.
    publishQaGameDebug({ hp: 7 }, true);

    expect(testWindow.__gameDebug?.hp).toBe(7);
    expect(testWindow.__gameDebug?.remoteCount).toBe(1);
    expect(testWindow.__gameDebug?.remote0_x).toBe(1);
    expect(testWindow.__gameDebug?.remote0_y).toBe(2);
    expect(testWindow.__gameDebug?.remote0_z).toBe(3);
  });

  it('enables the surface from the URL or Vite env gate', () => {
    expect(shouldEnableQaGameDebug({ search: '?qa' })).toBe(true);
    expect(shouldEnableQaGameDebug({ envQaMode: 'true' })).toBe(true);
    expect(shouldEnableQaGameDebug({ search: '', envQaMode: undefined })).toBe(false);
  });
});
