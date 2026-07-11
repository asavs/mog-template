# Dark Souls 3 Inspiration

> "we can add dark souls 3 as a different option. this game did a great job of telling the passage of time as an environemntal effect, and the ember usage (which invited invaders, but boosted your hp) was an awesome idea. and the fashion was so cool. you coudl mix and match your armor and the cape physics was just *chefs kiss* the abyss watchers was my favorite boss"

## Core Highlights
*   **Environmental Passage of Time:** The world shifts visually and atmospheric-ally to tell a story of decay and the "end of days" (e.g., the Dreg Heap or the Eclipse).
*   **The Ember System:** A compelling risk-reward mechanic where a resource (Ember) grants significant HP and visual flair but opens the player to PvP invasions.
*   **"Fashion Souls":** Deep armor customization that prioritizes aesthetic expression, supported by high-quality cloth and cape physics.
*   **Iconic Boss Phases:** Multi-stage encounters like the Abyss Watchers that blend narrative, music, and gameplay shifts seamlessly.
*   **Visceral Feedback:** The "embered" visual effect (smoldering embers on the player model) provides immediate, satisfying feedback of power.

## Research Findings
*   **Cloth Simulation:** Uses advanced vertex-based physics for capes and loose clothing to add dynamism to movement.
*   **Invasion Matchmaking:** The "Embered" state acts as a boolean flag for the matchmaking server to allow hostile player connections.
*   **World State Triggers:** Environment changes are often tied to boss kills or specific progression flags, swapping skyboxes and lighting presets.

## TODO: Implementation Details
- [ ] **Cloth Physics:** Research lightweight cloth simulation for the client to support satisfying "cape physics."
- [ ] **Ember Mechanic:** Design a "Buff + PvP Flag" system that makes the player more powerful but also more vulnerable to world threats/players.
- [ ] **Visual Progression:** Implement a system for "Character Overlays" (like the smoldering ember effect) that reflects player state.
- [ ] **Dynamic Environment:** Research how to handle "World State" transitions (e.g., changing the sun/lighting) across a networked session.
- [ ] **Boss Design:** Study the Abyss Watchers for "Multi-Entity" boss logic (enemies fighting each other as part of the encounter).
