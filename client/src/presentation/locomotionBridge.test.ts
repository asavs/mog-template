import { describe, expect, it } from 'vitest';
import { MOTION_AIR, MOTION_LOCOMOTION } from '../content/keys';
import { locomotionKeyForPhase, locomotionKeyForRemoteState } from './locomotionBridge';

const NONE = { forward: false, backward: false, left: false, right: false };

describe('locomotionKeyForPhase', () => {
  it('idles when grounded and not moving', () => {
    expect(locomotionKeyForPhase('grounded_idle', NONE)).toBe(MOTION_LOCOMOTION.idle);
  });

  it('picks the walk variant matching the held axis', () => {
    expect(locomotionKeyForPhase('grounded_walk', { ...NONE, forward: true })).toBe(MOTION_LOCOMOTION.walkForward);
    expect(locomotionKeyForPhase('grounded_walk', { ...NONE, backward: true })).toBe(MOTION_LOCOMOTION.walkBack);
    expect(locomotionKeyForPhase('grounded_walk', { ...NONE, left: true })).toBe(MOTION_LOCOMOTION.walkLeft);
    expect(locomotionKeyForPhase('grounded_walk', { ...NONE, right: true })).toBe(MOTION_LOCOMOTION.walkRight);
  });

  it('picks the run variant matching the held axis when sprinting', () => {
    expect(locomotionKeyForPhase('grounded_sprint', { ...NONE, forward: true })).toBe(MOTION_LOCOMOTION.runForward);
    expect(locomotionKeyForPhase('grounded_sprint', { ...NONE, right: true })).toBe(MOTION_LOCOMOTION.runRight);
  });

  it('prefers forward over the other axes for a diagonal hold', () => {
    expect(locomotionKeyForPhase('grounded_walk', { forward: true, backward: false, left: false, right: true }))
      .toBe(MOTION_LOCOMOTION.walkForward);
  });

  it('falls back to idle for a walk/sprint phase reported with no axis held', () => {
    expect(locomotionKeyForPhase('grounded_walk', NONE)).toBe(MOTION_LOCOMOTION.idle);
  });

  it('uses the single air key for both jump and fall', () => {
    expect(locomotionKeyForPhase('airborne_jump', NONE)).toBe(MOTION_AIR.jump);
    expect(locomotionKeyForPhase('airborne_fall', NONE)).toBe(MOTION_AIR.jump);
  });
});

describe('locomotionKeyForRemoteState', () => {
  it('idles when grounded and not moving', () => {
    expect(locomotionKeyForRemoteState(false, false, false)).toBe(MOTION_LOCOMOTION.idle);
  });

  it('walks forward when moving without sprint', () => {
    expect(locomotionKeyForRemoteState(false, true, false)).toBe(MOTION_LOCOMOTION.walkForward);
  });

  it('runs forward when moving with sprint active', () => {
    expect(locomotionKeyForRemoteState(false, true, true)).toBe(MOTION_LOCOMOTION.runForward);
  });

  it('goes airborne regardless of moving/sprint flags', () => {
    expect(locomotionKeyForRemoteState(true, true, true)).toBe(MOTION_AIR.jump);
    expect(locomotionKeyForRemoteState(true, false, false)).toBe(MOTION_AIR.jump);
  });
});
