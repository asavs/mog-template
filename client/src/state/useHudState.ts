import { useContext } from 'react';
import { HudStateContext } from './HudStateContext';

export function useHudState() {
  const hudState = useContext(HudStateContext);
  if (!hudState) {
    throw new Error('useHudState must be used within HudStateProvider');
  }
  return hudState;
}
