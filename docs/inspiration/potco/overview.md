# Pirates of the Caribbean Online (POTCO) Inspiration

> "its ahrd to remember but i definitley loved pirates of the carribbean online. this game ROCKED!!!!! it was a mmo that had cool weapons like voodoo dolls alongside standard swords and guns. the most fun about it was setting sail and plundering other players and npc ships, and then racing back to shore to sell your loot before getting sunk yoruself and losing it all. you could pilot the ship and raise/loser the rails, activate ramming speed or broadsides. your crew could work the cannons, changing between grapeshot and fire cannons. it introduces the excitement of a hardcore game type without the soul crushing defeat of completely losing your charater. also there was awesome character customization in tattoos at the tatoo parlor. and you could play blackjack and poker in the tavern. there was also an interesting faction trio between pirates, government, and undead. there were a ariety of interesting weapons adn abilities and enemies, like scary crocodiles in the swamps"

## Core Highlights
*   **The "Loot Run" Loop:** High-stakes plundering where you must return to shore to "lock in" your loot, introducing risk-reward tension without permanent character loss.
*   **Collaborative Ship Combat:** Multi-crew gameplay where players divide roles (piloting, cannons, repairs) and manage specific mechanics (sails, ramming speed, broadsides).
*   **Ammo Variety:** Strategic depth through specialized cannon fire (grapeshot for crew, fire for hulls).
*   **Unique Weaponry:** Blending traditional swords/guns with supernatural elements like Voodoo Dolls.
*   **Tavern Social Systems:** Non-combat engagement through mini-games like Blackjack and Poker.
*   **Faction Triangle:** A three-way conflict between Pirates, the Navy (Government), and the Undead.
*   **Detailed Customization:** Permanent cosmetic progression like the Tattoo Parlor.
*   **Varied Bestiary:** Unique environmental threats like crocodiles in swamps.

## Research Findings
*   **Engine Heritage:** POTCO was built on the Panda3D engine (similar to Toontown), which handled networked social spaces and ship-to-ship combat relatively early for its time.
*   **Ship Physics:** Ships used a "buoyancy" model that felt heavy but responsive, with turning speed heavily influenced by sail state.
*   **Voodoo Mechanics:** Voodoo dolls acted as a "debuff/indirect damage" class, which is a unique twist on the standard MMO healer/DPS roles.

## TODO: Implementation Details
- [ ] **Vehicle/Ship System:** Research how to handle large "mobile platforms" (ships) where multiple players can stand and interact in a networked environment.
- [ ] **Loot Risk System:** Design a "stashing" mechanic where inventory is only secured upon reaching a "safe zone" or NPC vendor.
- [ ] **Mini-games:** Explore lightweight ways to implement UI-based card games within the game world.
- [ ] **Faction Reputation:** Investigate systems for tracking player standing with different NPC groups.
- [ ] **Voodoo System:** Look into "status effect" logic that can be applied remotely via "voodoo doll" items.
