import { describe, expect, it } from 'vitest';
import {
  classesWithSpell,
  generateCapabilityPhases,
  generateEquipPhases,
  generateMovementMatrix,
} from './generate-phases';
import {
  GENERATED_CAPABILITY_PHASES,
  GENERATED_EQUIP_PHASES,
  HANDWRITTEN_PHASES,
  PHASES,
  selectPhases,
} from './scenarios';

function phase(name: string) {
  const found = generateMovementMatrix().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing generated phase ${name}`);
  return found;
}

describe('generateMovementMatrix', () => {
  it('generates all 48 axis combinations with unique registry names', () => {
    const matrix = generateMovementMatrix();
    expect(matrix).toHaveLength(48);
    expect(new Set(PHASES.map((candidate) => candidate.name)).size).toBe(PHASES.length);
    expect(PHASES.slice(0, HANDWRITTEN_PHASES.length)).toEqual(HANDWRITTEN_PHASES);
  });

  it('computes movement expectations from sprint and modifier axes', () => {
    expect(phase('mv_n').expect).toEqual({
      kind: 'linear-move',
      speed: 'walk',
      durationMs: 1500,
    });
    expect(phase('mv_nw_sprint_jump').expect).toEqual({
      kind: 'linear-move',
      speed: 'sprint',
      durationMs: 1500,
      // Jump arc inflates 3D pathLength, so straightness is skipped.
      straight: false,
    });
    expect(phase('mv_se_sprint_turn').expect).toEqual({
      kind: 'max-speed',
      speed: 'sprint',
      durationMs: 1500,
    });
  });
});

describe('generateCapabilityPhases', () => {
  it('derives shared actions and omissions from injected capabilities', () => {
    const phases = generateCapabilityPhases({
      paladin: {
        capabilities: {
          melee: true,
          block: false,
          spells: [],
          drinkPotion: false,
        },
      },
      wizard: {
        capabilities: {
          melee: true,
          block: false,
          spells: [],
          drinkPotion: false,
        },
      },
    });

    expect(phases.map((candidate) => candidate.name)).toEqual(['gen_melee_slash']);
    expect(phases[0]?.classes).toEqual(['paladin', 'wizard']);
  });

  it('marks every real capability phase stationary', () => {
    expect(GENERATED_CAPABILITY_PHASES.length).toBeGreaterThan(0);
    for (const capabilityPhase of GENERATED_CAPABILITY_PHASES) {
      expect(capabilityPhase.expect).toEqual({ kind: 'stationary' });
    }
  });

  it('includes acolyte (and wizard) on fireball capability phases when catalog has them', () => {
    const fireball = GENERATED_CAPABILITY_PHASES.find((p) => p.name === 'gen_spell_fireball');
    expect(fireball).toBeDefined();
    const classes = fireball?.classes ?? [];
    expect(classes).toContain('wizard');
    if (classesWithSpell('fireball').includes('acolyte')) {
      expect(classes).toContain('acolyte');
    }
  });
});

describe('generateEquipPhases', () => {
  it('registers equip grant-flip phases in order', () => {
    const names = generateEquipPhases().map((p) => p.name);
    expect(names).toEqual([
      'equip_wand',
      'cast_after_equip_wand',
      'equip_sword',
      'slash_after_equip_sword',
      'unequip_main_hand',
    ]);
    expect(GENERATED_EQUIP_PHASES.map((p) => p.name)).toEqual(names);
  });

  it('applies to every class (no classes filter) so paladin can equip into cast', () => {
    for (const phase of GENERATED_EQUIP_PHASES) {
      expect(phase.classes).toBeUndefined();
      expect(phase.expect).toEqual({ kind: 'stationary' });
    }
  });

  it('is selected under matrix group and for acolyte/wizard/paladin', () => {
    for (const cls of ['wizard', 'paladin', 'acolyte'] as const) {
      const selected = selectPhases('matrix', cls, 'smoke');
      const names = new Set(selected.map((p) => p.name));
      expect(names.has('equip_wand')).toBe(true);
      expect(names.has('cast_after_equip_wand')).toBe(true);
      expect(names.has('equip_sword')).toBe(true);
      expect(names.has('slash_after_equip_sword')).toBe(true);
      expect(names.has('unequip_main_hand')).toBe(true);
    }
  });
});

describe('selectPhases tiers', () => {
  it('uses a strict representative subset of movement phases in smoke', () => {
    const smoke = selectPhases(undefined, 'wizard', 'smoke');
    const full = selectPhases(undefined, 'wizard', 'full');
    const smokeNames = new Set(smoke.map((candidate) => candidate.name));

    expect(smoke.length).toBeLessThan(full.length);
    expect(smoke.every((candidate) =>
      full.some((fullPhase) => fullPhase.name === candidate.name),
    )).toBe(true);
    expect(smokeNames.has('gen_spell_fireball')).toBe(true);
  });

  it('lets an explicit generated name bypass the smoke subset', () => {
    const selected = selectPhases('mv_s_sprint_turn', 'wizard', 'smoke');
    expect(selected.map((candidate) => candidate.name)).toEqual(['mv_s_sprint_turn']);
  });
});
