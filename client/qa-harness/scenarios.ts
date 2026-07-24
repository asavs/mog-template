/**
 * Phase registry: every game action the harness can drive, as an ordered,
 * individually selectable unit.
 *
 * Registry order is the execution order and it is deliberate — cheap
 * foundational primitives (plain movement) run before composites (jump while
 * moving, lag spike) and combat, so a fundamental breakage fails first and
 * later failures can be read as downstream noise. `QA_PHASES` selects a
 * subset by phase name or group name (e.g. `QA_PHASES=jump_idle` or
 * `QA_PHASES=movement,combat`) while preserving registry order, which makes
 * a single action re-runnable in seconds while debugging.
 *
 * Content note: capability phases derive from catalog loadout presets
 * (`CHARACTER_CONFIGS`); join uses catalog button labels. The registry shape
 * — not the fixed class list — is the durable part.
 */
import {
  click,
  holdKey,
  holdKeys,
  lookAround,
  tapKey,
  type PhaseDef,
  type PhaseGroup,
} from './phase-helpers';
import { generateCapabilityPhases, generateMovementMatrix } from './generate-phases';
import type { CharacterClass } from './trace-types';

export type { PhaseContext, PhaseDef, PhaseGroup } from './phase-helpers';
export const HANDWRITTEN_PHASES: PhaseDef[] = [
  {
    name: 'walk_forward',
    group: 'movement',
    expect: { kind: 'linear-move', speed: 'walk', durationMs: 1500 },
    run: ({ page }) => holdKey(page, 'KeyW', 1500),
  },
  {
    name: 'walk_backward',
    group: 'movement',
    expect: { kind: 'linear-move', speed: 'walk', durationMs: 1500 },
    run: ({ page }) => holdKey(page, 'KeyS', 1500),
  },
  {
    name: 'strafe_left',
    group: 'movement',
    expect: { kind: 'linear-move', speed: 'walk', durationMs: 1500 },
    run: ({ page }) => holdKey(page, 'KeyA', 1500),
  },
  {
    name: 'strafe_right',
    group: 'movement',
    expect: { kind: 'linear-move', speed: 'walk', durationMs: 1500 },
    run: ({ page }) => holdKey(page, 'KeyD', 1500),
  },
  {
    name: 'walk_forward_left',
    group: 'movement',
    expect: { kind: 'linear-move', speed: 'walk', durationMs: 1500 },
    run: ({ page }) => holdKeys(page, ['KeyW', 'KeyA'], 1500),
  },
  {
    name: 'walk_forward_right',
    group: 'movement',
    expect: { kind: 'linear-move', speed: 'walk', durationMs: 1500 },
    run: ({ page }) => holdKeys(page, ['KeyW', 'KeyD'], 1500),
  },
  {
    name: 'sprint_forward',
    group: 'movement',
    expect: { kind: 'linear-move', speed: 'sprint', durationMs: 1500 },
    run: async ({ page }) => {
      await page.keyboard.down('ShiftLeft');
      await holdKey(page, 'KeyW', 1500);
      await page.keyboard.up('ShiftLeft');
    },
  },
  {
    name: 'staccato_forward',
    group: 'movement',
    run: async ({ page }) => {
      for (let i = 0; i < 5; i += 1) {
        await page.keyboard.down('KeyW');
        await page.waitForTimeout(250);
        await page.keyboard.up('KeyW');
        await page.waitForTimeout(250);
      }
    },
  },
  {
    name: 'direction_change',
    group: 'movement',
    run: async ({ page }) => {
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(600);
      await page.keyboard.down('KeyD');
      await page.keyboard.up('KeyW');
      await page.waitForTimeout(600);
      await page.keyboard.down('KeyS');
      await page.keyboard.up('KeyD');
      await page.waitForTimeout(600);
      await page.keyboard.up('KeyS');
    },
  },
  {
    name: 'sprint_toggle',
    group: 'movement',
    run: async ({ page }) => {
      let shiftDown = false;
      await page.keyboard.down('KeyW');
      for (let elapsed = 0; elapsed < 2400; elapsed += 400) {
        if (shiftDown) await page.keyboard.up('ShiftLeft');
        else await page.keyboard.down('ShiftLeft');
        shiftDown = !shiftDown;
        await page.waitForTimeout(400);
      }
      if (shiftDown) await page.keyboard.up('ShiftLeft');
      await page.waitForTimeout(100);
      await page.keyboard.up('KeyW');
    },
  },
  {
    name: 'sprint_strafe',
    group: 'movement',
    run: async ({ page }) => {
      await holdKeys(page, ['ShiftLeft', 'KeyA'], 1000);
      await holdKeys(page, ['ShiftLeft', 'KeyD'], 1000);
    },
  },
  {
    name: 'circle_run',
    group: 'movement',
    run: async ({ page }) => {
      await page.keyboard.down('KeyW');
      // ~35 steps keeps this under ~3s wall time: each mouse.move round-trip
      // costs ~50-70ms beyond the nominal 16ms wait (measured live), so the
      // original 150-step sweep ran ~10s. Same total yaw (~600px).
      await lookAround(page, 35, 17);
      await page.keyboard.up('KeyW');
    },
  },
  {
    name: 'jump_idle',
    group: 'movement',
    expect: { kind: 'stationary' },
    run: async ({ page }) => {
      await tapKey(page, 'Space');
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'jump_while_moving',
    group: 'movement',
    // straight: false — the jump arc inflates 3D pathLength (see invariants.ts).
    expect: { kind: 'linear-move', speed: 'walk', durationMs: 1020, straight: false },
    run: async ({ page }) => {
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(200);
      await tapKey(page, 'Space');
      await page.waitForTimeout(700);
      await page.keyboard.up('KeyW');
    },
  },
  {
    name: 'jump_at_direction_change',
    group: 'movement',
    run: async ({ page }) => {
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(400);
      await page.keyboard.up('KeyW');
      await page.keyboard.down('KeyD');
      await tapKey(page, 'Space');
      await page.waitForTimeout(800);
      await page.keyboard.up('KeyD');
    },
  },
  {
    name: 'lag_spike_walk_forward',
    group: 'network',
    run: async ({ page, cdp }) => {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 400,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await holdKey(page, 'KeyW', 1500);
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'cast_fireball',
    group: 'combat',
    classes: ['wizard'],
    expect: { kind: 'stationary' },
    run: async ({ page }) => {
      await tapKey(page, 'Digit1');
      await lookAround(page, 5, 15);
      await click(page);
      await page.waitForTimeout(400);
      await click(page);
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'cast_lightning',
    group: 'combat',
    classes: ['wizard'],
    expect: { kind: 'stationary' },
    run: async ({ page }) => {
      await tapKey(page, 'Digit2');
      await lookAround(page, 5, -15);
      await click(page);
      await page.waitForTimeout(400);
      await click(page);
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'stop_cast',
    group: 'combat',
    classes: ['wizard'],
    run: async ({ page }) => {
      await page.keyboard.down('ShiftLeft');
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(800);
      await page.keyboard.up('KeyW');
      await page.keyboard.up('ShiftLeft');
      await tapKey(page, 'Digit1');
      await click(page);
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'attack_slash',
    group: 'combat',
    classes: ['paladin'],
    expect: { kind: 'stationary' },
    run: async ({ page }) => {
      await click(page);
      await page.waitForTimeout(1300);
      await click(page);
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'block_hold',
    group: 'combat',
    classes: ['paladin'],
    expect: { kind: 'stationary' },
    run: async ({ page }) => {
      await page.mouse.down({ button: 'right' });
      await page.waitForTimeout(800);
      await page.mouse.up({ button: 'right' });
      await page.waitForTimeout(300);
    },
  },
];

export const GENERATED_MOVEMENT_PHASES = generateMovementMatrix();
export const GENERATED_CAPABILITY_PHASES = generateCapabilityPhases();
export const PHASES: PhaseDef[] = [
  ...HANDWRITTEN_PHASES,
  ...GENERATED_MOVEMENT_PHASES,
  ...GENERATED_CAPABILITY_PHASES,
];

export type QaTier = 'smoke' | 'full';

const PHASE_GROUPS: PhaseGroup[] = ['movement', 'network', 'combat', 'matrix'];
const GENERATED_MOVEMENT_NAMES = new Set(GENERATED_MOVEMENT_PHASES.map((phase) => phase.name));
const SMOKE_MOVEMENT_NAMES = new Set([
  'mv_n',
  'mv_e_sprint',
  'mv_nw',
  'mv_w_jump',
  'mv_se_sprint_jump',
  'mv_ne_turn',
  'mv_sw_sprint_turn',
]);

export function parseQaTier(value: string | undefined): QaTier {
  const tier = value?.trim() || 'smoke';
  if (tier !== 'smoke' && tier !== 'full') {
    throw new Error(`QA_TIER: expected smoke or full, received ${tier}`);
  }
  return tier;
}
/**
 * Resolves a `QA_PHASES` spec (comma-separated phase and/or group names;
 * undefined or empty means "everything") to the phases applicable to a
 * class, always in registry order.
 */
export function selectPhases(
  spec: string | undefined,
  characterClass: CharacterClass,
  tier: QaTier = 'smoke',
): PhaseDef[] {
  const applicable = PHASES.filter((phase) =>
    !phase.classes || phase.classes.includes(characterClass),
  );
  const wanted = (spec ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const known = new Set<string>([...PHASES.map((phase) => phase.name), ...PHASE_GROUPS]);
  const unknown = wanted.filter((value) => !known.has(value));
  if (unknown.length > 0) {
    throw new Error(
      `QA_PHASES: unknown phase/group name(s): ${unknown.join(', ')} ` +
      `(known groups: ${PHASE_GROUPS.join(', ')}; ${PHASES.length} phase names — ` +
      'see scenarios.ts/generate-phases.ts, e.g. walk_forward, mv_nw_sprint_jump)',
    );
  }

  const tiered = tier === 'full'
    ? applicable
    : applicable.filter((phase) =>
        !GENERATED_MOVEMENT_NAMES.has(phase.name) ||
        SMOKE_MOVEMENT_NAMES.has(phase.name) ||
        wanted.includes(phase.name),
      );

  if (wanted.length === 0) return tiered;
  return tiered.filter((phase) => wanted.includes(phase.name) || wanted.includes(phase.group));
}
