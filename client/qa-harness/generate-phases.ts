import type { Page } from 'playwright';
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

async function waitForAuthorityMainHand(
  page: Page,
  itemId: string | null,
  timeoutMs = 8_000,
) {
  // Prefer authority rows on window.__qaEquipment (server subscription); fall back to data-qa.
  await page.waitForFunction(
    (want) => {
      const eq = (window as unknown as {
        __qaEquipment?: ReadonlyArray<{ slot: string; itemId: string }>;
      }).__qaEquipment;
      if (eq) {
        const main = eq.find((row) => row.slot === 'main_hand');
        if (want === null) return !main;
        return main?.itemId === want;
      }
      if (want === null) {
        return !document.querySelector('[data-qa-unequip="main_hand"]');
      }
      const el = document.querySelector(`[data-qa-equip="${want}"]`);
      return el?.getAttribute('data-qa-equipped') === '1';
    },
    itemId,
    { timeout: timeoutMs },
  );
}

/**
 * Inventory sits under a full-viewport R3F canvas. While pointer lock is held,
 * Playwright's normal click hits the canvas instead of the panel. Exit lock and
 * force-click so equip/unequip is reachable mid-session.
 */
async function clickInventoryControl(
  page: Page,
  selector: string,
  timeoutMs = 15_000,
) {
  await page.evaluate(() => {
    if (document.pointerLockElement) document.exitPointerLock();
  });
  await page.waitForTimeout(80);
  const control = page.locator(selector).first();
  await control.waitFor({ state: 'visible', timeout: timeoutMs });
  await control.click({ force: true, timeout: timeoutMs });
}

type CapWant = {
  melee?: boolean;
  notMelee?: boolean;
  spell?: string;
  noSpells?: boolean;
};

async function waitForQaCapabilities(page: Page, want: CapWant, timeoutMs = 10_000) {
  await page.waitForFunction(
    (serialized) => {
      const caps = (window as unknown as {
        __qaCapabilities?: {
          melee: boolean;
          block: boolean;
          spells: readonly string[];
          drinkPotion: boolean;
        };
      }).__qaCapabilities;
      if (!caps) return false;
      const w = serialized as CapWant;
      if (w.melee === true && !caps.melee) return false;
      if (w.notMelee === true && caps.melee) return false;
      if (w.spell && !caps.spells.includes(w.spell)) return false;
      if (w.noSpells === true && caps.spells.length > 0) return false;
      return true;
    },
    want,
    { timeout: timeoutMs },
  );
}

async function reengagePointerLock(page: Page) {
  await page.mouse.move(640, 360, { steps: 1 });
  await page.waitForTimeout(50);
  if (!(await page.evaluate(() => document.pointerLockElement === document.body))) {
    await click(page);
    await page.waitForTimeout(200);
  }
}

async function readFireballCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = (window as unknown as { __gameDebug?: Record<string, unknown> }).__gameDebug
      ?.fireballProjectiles;
    return typeof v === 'number' ? v : 0;
  });
}

/** Cast fireball and hard-fail if no projectile is observed (grant/combat must work). */
async function castFireballAndExpectProjectile(page: Page, timeoutMs = 8_000) {
  await reengagePointerLock(page);
  await tapKey(page, 'Digit1');
  const before = await readFireballCount(page);
  // A few clicks — first may only re-lock; second/third should cast once grants are live.
  for (let i = 0; i < 3; i += 1) {
    await click(page);
    await page.waitForTimeout(350);
  }
  await page.waitForFunction(
    (prev) => {
      const v = (window as unknown as { __gameDebug?: Record<string, unknown> }).__gameDebug
        ?.fireballProjectiles;
      const n = typeof v === 'number' ? v : 0;
      return n > (prev as number);
    },
    before,
    { timeout: timeoutMs },
  );
}

/** Click attack while sword equipped; hard-fail if fireball still spawns (wrong grants). */
async function slashAndExpectNoFireball(page: Page, settleMs = 1200) {
  await reengagePointerLock(page);
  const before = await readFireballCount(page);
  await click(page);
  await page.waitForTimeout(settleMs);
  await click(page);
  await page.waitForTimeout(400);
  const after = await readFireballCount(page);
  if (after > before) {
    throw new Error(
      `Expected melee/sword equip to NOT spawn fireballs; fireballProjectiles ${before} -> ${after}`,
    );
  }
}

/**
 * Mid-session equip/unequip via InventoryPanel + hard combat grant asserts.
 * Order is load-bearing: wand → fireball, sword → no fireball / melee click, empty hands → no fireball.
 */
