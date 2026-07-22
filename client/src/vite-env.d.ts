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
  }
}

export {};

/// <reference types="vitest/config" />

