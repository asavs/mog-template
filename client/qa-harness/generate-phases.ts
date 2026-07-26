import type { Page } from 'playwright';
import { lookAround, tapKey, type PhaseDef } from './phase-helpers';
import { ACTION_DEFS, SLOT_BINDINGS, type ActionDef, type SlotBinding } from '../src/actions/defs.generated';
import { Phase } from '../src/actions/gates';
import { KEY_BINDINGS, MOUSE_BINDINGS } from '../src/input/keymap';
import { readLocalStoreField } from './page-driver';

// 750ms, not the pre-rewrite 1500ms — see scenarios.ts's module doc: v2's small arena gives
// every spawn's default facing only 5.55 units of clearance to its nearest wall, and
// PLAYER_SPEED * 1500ms (9 units) drove straight into it. Scaled by the same 0.5 factor as
// the handwritten movement phases so distances stay comparable across both.
const MOVEMENT_DURATION_MS = 750;

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

// v2 has no key bound to sprint (client/src/input/keymap.ts: "Sprint exists in the wire
// InputState but intentionally has no default key"; ShiftLeft is bound to the `roll` slot
// instead) — the old sprint dimension of this matrix would now roll the bot mid-walk instead
// of sprinting it, so it is dropped rather than silently testing the wrong thing.
const MODIFIERS = ['none', 'jump', 'camera_turn'] as const;

async function runMovement(
  page: Parameters<PhaseDef['run']>[0]['page'],
  directionKeys: readonly string[],
  modifier: (typeof MODIFIERS)[number],
) {
  for (const key of directionKeys) await page.keyboard.down(key);

  try {
    if (modifier === 'none') {
      await page.waitForTimeout(MOVEMENT_DURATION_MS);
      return;
    }

    await page.waitForTimeout(325);
    if (modifier === 'jump') {
      await tapKey(page, 'Space', 60);
      await page.waitForTimeout(MOVEMENT_DURATION_MS - 385);
    } else {
      await lookAround(page, 10, 8);
      await page.waitForTimeout(MOVEMENT_DURATION_MS - 405);
    }
  } finally {
    for (const key of [...directionKeys].reverse()) await page.keyboard.up(key);
  }
}

function movementName(direction: string, modifier: (typeof MODIFIERS)[number]): string {
  const parts = [`mv_${direction}`];
  if (modifier === 'jump') parts.push('jump');
  if (modifier === 'camera_turn') parts.push('turn');
  return parts.join('_');
}

/** Generic over direction/modifier only — no character concept involved. Sprint dropped, see
 * the MODIFIERS comment above. */
export function generateMovementMatrix(): PhaseDef[] {
  const phases: PhaseDef[] = [];

  for (const [direction, keys] of DIRECTIONS) {
    for (const modifier of MODIFIERS) {
      phases.push({
        name: movementName(direction, modifier),
        group: 'matrix',
        // Camera-relative movement curves while the camera turns. Its net
        // displacement may shrink, so only the configured speed cap applies.
        // Jump phases keep the distance expectation but skip straightness:
        // the vertical arc inflates 3D pathLength (see invariants.ts).
        expect:
          modifier === 'camera_turn'
            ? { kind: 'max-speed', speed: 'walk', durationMs: MOVEMENT_DURATION_MS }
            : {
                kind: 'linear-move',
                speed: 'walk',
                durationMs: MOVEMENT_DURATION_MS,
                ...(modifier === 'jump' ? { straight: false as const } : {}),
              },
        run: ({ page }) => runMovement(page, keys, modifier),
      });
    }
  }

  return phases;
}

