import type { ReactNode } from 'react';
import { GameStateContext, type GameState } from './GameStateContext';

type GameStateProviderProps = {
  children: ReactNode;
  value: GameState;
};

export function GameStateProvider({ children, value }: GameStateProviderProps) {
  return (
    <GameStateContext.Provider value={value}>
      {children}
    </GameStateContext.Provider>
  );
}
