# Runescape Inspiration

> "probably runescape. having a large map of skills for tons of different player archetypes ( you could just spend all day wood chopping) but interdependent (your wood can be sold to other players to level firemaking, or you could combine your wood chopping flow with firemaking to level two skills at once) is incredibly saytisfying. this is part of a larger game design that i call 2 birds with 1 stone that is very very satisfying, its just like doing two quests at once or collecting the verdant streamberries inside the goblin cave that you were tasked with clearing out, and then turning the "collect verdant streamberries" along with "clear out the goblin cave" runescape has an awesome ecosystem and the grand exchange is to this day a legitamate economic market. the movement, being able to click somewhere on the map and your character paths there is awesome too. the magic system was unique in that you needed to craft runes, which leveled mining and htne runecrafting andthen expended them to cast was an interesting balance too."

## Core Highlights
*   **Interdependent Skills:** A massive map of skills where progress in one often fuels another (e.g., Woodcutting feeds Firemaking/Fletching).
*   **"2 Birds with 1 Stone" Design:** Mechanics that encourage stacking activities (e.g., training two skills at once or completing multiple quest objectives in one location) for maximum efficiency.
*   **The Grand Exchange:** A player-driven, centralized economy that acts as a legitimate marketplace, creating value for even the most basic "afk" resources.
*   **Pathfinding & Minimap:** The ability to click a point on a distant map and have the character autonomously navigate there.
*   **The Rune Loop:** A magic system where power isn't just "mana," but requires a production chain (Mining -> Runecrafting -> Casting).
*   **Alternative Archetypes:** Validating non-combat playstyles where a player can find fulfillment and status just by woodcutting or fishing.

## Research Findings
*   **Tick-Based System:** Runescape famously runs on 0.6s "ticks," which governs everything from movement to combat and skill actions. This creates a predictable rhythm that players use for high-level "tick manipulation."
*   **Global Economy:** The Grand Exchange uses a "Guide Price" system that fluctuates based on real player supply and demand, preventing artificial price fixing by the developers.
*   **Navigation:** Uses a robust pathfinding algorithm (likely A* or similar) that handles complex obstacles and long distances via minimap interaction.

## TODO: Implementation Details
- [ ] **Interconnected Economy:** Design a "Marketplace" table in SpacetimeDB to handle player-to-player trading and order matching.
- [ ] **Skill Synergies:** Map out how different "Life Skills" (Mining, Smithing, etc.) can be designed to provide necessary inputs for each other.
- [ ] **Long-Distance Pathfinding:** Research how to implement "click-to-move" on a global scale, potentially using hierarchical navmeshes.
- [ ] **Production Chains:** Implement item requirements for magic/abilities (like runes) that must be crafted or bought rather than just regenerating mana.
- [ ] **Task Stacking:** Design quest and achievement systems that reward players for overlapping objectives in the same "zone."
