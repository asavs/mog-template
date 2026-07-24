/// <reference types="vite/client" />

import type { GameDebugChannels } from './hooks/useQaGameDebug';

declare global {
  const __BUILD_COMMIT__: string;

  interface Window {
    __buildInfo?: {
      commit: string;
      mode: string;
    };
    __gameDebug?: GameDebugChannels;
    /** Local player equipment rows (slot/itemId) for QA equip asserts. */
    __qaEquipment?: ReadonlyArray<{ slot: string; itemId: string }>;
    /** Live grant-derived capabilities for QA equip ↔ combat asserts. */
    __qaCapabilities?: {
      melee: boolean;
      block: boolean;
      spells: readonly string[];
      drinkPotion: boolean;
    };
  }
}

export {};

/// <reference types="vitest/config" />

