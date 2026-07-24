/**
 * Animation sandbox entry point.
 *
 * Deliberately isolated from the game app: no SpacetimeDB connection, no
 * netcode, no terrain, no skybox. Just a flat world, a body, and the motions
 * resolved through the content seam — so animation work iterates in seconds
 * without a server or a 300 MB map.
 *
 * Run with `npm run sandbox`.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Sandbox } from './Sandbox';
import './sandbox.css';

// Registering the procedural generators binds the placeholder content.
import '../content/procedural';

const container = document.getElementById('sandbox-root');
if (!container) {
  throw new Error('sandbox root element missing');
}

createRoot(container).render(
  <StrictMode>
    <Sandbox />
  </StrictMode>,
);