export function generateEquipPhases(): PhaseDef[] {
  const stationary = { kind: 'stationary' } as const;

  return [
    {
      name: 'equip_wand',
      group: 'matrix',
      expect: stationary,
      run: async ({ page }) => {
        await page.waitForSelector('[data-qa="inventory-panel"]', { timeout: 10_000 });
        const equip = page.locator('[data-qa-equip="wand"]');
        await equip.waitFor({ state: 'visible', timeout: 10_000 });
        if ((await equip.getAttribute('data-qa-equipped')) !== '1') {
          await clickInventoryControl(page, '[data-qa-equip="wand"]');
        }
        await page.locator('[data-qa-equip="wand"][data-qa-equipped="1"]').waitFor({
          state: 'visible',
          timeout: 8_000,
        });
        await waitForAuthorityMainHand(page, 'wand');
        // Live grants must flip to cast (paladin: sword→wand is the critical path).
        await waitForQaCapabilities(page, { spell: 'fireball', notMelee: true });
      },
    },
    {
      name: 'cast_after_equip_wand',
      group: 'matrix',
      expect: stationary,
      run: async ({ page }) => {
        const equip = page.locator('[data-qa-equip="wand"]');
        await equip.waitFor({ state: 'visible', timeout: 10_000 });
        if ((await equip.getAttribute('data-qa-equipped')) !== '1') {
          await clickInventoryControl(page, '[data-qa-equip="wand"]');
        }
        await waitForAuthorityMainHand(page, 'wand');
        await waitForQaCapabilities(page, { spell: 'fireball' });
        await castFireballAndExpectProjectile(page);
      },
    },
    {
      name: 'equip_sword',
      group: 'matrix',
      expect: stationary,
      run: async ({ page }) => {
        const equip = page.locator('[data-qa-equip="sword_1h"]');
        await equip.waitFor({ state: 'visible', timeout: 10_000 });
        if ((await equip.getAttribute('data-qa-equipped')) !== '1') {
          await clickInventoryControl(page, '[data-qa-equip="sword_1h"]');
        }
        await page.locator('[data-qa-equip="sword_1h"][data-qa-equipped="1"]').waitFor({
          state: 'visible',
          timeout: 8_000,
        });
        await waitForAuthorityMainHand(page, 'sword_1h');
        // Sword grants melee_slash only — cast spells must clear.
        await waitForQaCapabilities(page, { melee: true, noSpells: true });
      },
    },
    {
      name: 'slash_after_equip_sword',
      group: 'matrix',
      expect: stationary,
      run: async ({ page }) => {
        await waitForAuthorityMainHand(page, 'sword_1h');
        await waitForQaCapabilities(page, { melee: true, noSpells: true });
        await slashAndExpectNoFireball(page);
      },
    },
    {
      name: 'unequip_main_hand',
      group: 'matrix',
      expect: stationary,
      run: async ({ page }) => {
        await clickInventoryControl(page, '[data-qa-unequip="main_hand"]');
        await page.locator('[data-qa-unequip="main_hand"]').waitFor({
          state: 'hidden',
          timeout: 8_000,
        });
        await waitForAuthorityMainHand(page, null);
        await waitForQaCapabilities(page, { notMelee: true, noSpells: true });
        // Empty hands: casting must not produce a fireball.
        await reengagePointerLock(page);
        const before = await readFireballCount(page);
        await tapKey(page, 'Digit1');
        for (let i = 0; i < 3; i += 1) {
          await click(page);
          await page.waitForTimeout(300);
        }
        const after = await readFireballCount(page);
        if (after > before) {
          throw new Error(
            `Empty main_hand still cast fireball; fireballProjectiles ${before} -> ${after}`,
          );
        }
      },
    },
  ];
}

/** Preset ids that seed (or can equip into) cast grants — used by handwritten combat phases. */
export function classesWithSpell(
  spell: WizardSpell,
  configs: CapabilityConfigs = CHARACTER_CONFIGS,
): CharacterClass[] {
  return classesWith(configs, (config) => config.capabilities.spells.includes(spell));
}

export function classesWithMelee(
  configs: CapabilityConfigs = CHARACTER_CONFIGS,
): CharacterClass[] {
  return classesWith(configs, (config) => config.capabilities.melee);
}

export function classesWithBlock(
  configs: CapabilityConfigs = CHARACTER_CONFIGS,
): CharacterClass[] {
  return classesWith(configs, (config) => config.capabilities.block);
}

