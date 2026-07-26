/**
 * The default keymap — data, not code.
 *
 * Two tables because two different browser event shapes bind to slots:
 * keyboard `code` (KeyboardEvent.code) and mouse `button` (MouseEvent.button).
 * Movement and jump feed the CSP input channel (`update_player_input`); every
 * other row resolves to a slot on the action pipeline (`action_input`).
 *
 * Rebinding — including unbinding jump or binding sprint — is a row edit here,
 * never a code change in intents.ts or useInput.ts. Sprint exists in the wire
 * InputState (see generated/types.ts) but intentionally has no default key: it
 * is reachable by a future row, not by a hardcoded modifier.
 */

export type MovementAxis = 'forward' | 'backward' | 'left' | 'right';

export type KeyBinding =
  | { kind: 'movement'; axis: MovementAxis }
  | { kind: 'jump' }
  | { kind: 'slot'; slot: string };

export interface KeyRow {
  code: string;
  binding: KeyBinding;
}

export interface MouseRow {
  button: number;
  binding: Extract<KeyBinding, { kind: 'slot' }>;
}

export const KEY_BINDINGS: readonly KeyRow[] = [
  { code: 'KeyW', binding: { kind: 'movement', axis: 'forward' } },
  { code: 'KeyS', binding: { kind: 'movement', axis: 'backward' } },
  { code: 'KeyA', binding: { kind: 'movement', axis: 'left' } },
  { code: 'KeyD', binding: { kind: 'movement', axis: 'right' } },
  { code: 'Space', binding: { kind: 'jump' } },
  { code: 'ShiftLeft', binding: { kind: 'slot', slot: 'roll' } },
  { code: 'KeyR', binding: { kind: 'slot', slot: 'potion' } },
  { code: 'Digit1', binding: { kind: 'slot', slot: 'ability1' } },
  { code: 'Digit2', binding: { kind: 'slot', slot: 'ability2' } },
  { code: 'Digit3', binding: { kind: 'slot', slot: 'ability3' } },
  { code: 'Digit4', binding: { kind: 'slot', slot: 'ability4' } },
  { code: 'Digit5', binding: { kind: 'slot', slot: 'ability5' } },
] as const;

export const MOUSE_BINDINGS: readonly MouseRow[] = [
  { button: 0, binding: { kind: 'slot', slot: 'primary' } }, // LMB
  { button: 2, binding: { kind: 'slot', slot: 'block' } }, // RMB
] as const;

/** Every KeyboardEvent.code this keymap cares about, for suppressing default browser behavior. */
export const BOUND_KEY_CODES: ReadonlySet<string> = new Set(KEY_BINDINGS.map(row => row.code));

export function keyBindingFor(code: string): KeyBinding | undefined {
  return KEY_BINDINGS.find(row => row.code === code)?.binding;
}

export function mouseBindingFor(button: number): MouseRow['binding'] | undefined {
  return MOUSE_BINDINGS.find(row => row.button === button)?.binding;
}
