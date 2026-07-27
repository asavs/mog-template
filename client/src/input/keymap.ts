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

/**
 * Debug overlays get their own table rather than a third `KeyBinding` kind, because they are
 * not intents: nothing here reaches `update_player_input` or `action_input`, and threading a
 * non-gameplay kind through `intents.ts` would put a diagnostic concern in the one module that
 * exists to hold only "what did the player mean". Consumers (see `perf/hud.ts`) resolve their
 * own key through `debugBindingFor` and listen for themselves. Rebinding stays a row edit.
 */
export type DebugToggle = 'perfHud';

export interface DebugRow {
  code: string;
  toggle: DebugToggle;
}

export const DEBUG_BINDINGS: readonly DebugRow[] = [
  { code: 'F3', toggle: 'perfHud' },
] as const;

/**
 * Every KeyboardEvent.code this keymap cares about, for suppressing default browser behavior.
 * Debug codes are included so the browser's own binding never fires underneath the overlay —
 * F3 is "find next" in Chrome, which would otherwise open the find bar mid-session.
 */
export const BOUND_KEY_CODES: ReadonlySet<string> = new Set([
  ...KEY_BINDINGS.map(row => row.code),
  ...DEBUG_BINDINGS.map(row => row.code),
]);

export function keyBindingFor(code: string): KeyBinding | undefined {
  return KEY_BINDINGS.find(row => row.code === code)?.binding;
}

export function mouseBindingFor(button: number): MouseRow['binding'] | undefined {
  return MOUSE_BINDINGS.find(row => row.button === button)?.binding;
}

export function debugBindingFor(code: string): DebugToggle | undefined {
  return DEBUG_BINDINGS.find(row => row.code === code)?.toggle;
}
