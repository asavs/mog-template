import { describe, expect, it } from 'vitest';
import { generateActionMatrixPhases, generateMovementMatrix } from './generate-phases';
import { GENERATED_ACTION_MATRIX_PHASES, HANDWRITTEN_PHASES, PHASES, selectPhases } from './scenarios';

function phase(name: string) {
  const found = generateMovementMatrix().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing generated phase ${name}`);
  return found;
}

describe('generateMovementMatrix', () => {
  it('generates all 24 direction/modifier combinations with unique registry names (no sprint — see MODIFIERS comment)', () => {
    const matrix = generateMovementMatrix();
    expect(matrix).toHaveLength(24);
    expect(new Set(PHASES.map((candidate) => candidate.name)).size).toBe(PHASES.length);
    expect(PHASES.slice(0, HANDWRITTEN_PHASES.length)).toEqual(HANDWRITTEN_PHASES);
  });

  it('computes movement expectations from the jump/camera_turn modifiers', () => {
    expect(phase('mv_n').expect).toEqual({
      kind: 'linear-move',
      speed: 'walk',
      durationMs: 750,
    });
    expect(phase('mv_nw_jump').expect).toEqual({
      kind: 'linear-move',
      speed: 'walk',
      durationMs: 750,
      // Jump arc inflates 3D pathLength, so straightness is skipped.
      straight: false,
    });
    expect(phase('mv_se_turn').expect).toEqual({
      kind: 'max-speed',
      speed: 'walk',
      durationMs: 750,
    });
  });
});

describe('generateActionMatrixPhases', () => {
  it('generates exactly the eight named primitives, generically derived from ACTION_DEFS', () => {
    const phases = generateActionMatrixPhases();
    expect(phases.map((p) => p.name)).toEqual([
      'prim_light_tap',
      'prim_heavy_full_charge',
      'prim_heavy_early_release',
      'prim_block_absorb',
      'prim_roll_through_attack',
      'prim_potion',
      'prim_projectile_ability',
      'prim_aoe_ability',
    ]);
    expect(GENERATED_ACTION_MATRIX_PHASES.map((p) => p.name)).toEqual(phases.map((p) => p.name));
  });

  it('every generated primitive is in the matrix group, applies universally (v2 has no classes)', () => {
    for (const p of GENERATED_ACTION_MATRIX_PHASES) {
      expect(p.group).toBe('matrix');
    }
  });

  it('every primitive except roll expects stationary (roll displaces on purpose)', () => {
    for (const p of GENERATED_ACTION_MATRIX_PHASES) {
      if (p.name === 'prim_roll_through_attack') {
        expect(p.expect).toBeUndefined();
      } else {
        expect(p.expect).toEqual({ kind: 'stationary' });
      }
    }
  });
});

describe('selectPhases tiers', () => {
  it('uses a strict representative subset of movement phases in smoke, but always includes the action matrix', () => {
    const smoke = selectPhases(undefined, 'smoke');
    const full = selectPhases(undefined, 'full');
    const smokeNames = new Set(smoke.map((candidate) => candidate.name));

    expect(smoke.length).toBeLessThan(full.length);
    expect(smoke.every((candidate) =>
      full.some((fullPhase) => fullPhase.name === candidate.name),
    )).toBe(true);
    expect(smokeNames.has('prim_light_tap')).toBe(true);
    expect(smokeNames.has('prim_block_absorb')).toBe(true);
  });

  it('lets an explicit generated name bypass the smoke subset', () => {
    const selected = selectPhases('mv_s_turn', 'smoke');
    expect(selected.map((candidate) => candidate.name)).toEqual(['mv_s_turn']);
  });
});
