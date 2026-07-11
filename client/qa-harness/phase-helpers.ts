import type { CDPSession, Page } from 'playwright';
import type { PhaseExpectation } from './invariants';
import type { CharacterClass } from './trace-types';

export type PhaseGroup = 'movement' | 'network' | 'combat' | 'matrix';

export type PhaseContext = {
  page: Page;
  cdp: CDPSession;
  characterClass: CharacterClass;
};

export type PhaseDef = {
  name: string;
  group: PhaseGroup;
  /** Restrict to specific classes; omit for all. */
  classes?: CharacterClass[];
  expect?: PhaseExpectation;
  run: (ctx: PhaseContext) => Promise<void>;
};

export async function holdKey(page: Page, code: string, ms: number) {
  await page.keyboard.down(code);
  await page.waitForTimeout(ms);
  await page.keyboard.up(code);
}

export async function holdKeys(page: Page, codes: string[], ms: number) {
  for (const code of codes) await page.keyboard.down(code);
  await page.waitForTimeout(ms);
  for (const code of [...codes].reverse()) await page.keyboard.up(code);
}

export async function tapKey(page: Page, code: string, ms = 120) {
  await page.keyboard.down(code);
  await page.waitForTimeout(ms);
  await page.keyboard.up(code);
}

export async function click(page: Page) {
  await page.mouse.down();
  await page.mouse.up();
}

export async function lookAround(page: Page, steps: number, stepX: number) {
  // Re-center the pointer first: under pointer lock the first mouse.move
  // reports movementX relative to wherever the pointer last sat, and a large
  // initial delta reads as a violent yaw spike (measured live as an 18u
  // single-frame position jump).
  await page.mouse.move(640, 360, { steps: 1 });
  await page.waitForTimeout(100);
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.move(640 + stepX * (i + 1), 360, { steps: 1 });
    await page.waitForTimeout(16);
  }
}