// ---------------------------------------------------------------------------
// Action primitive matrix (Wave 3F, v2). Every joined player has every capability — v2 has no
// character classes, no equip system, no per-class capability gate
// (docs/action-pipeline.md: "Row membership IS the capability gate", and SLOT_BINDINGS seeds
// identically for everyone on join). So instead of one phase per (class, capability), this
// generates one phase per PRIMITIVE — a shape of the action pipeline itself — picked
// generically from shared/actions.json's own data (never a hardcoded action id):
//   light tap / heavy full charge / heavy early release: the dual-bound slot whose hold action
//     is `hold.mode: "charge"` (today: primary/attack_light+attack_heavy, but this generalizes
//     to whichever slot authors that shape).
//   block absorb: the def carrying a `mitigation` effect.
//   roll through attack: the def carrying an `invulnerable` effect.
//   potion: the def with a `resource` cost.
//   projectile ability / aoe ability: the first def (registry order) carrying a `projectile` /
//     `aoe_at_target` effect.
// All of these drive REAL keyboard/mouse input through the client's own keymap
// (client/src/input/keymap.ts) — never a synthetic escape hatch — so they exercise the exact
// same intents.ts/useInput.ts path a player does, and therefore require pointer lock to be
// engaged (see run-harness.ts's acquirePointerLock) exactly like the old class-gated combat
// phases did. That also means, like those, they cannot run where pointer lock never engages
// (GitHub-hosted CI runners — see qa-harness/README.md's "Playwright pointer lock" note).
// ---------------------------------------------------------------------------

type SlotInput = { kind: 'key'; code: string } | { kind: 'mouse'; button: 'left' | 'right' | 'middle' };

const MOUSE_BUTTON_NAMES: Record<number, 'left' | 'right' | 'middle'> = { 0: 'left', 1: 'middle', 2: 'right' };

function slotInputMap(): Map<string, SlotInput> {
  const map = new Map<string, SlotInput>();
  for (const row of KEY_BINDINGS) {
    if (row.binding.kind === 'slot') map.set(row.binding.slot, { kind: 'key', code: row.code });
  }
  for (const row of MOUSE_BINDINGS) {
    map.set(row.binding.slot, { kind: 'mouse', button: MOUSE_BUTTON_NAMES[row.button] ?? 'left' });
  }
  return map;
}
const SLOT_INPUTS = slotInputMap();

function slotInput(slot: string): SlotInput {
  const input = SLOT_INPUTS.get(slot);
  if (!input) throw new Error(`generate-phases: no physical input bound to slot ${slot} (client/src/input/keymap.ts)`);
  return input;
}

export async function pressSlot(page: Page, slot: string) {
  const input = slotInput(slot);
  if (input.kind === 'key') await page.keyboard.down(input.code);
  else await page.mouse.down({ button: input.button });
}
export async function releaseSlot(page: Page, slot: string) {
  const input = slotInput(slot);
  if (input.kind === 'key') await page.keyboard.up(input.code);
  else await page.mouse.up({ button: input.button });
}

export function bindingFor(actionId: string): SlotBinding {
  const binding = SLOT_BINDINGS.find((b) => b.tapAction === actionId || b.holdAction === actionId);
  if (!binding) throw new Error(`generate-phases: no SLOT_BINDINGS row binds ${actionId}`);
  return binding;
}

function findChargeHold(): { def: ActionDef; binding: SlotBinding } {
  for (const binding of SLOT_BINDINGS) {
    if (!binding.holdAction) continue;
    const def = ACTION_DEFS.find((d) => d.id === binding.holdAction);
    if (def?.hold?.mode === 'charge') return { def, binding };
  }
  throw new Error('generate-phases: no charge-mode hold action found in ACTION_DEFS');
}

function findTapOf(binding: SlotBinding): ActionDef {
  const def = ACTION_DEFS.find((d) => d.id === binding.tapAction);
  if (!def) throw new Error(`generate-phases: dual-bound slot ${binding.slot} has no tap action def`);
  return def;
}

export function findByEffect(kind: string): { def: ActionDef; binding: SlotBinding } {
  const def = ACTION_DEFS.find((d) => d.effects.some((e) => e.kind === kind));
  if (!def) throw new Error(`generate-phases: no ActionDef carries a ${kind} effect`);
  return { def, binding: bindingFor(def.id) };
}

function findResourceCosting(): { def: ActionDef; binding: SlotBinding } {
  const def = ACTION_DEFS.find((d) => d.resource !== null);
  if (!def) throw new Error('generate-phases: no ActionDef has a resource cost');
  return { def, binding: bindingFor(def.id) };
}

/** Polls the local identity's `player_action_state.phase` via single in-page round trips
 * (readLocalStoreField) until it reaches `phase` — cheap because each poll is one
 * page.evaluate, not a per-frame browser trace read. */
