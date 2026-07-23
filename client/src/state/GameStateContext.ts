import { createContext } from 'react';
import type { PlayerAppearance, PlayerData, PlayerEquipment } from '../generated/types';
import type { WizardSpell } from '../components/BasePlayer';

export type GameState = {
  playerAppearances: ReadonlyMap<string, PlayerAppearance>;
  /** Equipment rows keyed by owner identity hex. */
  playerEquipment: ReadonlyMap<string, readonly PlayerEquipment[]>;
  playerClasses: ReadonlyMap<string, string>;
  players: ReadonlyMap<string, PlayerData>;
  selectedWizardSpell: WizardSpell;
};

export const GameStateContext = createContext<GameState | null>(null);
