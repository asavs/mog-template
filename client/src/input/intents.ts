/**
 * Turns raw physical edges (key/mouse down-up, pointer-lock changes) into game
 * intents: a movement+jump vector for the CSP channel, and de-duplicated
 * {slot, edge} pairs for `action_input`. Pure and DOM-free on purpose — every
 * function here takes plain data (never a real KeyboardEvent/MouseEvent), so
 * tests exercise the exact logic useInput.ts drives without a browser.
 *
 * Two suppression rules apply before anything else reaches the game:
 *  - pointer-lock gating: while the pointer is not locked, physical edges are
 *    observed (so releasing a key still clears state) but never emit slot or
 *    movement effects — the game does not think you are pressing anything.
 *  - editable targets: typing in an <input>/<textarea>/contenteditable never
 *    reaches the game, locked or not.
 *
 * holdTicksFor() mirrors the server's holdThresholdTicks measurement so the
 * UI can show a charge-up indicator starting the instant a hold would resolve
 * server-side — but it is read-only. It never gates whether a Press/Release
 * edge gets sent; the server is the sole authority on tap-vs-hold resolution
 * (see docs/action-pipeline.md).
 */

import { keyBindingFor, mouseBindingFor, type MovementAxis } from './keymap';

export interface MovementState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
}

export function createMovementState(): MovementState {
  return { forward: false, backward: false, left: false, right: false, jump: false };
}

function movementsEqual(a: MovementState, b: MovementState): boolean {
  return (
    a.forward === b.forward &&
    a.backward === b.backward &&
    a.left === b.left &&
    a.right === b.right &&
    a.jump === b.jump
  );
}

export type InputEdgeKind = 'Press' | 'Release';

export interface SlotEdge {
  slot: string;
  edge: InputEdgeKind;
}

export interface IntentState {
  readonly locked: boolean;
  readonly movement: MovementState;
  readonly downCodes: ReadonlySet<string>;
  readonly downButtons: ReadonlySet<number>;
  /** slot -> the tick (server-clock units, caller-defined) the Press edge fired on. */
  readonly heldSlotSince: ReadonlyMap<string, number>;
}

export function createIntentState(): IntentState {
  return {
    locked: false,
    movement: createMovementState(),
    downCodes: new Set(),
    downButtons: new Set(),
    heldSlotSince: new Map(),
  };
}

export interface IntentResult {
  state: IntentState;
  /** Present only when the movement/jump vector actually changed. */
  movement?: MovementState;
  /** Emitted at most once per physical edge — see module doc. */
  edges: SlotEdge[];
}

function unchanged(state: IntentState): IntentResult {
  return { state, edges: [] };
}

export interface EditableTargetLike {
  isContentEditable?: boolean;
  tagName?: string;
}

