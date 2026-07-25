/**
 * Drill room entry point.
 *
 * A sibling of the sandbox, not a mode inside it. They ask different questions
 * — the sandbox judges one clip, this judges a whole loadout in motion — and
 * folding the second into the first meant a browser with a routine bolted to
 * the side, where every control belonged to only one of the two jobs.
 *
 * Same isolation as the sandbox: no SpacetimeDB, no netcode, no terrain. A
 * body, a room, and the content seam.
 *
 * Run with `npm run drill`.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DrillRoom } from './DrillRoom';
import './drill.css';

// Registering the procedural generators binds the placeholder content.
import '../content/procedural';

const container = document.getElementById('drill-root');
if (!container) {
  throw new Error('drill root element missing');
}

createRoot(container).render(
  <StrictMode>
    <DrillRoom />
  </StrictMode>,
);
