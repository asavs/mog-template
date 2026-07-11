import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clampLookPitchWithOrbitOffset } from './useLocalPlayerControls';

const CAMERA_MIN_PITCH = THREE.MathUtils.degToRad(-80);
const CAMERA_MAX_PITCH = THREE.MathUtils.degToRad(80);

describe('clampLookPitchWithOrbitOffset', () => {
  it('matches the standard camera pitch clamp when there is no orbit offset', () => {
    expect(clampLookPitchWithOrbitOffset(THREE.MathUtils.degToRad(90), 0))
      .toBeCloseTo(CAMERA_MAX_PITCH);
    expect(clampLookPitchWithOrbitOffset(THREE.MathUtils.degToRad(-90), 0))
      .toBeCloseTo(CAMERA_MIN_PITCH);
  });

  it('keeps both base pitch and combined pitch bounded with a positive orbit offset', () => {
    const orbitPitch = THREE.MathUtils.degToRad(30);
    const clampedPitch = clampLookPitchWithOrbitOffset(THREE.MathUtils.degToRad(80), orbitPitch);

    expect(clampedPitch).toBeCloseTo(THREE.MathUtils.degToRad(50));
    expect(clampedPitch).toBeLessThanOrEqual(CAMERA_MAX_PITCH);
    expect(clampedPitch + orbitPitch).toBeCloseTo(CAMERA_MAX_PITCH);
  });

  it('keeps both base pitch and combined pitch bounded with a negative orbit offset', () => {
    const orbitPitch = THREE.MathUtils.degToRad(-30);
    const clampedPitch = clampLookPitchWithOrbitOffset(THREE.MathUtils.degToRad(-80), orbitPitch);

    expect(clampedPitch).toBeCloseTo(THREE.MathUtils.degToRad(-50));
    expect(clampedPitch).toBeGreaterThanOrEqual(CAMERA_MIN_PITCH);
    expect(clampedPitch + orbitPitch).toBeCloseTo(CAMERA_MIN_PITCH);
  });

  it('allows mouse look to move away from a combined pitch limit immediately', () => {
    const orbitPitch = THREE.MathUtils.degToRad(30);
    const nextPitch = THREE.MathUtils.degToRad(49);
    const clampedPitch = clampLookPitchWithOrbitOffset(nextPitch, orbitPitch);

    expect(clampedPitch).toBeCloseTo(nextPitch);
    expect(clampedPitch + orbitPitch).toBeLessThan(CAMERA_MAX_PITCH);
  });
});