/** Duck-typed so tests can pass a plain object instead of a real DOM node. */
export function isEditableTarget(target: EditableTargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

function withMovement(state: IntentState, axis: MovementAxis | 'jump', value: boolean): IntentState {
  if (state.movement[axis] === value) return state;
  return { ...state, movement: { ...state.movement, [axis]: value } };
}

function releaseAllMovement(state: IntentState): IntentState {
  const cleared = createMovementState();
  if (movementsEqual(state.movement, cleared)) return state;
  return { ...state, movement: cleared };
}

/** A physical key going down. `repeat` browser auto-repeat events are no-ops — already down. */
export function handleKeyDown(
  state: IntentState,
  event: { code: string; repeat?: boolean },
  target: EditableTargetLike | null | undefined,
  atTick: number,
): IntentResult {
  if (isEditableTarget(target)) return unchanged(state);
  if (event.repeat || state.downCodes.has(event.code)) return unchanged(state);

  const downCodes = new Set(state.downCodes);
  downCodes.add(event.code);
  let next: IntentState = { ...state, downCodes };

  if (!state.locked) return { state: next, edges: [] };

  const binding = keyBindingFor(event.code);
  if (!binding) return { state: next, edges: [] };

  if (binding.kind === 'movement') return movementResult(next, withMovement(next, binding.axis, true));
  if (binding.kind === 'jump') return movementResult(next, withMovement(next, 'jump', true));

  const heldSlotSince = new Map(next.heldSlotSince);
  heldSlotSince.set(binding.slot, atTick);
  next = { ...next, heldSlotSince };
  return { state: next, edges: [{ slot: binding.slot, edge: 'Press' }] };
}

/** `movement` is only present in the result when this call actually changed it. */
function movementResult(before: IntentState, after: IntentState): IntentResult {
  if (after === before) return { state: after, edges: [] };
  return { state: after, movement: after.movement, edges: [] };
}

/** A physical key coming up. Always processed even while unlocked, so state never sticks. */
export function handleKeyUp(
  state: IntentState,
  event: { code: string },
  target: EditableTargetLike | null | undefined,
): IntentResult {
  if (isEditableTarget(target)) return unchanged(state);
  if (!state.downCodes.has(event.code)) return unchanged(state);

  const downCodes = new Set(state.downCodes);
  downCodes.delete(event.code);
  let next: IntentState = { ...state, downCodes };

  const binding = keyBindingFor(event.code);
  if (!binding) return { state: next, edges: [] };

  if (binding.kind === 'movement') return movementResult(next, withMovement(next, binding.axis, false));
  if (binding.kind === 'jump') return movementResult(next, withMovement(next, 'jump', false));

  if (!next.heldSlotSince.has(binding.slot)) return { state: next, edges: [] };
  const heldSlotSince = new Map(next.heldSlotSince);
  heldSlotSince.delete(binding.slot);
  next = { ...next, heldSlotSince };
  return { state: next, edges: [{ slot: binding.slot, edge: 'Release' }] };
}

export function handleMouseDown(
  state: IntentState,
  event: { button: number },
  atTick: number,
): IntentResult {
  if (state.downButtons.has(event.button)) return unchanged(state);
  const downButtons = new Set(state.downButtons);
  downButtons.add(event.button);
  let next: IntentState = { ...state, downButtons };

  if (!state.locked) return { state: next, edges: [] };

  const binding = mouseBindingFor(event.button);
  if (!binding) return { state: next, edges: [] };

  const heldSlotSince = new Map(next.heldSlotSince);
  heldSlotSince.set(binding.slot, atTick);
  next = { ...next, heldSlotSince };
  return { state: next, edges: [{ slot: binding.slot, edge: 'Press' }] };
}

export function handleMouseUp(state: IntentState, event: { button: number }): IntentResult {
  if (!state.downButtons.has(event.button)) return unchanged(state);
  const downButtons = new Set(state.downButtons);
  downButtons.delete(event.button);
  let next: IntentState = { ...state, downButtons };

  const binding = mouseBindingFor(event.button);
  if (!binding || !next.heldSlotSince.has(binding.slot)) return { state: next, edges: [] };

  const heldSlotSince = new Map(next.heldSlotSince);
  heldSlotSince.delete(binding.slot);
  next = { ...next, heldSlotSince };
  return { state: next, edges: [{ slot: binding.slot, edge: 'Release' }] };
}

/**
 * Pointer lock changing. Losing lock clears every held key/button/movement
 * intent and emits Release edges for anything that was mid-hold, so a player
 * who alt-tabs mid-swing does not leave a phantom Press the server never sees
 * released. Gaining lock is a pure unlock — it never invents Presses for keys
 * that happen to be physically down (the browser will not tell us that).
 */
export function setPointerLocked(state: IntentState, locked: boolean): IntentResult {
  if (state.locked === locked) return unchanged(state);

  if (locked) {
    return { state: { ...state, locked: true }, edges: [] };
  }

  const edges: SlotEdge[] = [...state.heldSlotSince.keys()].map(slot => ({ slot, edge: 'Release' as const }));
  const next: IntentState = releaseAllMovement({
    ...state,
    locked: false,
    heldSlotSince: new Map(),
  });
  return { state: next, movement: next.movement, edges };
}

/** Ticks a slot has been continuously held, or 0 if it is not currently held. */
export function holdTicksFor(state: IntentState, slot: string, currentTick: number): number {
  const since = state.heldSlotSince.get(slot);
  if (since === undefined) return 0;
  return Math.max(0, currentTick - since);
}
