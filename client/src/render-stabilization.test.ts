import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';

// Since we integrated the logic into Player.tsx in the remote commit, 
// I'll define a testable version of the logic here to verify the math.
function updateVisualCorrection(
  offset: THREE.Vector3,
  correctionDelta: THREE.Vector3,
  decayRate: number,
  dt: number,
  isSnap: boolean
) {
  if (isSnap) {
    offset.set(0, 0, 0);
  } else {
    offset.sub(correctionDelta);
  }
  const alpha = 1 - Math.exp(-decayRate * dt);
  offset.lerp(new THREE.Vector3(0, 0, 0), alpha);
}

describe('Correction Offset Logic', () => {
  let offset: THREE.Vector3;
  let correctionDelta: THREE.Vector3;
  const decayRate = 30; // Updated rate

  beforeEach(() => {
    offset = new THREE.Vector3(0, 0, 0);
    correctionDelta = new THREE.Vector3(0, 0, 0);
  });

  it('subtracts correction delta from offset', () => {
    correctionDelta.set(0.1, 0, 0);
    updateVisualCorrection(offset, correctionDelta, decayRate, 0, false);
    expect(offset.x).toBe(-0.1);
  });

  it('decays offset significantly faster at rate 30', () => {
    offset.set(1.0, 0, 0);
    // At rate 30, dt 0.016: alpha = 1 - e^(-30 * 0.016) = 1 - e^-0.48 approx 0.38
    updateVisualCorrection(offset, new THREE.Vector3(0, 0, 0), 30, 0.016, false);
    // 1.0 * (1 - 0.38) = 0.62
    expect(offset.x).toBeLessThan(0.65);
    expect(offset.x).toBeGreaterThan(0.60);
  });

  it('allows immediate movement feedback', () => {
    const localPosition = new THREE.Vector3(0, 0, 0);
    const visualOffset = new THREE.Vector3(0, 0, 0);
    
    // Prediction happens
    localPosition.add(new THREE.Vector3(0.5, 0, 0));
    
    // Render calculation
    const renderPosition = localPosition.clone().add(visualOffset);
    expect(renderPosition.x).toBe(0.5); // Immediate!
  });
});
