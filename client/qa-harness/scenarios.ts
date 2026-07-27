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
 * v2 has no character classes and no equip system — every joined player has
 * every capability (shared/actions.json's SLOT_BINDINGS seed identically for
 * everyone, docs/action-pipeline.md: "Row membership IS the capability
 * gate"). Combat coverage is the generic action-primitive matrix
 * (generate-phases.ts's `generateActionMatrixPhases`), derived from
 * ACTION_DEFS/SLOT_BINDINGS data rather than a per-class capability list.
 *
 * Movement hold durations are 750ms (not the pre-rewrite 1500ms): v2's arena
 * (shared/arena.json) is a small 40x40 room, and every authored spawn's
 * default facing (yaw) points at its NEAREST wall — server-verified
 * clearance is exactly 5.55 units (spawn-to-wall minus PLAYER_COLLISION_RADIUS,
 * see server/spacetimedb/src/collision.rs) — so a full 1500ms hold at
 * PLAYER_SPEED (9 units) drove every straight movement phase into the wall
 * and clamped there (observed live), corrupting the very displacement these
 * phases exist to measure. 750ms (4.5 units) clears that with margin from
 * any spawn/direction. See also page-driver.ts's acquirePointerLock, which
 * settles out the lock-engaging click's own accidental attack_light before
 * the first phase starts (v2: every player can attack immediately, no
 * equip gate, so that click always lands as a real attack now).
 */
import {
  holdKey,
  holdKeys,
  lookAround,
  tapKey,
  type PhaseDef,
  type PhaseGroup,
} from './phase-helpers';
import { generateActionMatrixPhases, generateMovementMatrix } from './generate-phases';
import { churnPhases } from './input-churn';

export type { PhaseContext, PhaseDef, PhaseGroup } from './phase-helpers';
export const HANDWRITTEN_PHASES: PhaseDef[] = [
  {
    name: 'walk_forward',
    group: 'movement',
    expect: { kind: 'linear-move', speed: 'walk', durationMs: 750 },
    run: ({ page }) => holdKey(page, 'KeyW', 750),
  },
  {
    name: 'walk_backward',
    group: 'movement',
    expect: { kind: 'linear-move', speed: 'walk', durationMs: 750 },
    run: ({ page }) => holdKey(page, 'KeyS', 750),
  },
  {
    name: 'strafe_left',
    group: 'movement',
    expect: { kind: 'linear-move', speed: 'walk', durationMs: 750 },
    run: ({ page }) => holdKey(page, 'KeyA', 750),
  },
  {
    name: 'strafe_right',
    group: 'movement',
    expect: { kind: 'linear-move', speed: 'walk', durationMs: 750 },
    run: ({ page }) => holdKey(page, 'KeyD', 750),
  },
  {
    name: 'walk_forward_left',
    group: 'movement',
    expect: { kind: 'linear-move', speed: 'walk', durationMs: 750 },
    run: ({ page }) => holdKeys(page, ['KeyW', 'KeyA'], 750),
  },
  {
    name: 'walk_forward_right',
    group: 'movement',
    expect: { kind: 'linear-move', speed: 'walk', durationMs: 750 },
    run: ({ page }) => holdKeys(page, ['KeyW', 'KeyD'], 750),
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
    expect: { kind: 'linear-move', speed: 'walk', durationMs: 510, straight: false },
    run: async ({ page }) => {
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(100);
      await tapKey(page, 'Space', 60);
      await page.waitForTimeout(350);
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
      await holdKey(page, 'KeyW', 750);
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await page.waitForTimeout(300);
    },
  },
];

export const GENERATED_MOVEMENT_PHASES = generateMovementMatrix();
export const GENERATED_ACTION_MATRIX_PHASES = generateActionMatrixPhases();
/**
 * The rubberband detector (`input-churn.ts`). Registered in the default set — and in
 * BOTH tiers, unlike the generated movement matrix — because it gates the one movement
 * defect a human reproduces in seconds that nothing else here catches: rapid alternating
 * direction input, then release. It costs ~39s of a run; that is the price of the gate.
 *
 * Ordered after the handwritten movement primitives (so a broken `walk_forward` fails
 * first and a churn failure reads as downstream) and before the generated matrices.
 */
export const CHURN_PHASES = churnPhases();
export const PHASES: PhaseDef[] = [
  ...HANDWRITTEN_PHASES,
  ...CHURN_PHASES,
  ...GENERATED_MOVEMENT_PHASES,
  ...GENERATED_ACTION_MATRIX_PHASES,
];

export type QaTier = 'smoke' | 'full';

const PHASE_GROUPS: PhaseGroup[] = ['movement', 'network', 'combat', 'matrix', 'churn'];
const GENERATED_MOVEMENT_NAMES = new Set(GENERATED_MOVEMENT_PHASES.map((phase) => phase.name));
const SMOKE_MOVEMENT_NAMES = new Set(['mv_n', 'mv_e_jump', 'mv_nw', 'mv_w_jump', 'mv_se_jump', 'mv_ne_turn', 'mv_sw_turn']);

export function parseQaTier(value: string | undefined): QaTier {
  const tier = value?.trim() || 'smoke';
  if (tier !== 'smoke' && tier !== 'full') {
    throw new Error(`QA_TIER: expected smoke or full, received ${tier}`);
  }
  return tier;
}
/**
 * Resolves a `QA_PHASES` spec (comma-separated phase and/or group names;
 * undefined or empty means "everything") to phases, always in registry order.
 */
export function selectPhases(spec: string | undefined, tier: QaTier = 'smoke'): PhaseDef[] {
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
      'see scenarios.ts/generate-phases.ts, e.g. walk_forward, mv_nw_jump, prim_light_tap)',
    );
  }

  const tiered = tier === 'full'
    ? PHASES
    : PHASES.filter((phase) =>
        !GENERATED_MOVEMENT_NAMES.has(phase.name) ||
        SMOKE_MOVEMENT_NAMES.has(phase.name) ||
        wanted.includes(phase.name),
      );

  if (wanted.length === 0) return tiered;
  return tiered.filter((phase) => wanted.includes(phase.name) || wanted.includes(phase.group));
}
