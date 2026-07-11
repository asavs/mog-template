import { createContext } from 'react';
import type { PlayerData } from '../generated/types';
import type { WizardSpell } from '../components/BasePlayer';

export type GameState = {
  playerClasses: ReadonlyMap<string, string>;
  players: ReadonlyMap<string, PlayerData>;
  selectedWizardSpell: WizardSpell;
};

export const GameStateContext = createContext<GameState | null>(null);