export async function waitForActionPhase(page: Page, phase: number, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readLocalStoreField(page, 'playerActionState', 'phase');
    if (current === phase) return;
    await page.waitForTimeout(30);
  }
  throw new Error(`generate-phases: timed out waiting for action phase ${phase}`);
}

export async function waitForIdle(page: Page, timeoutMs = 12000) {
  await waitForActionPhase(page, Phase.Idle, timeoutMs);
}

export function generateActionMatrixPhases(): PhaseDef[] {
  const stationary = { kind: 'stationary' } as const;
  const { def: heavyDef, binding: primaryBinding } = findChargeHold();
  findTapOf(primaryBinding); // asserts the dual-bound slot really has a tap side too
  const blockCase = findByEffect('mitigation');
  const rollCase = findByEffect('invulnerable');
  const potionCase = findResourceCosting();
  const projectileCase = findByEffect('projectile');
  const aoeCase = findByEffect('aoe_at_target');

  if (!heavyDef.hold || heavyDef.hold.mode !== 'charge') {
    throw new Error('generate-phases: expected the found hold action to be charge-mode');
  }
  const holdSpec = heavyDef.hold;

  return [
    {
      name: 'prim_light_tap',
      group: 'matrix',
      expect: stationary,
      run: async ({ page }) => {
        await pressSlot(page, primaryBinding.slot);
        await releaseSlot(page, primaryBinding.slot); // well within the hold threshold -> tap
        await waitForIdle(page);
      },
    },
    {
      name: 'prim_heavy_full_charge',
      group: 'matrix',
      expect: stationary,
      run: async ({ page }) => {
        await pressSlot(page, primaryBinding.slot);
        // Hold well past maxTicks so the server force-releases at full charge.
        await page.waitForTimeout(((holdSpec.maxTicks + 3) * 1000) / 20);
        await releaseSlot(page, primaryBinding.slot);
        await waitForIdle(page);
      },
    },
    {
      name: 'prim_heavy_early_release',
      group: 'matrix',
      expect: stationary,
      run: async ({ page }) => {
        await pressSlot(page, primaryBinding.slot);
        // Past the slot's own hold threshold (resolves to the HEAVY action, not the tap) but
        // well short of maxTicks (a partial, not full, charge fraction).
        const midTicks = Math.max(
          primaryBinding.holdThresholdTicks + 1,
          Math.floor((holdSpec.minTicks + holdSpec.maxTicks) / 2),
        );
        await page.waitForTimeout((midTicks * 1000) / 20);
        await releaseSlot(page, primaryBinding.slot);
        await waitForIdle(page);
      },
    },
    {
      name: 'prim_block_absorb',
      group: 'matrix',
      expect: stationary,
      run: async ({ page }) => {
        await pressSlot(page, blockCase.binding.slot);
        await waitForActionPhase(page, Phase.Held);
        await page.waitForTimeout(300);
        await releaseSlot(page, blockCase.binding.slot);
        await waitForIdle(page);
      },
    },
    {
      name: 'prim_roll_through_attack',
      group: 'matrix',
      // Not stationary: roll's whole point is displacement (shared/actions.json's
      // displace_self effect on this def).
      run: async ({ page }) => {
        await pressSlot(page, rollCase.binding.slot);
        await releaseSlot(page, rollCase.binding.slot);
        await waitForIdle(page);
      },
    },
    {
      name: 'prim_potion',
      group: 'matrix',
      expect: stationary,
      run: async ({ page }) => {
        await pressSlot(page, potionCase.binding.slot);
        await releaseSlot(page, potionCase.binding.slot);
        await waitForIdle(page);
      },
    },
    {
      name: 'prim_projectile_ability',
      group: 'matrix',
      expect: stationary,
      run: async ({ page }) => {
        await pressSlot(page, projectileCase.binding.slot);
        await releaseSlot(page, projectileCase.binding.slot);
        await waitForIdle(page);
      },
    },
    {
      name: 'prim_aoe_ability',
      group: 'matrix',
      expect: stationary,
      run: async ({ page }) => {
        await pressSlot(page, aoeCase.binding.slot);
        await releaseSlot(page, aoeCase.binding.slot);
        await waitForIdle(page);
      },
    },
  ];
}
