# FlyFF (Fly for Fun) Inspiration

> "FlyFF "Fly for Fun" is an old korean grind game. i particularly liked the player and camera movement, which allowed left click to path and also wasd to move. the combat is very simple, just click on an enemy to selecct them, and click again to autoattack or press an ability buttonto activate it. the joy of the game is satisfaction optimizing exp/hr and collecting rare set pieces. at a higher level there is AoE strategies which involve collecting many monsters before taking them all down with spells that deal AoE damage. the class system doesn't require any scary decisions at level 1 before seeing the world"

## Core Highlights
*   **Hybrid Movement:** Left-click to pathfind combined with WASD for direct control.
*   **Targeted Combat:** Simple "click to select, click to attack" loop with ability hotkeys.
*   **The "Grind" Joy:** Satisfaction found in optimizing EXP/hour and the "chase" for rare set pieces.
*   **AoE Strategy:** Gathering large groups of mobs (mobbing) and using AoE spells for efficient clearing.
*   **Delayed Specialization:** Starting as a "Vagrant" allows players to explore the world before committing to a specific class.

## Research Findings
*   **Camera System:** FlyFF uses a flexible camera that supports both isometric-style click-to-move and a more traditional third-person follow.
*   **Progression Loop:** The itemization often revolves around "Sets" which provide significant bonuses, encouraging long-term farming.
*   **Flying Mechanics:** (Potential future addition) The transition from ground to air movement is a signature feature.

## TODO: Implementation Details
- [ ] **Movement:** Research how the hybrid input (Click vs WASD) resolves conflicts in the original engine.
- [ ] **Combat:** Look for reverse-engineered formulas for hit rate, evasion, and damage scaling (common in "v15" private server communities).
- [ ] **Pathfinding:** investigate the "NavMesh" or grid-based system used for click-to-move pathfinding.
- [ ] **AoE Logic:** Determine how the server handles synchronization for large groups of "pulled" mobs.
