import { useContext } from 'react';
import { GameStateContext } from './GameStateContext';

export function useGameState() {
  const gameState = useContext(GameStateContext);
  if (!gameState) {
    throw new Error('useGameState must be used within GameStateProvider');
  }
  return gameState;
}
