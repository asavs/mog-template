import {
  CHARACTER_CONFIGS,
  type CharacterConfigKey,
  type WizardSpell,
} from '../src/components/characterConfig.ts';
import { click, lookAround, tapKey, type PhaseDef } from './phase-helpers';
import type { CharacterClass } from './trace-types';

const MOVEMENT_DURATION_MS = 1500;

const DIRECTIONS = [
  ['n', ['KeyW']],
  ['s', ['KeyS']],
  ['e', ['KeyD']],
  ['w', ['KeyA']],
  ['ne', ['KeyW', 'KeyD']],
  ['nw', ['KeyW', 'KeyA']],
  ['se', ['KeyS', 'KeyD']],
  ['sw', ['KeyS', 'KeyA']],
] as const;

const MODIFIERS = ['none', 'jump', 'camera_turn'] as const;

type CapabilityConfig = {
  capabilities: {
    melee: boolean;
    block: boolean;
    spells: readonly WizardSpell[];
    drinkPotion: boolean;
  };
};

type CapabilityConfigs = Record<string, CapabilityConfig>;

async function runMovement(
  page: Parameters<PhaseDef['run']>[0]['page'],
  directionKeys: readonly string[],
  sprint: boolean,
  modifier: (typeof MODIFIERS)[number],
) {
  const keys = sprint ? ['ShiftLeft', ...directionKeys] : [...directionKeys];
  for (const key of keys) await page.keyboard.down(key);

  try {
    if (modifier === 'none') {
      await page.waitForTimeout(MOVEMENT_DURATION_MS);
      return;
    }

    await page.waitForTimeout(650);
    if (modifier === 'jump') {
      await tapKey(page, 'Space');
      await page.waitForTimeout(MOVEMENT_DURATION_MS - 770);
    } else {
      await lookAround(page, 10, 8);
      await page.waitForTimeout(MOVEMENT_DURATION_MS - 810);
    }
  } finally {
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
  }
}

function movementName(
  direction: string,
  sprint: boolean,
  modifier: (typeof MODIFIERS)[number],
): string {
  const parts = [`mv_${direction}`];
  if (sprint) parts.push('sprint');
  if (modifier === 'jump') parts.push('jump');
  if (modifier === 'camera_turn') parts.push('turn');
  return parts.join('_');
}

export function generateMovementMatrix(): PhaseDef[] {
  const phases: PhaseDef[] = [];

  for (const [direction, keys] of DIRECTIONS) {
    for (const sprint of [false, true]) {
      for (const modifier of MODIFIERS) {
        phases.push({
          name: movementName(direction, sprint, modifier),
          group: 'matrix',
          // Camera-relative movement curves while the camera turns. Its net
          // displacement may shrink, so only the configured speed cap applies.
          // Jump phases keep the distance expectation but skip straightness:
          // the vertical arc inflates 3D pathLength (see invariants.ts).
          expect:
            modifier === 'camera_turn'
              ? {
                  kind: 'max-speed',
                  speed: sprint ? 'sprint' : 'walk',
                  durationMs: MOVEMENT_DURATION_MS,
                }
              : {
                  kind: 'linear-move',
                  speed: sprint ? 'sprint' : 'walk',
                  durationMs: MOVEMENT_DURATION_MS,
                  ...(modifier === 'jump' ? { straight: false as const } : {}),
                },
          run: ({ page }) => runMovement(page, keys, sprint, modifier),
        });
      }
    }
  }

  return phases;
}

const SPELL_KEYS: Record<WizardSpell, 'Digit1' | 'Digit2'> = {
  fireball: 'Digit1',
  lightning: 'Digit2',
};

function classesWith(
  configs: CapabilityConfigs,
  predicate: (config: CapabilityConfig) => boolean,
): CharacterClass[] {
  return (Object.entries(configs) as Array<[CharacterConfigKey, CapabilityConfig]>)
    .filter(([, config]) => predicate(config))
    .map(([characterClass]) => characterClass);
}

export function generateCapabilityPhases(
  configs: CapabilityConfigs = CHARACTER_CONFIGS,
): PhaseDef[] {
  const phases: PhaseDef[] = [];
  const stationary = { kind: 'stationary' } as const;

  const meleeClasses = classesWith(configs, (config) => config.capabilities.melee);
  if (meleeClasses.length > 0) {
    phases.push({
      name: 'gen_melee_slash',
      group: 'matrix',
      classes: meleeClasses,
      expect: stationary,
      run: async ({ page }) => {
        await click(page);
        await page.waitForTimeout(1300);
        await click(page);
        await page.waitForTimeout(600);
      },
    });
  }

  const blockClasses = classesWith(configs, (config) => config.capabilities.block);
  if (blockClasses.length > 0) {
    phases.push({
      name: 'gen_block_hold',
      group: 'matrix',
      classes: blockClasses,
      expect: stationary,
      run: async ({ page }) => {
        await page.mouse.down({ button: 'right' });
        await page.waitForTimeout(800);
        await page.mouse.up({ button: 'right' });
        await page.waitForTimeout(300);
      },
    });
  }

  for (const spell of Object.keys(SPELL_KEYS) as WizardSpell[]) {
    const spellClasses = classesWith(
      configs,
      (config) => config.capabilities.spells.includes(spell),
    );
    if (spellClasses.length === 0) continue;

    phases.push({
      name: `gen_spell_${spell}`,
      group: 'matrix',
      classes: spellClasses,
      expect: stationary,
      run: async ({ page }) => {
        await tapKey(page, SPELL_KEYS[spell]);
        await click(page);
        await page.waitForTimeout(400);
        await click(page);
        await page.waitForTimeout(600);
      },
    });
  }

  const potionClasses = classesWith(
    configs,
    (config) => config.capabilities.drinkPotion,
  );
  if (potionClasses.length > 0) {
    phases.push({
      name: 'gen_potion_drink',
      group: 'matrix',
      classes: potionClasses,
      expect: stationary,
      run: async ({ page }) => {
        await tapKey(page, 'Digit4');
        await click(page);
        await page.waitForTimeout(1500);
      },
    });
  }

  return phases;
}

