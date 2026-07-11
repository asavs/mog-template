import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { Identity } from 'spacetimedb';
import type { InputState } from '../generated/types';
import type { PlayerRuntimeState } from '../playerRuntime';
import type { WizardSpell } from '../components/BasePlayer';

export function createDefaultInput(): InputState {
  return {
    forward: false,
    backward: false,
    left: false,
    right: false,
    sprint: false,
    jump: false,
    sequence: 0,
    clientTick: 0,
  };
}

export function useInputState() {
  const inputRef = useRef<InputState>(createDefaultInput());

  const resetInputForDeath = useCallback(() => {
    const sequence = inputRef.current.sequence;
    return { ...createDefaultInput(), sequence };
  }, []);

  return {
    inputRef,
    resetInputForDeath,
  };
}

type UseKeyboardInputOptions = {
  identity: Identity | null;
  inputRef: MutableRefObject<InputState>;
  onSelectWizardSpell: (spell: WizardSpell) => void;
  playerRuntimeRef: MutableRefObject<PlayerRuntimeState>;
  sendInputNow: () => void;
  spellsEnabled: boolean;
};

const GAME_KEY_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ShiftLeft',
  'Space',
  'Digit1',
  'Digit2',
]);

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const element = target as { isContentEditable?: boolean; tagName?: string };
  if (element.isContentEditable) return true;
  const tagName = element.tagName?.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
}

export function shouldSuppressGameKeyDefault(event: KeyboardEvent, controlsActive: boolean): boolean {
  return controlsActive && GAME_KEY_CODES.has(event.code) && !isEditableKeyboardTarget(event.target);
}

function clearGameplayInput(input: InputState): boolean {
  let changed = false;
  const clearKey = (key: keyof Pick<InputState, 'forward' | 'backward' | 'left' | 'right' | 'sprint' | 'jump'>) => {
    if (!input[key]) return;
    input[key] = false;
    changed = true;
  };
  clearKey('forward');
  clearKey('backward');
  clearKey('left');
  clearKey('right');
  clearKey('sprint');
  clearKey('jump');
  return changed;
}

export function useKeyboardInput({
  identity,
  inputRef,
  onSelectWizardSpell,
  playerRuntimeRef,
  sendInputNow,
  spellsEnabled,
}: UseKeyboardInputOptions) {
  useEffect(() => {
    const updateInput = (key: keyof InputState, val: boolean) => {
      const input = inputRef.current;
      if (input[key] === val) return false;
      (input as unknown as Record<keyof InputState, boolean | number>)[key] = val;
      return true;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableKeyboardTarget(event.target)) {
        return;
      }
      const controlsActive = document.pointerLockElement === document.body;
      if (!shouldSuppressGameKeyDefault(event, controlsActive)) return;
      event.preventDefault();

      if (identity && playerRuntimeRef.current.health.get(identity.toHexString())?.isDead) return;

      let changed = false;
      if (event.code === 'KeyW') changed = updateInput('forward', true) || changed;
      if (event.code === 'KeyS') changed = updateInput('backward', true) || changed;
      if (event.code === 'KeyA') changed = updateInput('left', true) || changed;
      if (event.code === 'KeyD') changed = updateInput('right', true) || changed;
      if (event.code === 'ShiftLeft') changed = updateInput('sprint', true) || changed;
      if (event.code === 'Space') changed = updateInput('jump', true) || changed;
      if (spellsEnabled && event.code === 'Digit1') {
        onSelectWizardSpell('fireball');
      }
      if (spellsEnabled && event.code === 'Digit2') {
        onSelectWizardSpell('lightning');
      }
      if (changed) sendInputNow();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (isEditableKeyboardTarget(event.target)) {
        return;
      }
      const controlsActive = document.pointerLockElement === document.body;
      if (!shouldSuppressGameKeyDefault(event, controlsActive)) return;
      event.preventDefault();

      let changed = false;
      if (event.code === 'KeyW') changed = updateInput('forward', false) || changed;
      if (event.code === 'KeyS') changed = updateInput('backward', false) || changed;
      if (event.code === 'KeyA') changed = updateInput('left', false) || changed;
      if (event.code === 'KeyD') changed = updateInput('right', false) || changed;
      if (event.code === 'ShiftLeft') changed = updateInput('sprint', false) || changed;
      if (event.code === 'Space') changed = updateInput('jump', false) || changed;
      if (changed) sendInputNow();
    };

    const handlePointerLockChange = () => {
      if (document.pointerLockElement === document.body) return;
      if (clearGameplayInput(inputRef.current)) {
        sendInputNow();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    document.addEventListener('pointerlockchange', handlePointerLockChange);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
    };
  }, [identity, inputRef, onSelectWizardSpell, playerRuntimeRef, sendInputNow, spellsEnabled]);
}
