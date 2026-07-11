# Elder Scrolls Online (ESO) Inspiration

> "ESO elder scrolls online is the best mmo and id like to model the combat around that. there were 4 classes which you had to choose at game start, but you could use any weapon or any armor type with any class. you had many abilities to choose from, related to yoru class, armor type, weapon type, guild, pVp rank, ad more. the pvp itself and world worked together well. the pvp zone was located in the center of 3 factions, which you had to choose at game start ( a creative and immersive way to deal with servers to avoid too many players in the same place) the pvp zone was cyrodiil, a the center, and you could respawn at keeps. the keeps are located in a center around the white gold tower, and holding all of them crowned an emperor. players would form huge groups and wage wars to crown their emperors. it was also totally possible to play solo an dbe a pest for these big groups, called "zergs" after the starcraft enemies known to swarm. this was called "zerg surfing" and usually ended in the surfer's death but was highly fun. some players got so good at this or manipulated the game to an unfair degree and would fight many enemies at once, this was called 1vXing. essentially the combat was semi locked on. you could press tab to target, and your spells wouldn't miss unless they roll doddged. some spells like arrow rain had to be targeted in an area. light attacks with the bow or the fire staff would hit if you were generally targeting an opponent, but melee attacks had to be in range. spells didn't have cooldowns but cost mana/stamina. you were limited to 5 abilities on your bar, plus an ultimate. and you can weapon swap between two weapons in combat, each having 5 abilities and an ultimate on the bar. animation cancels were powerrrful and felt super good. for example, you can charge up a bow shot, cancel the animation with a weapon swap and then use a 2h graeat sword charge at the same timge and the arrow and charge would land at the same time. animation cancels made the essential dps loop always involve a lightattack/heavy attack -> ability -> block/bash. so it was rhythmic and felt amazing to execute consistently. sadly people complained that it was too necessary for optimal dps to play this way and it was gutted."

## Core Highlights
*   **Freedom of Build:** Choose a class at the start, but any class can use any weapon or armor type, creating massive build diversity.
*   **Three-Faction PvP (The Alliance War):** A persistent, massive-scale war in a central zone (Cyrodiil) where factions compete for keeps and the "Emperor" title.
*   **Combat Flow (Light Attack Weaving):** A rhythmic combat loop involving Light Attack -> Ability -> Block/Bash cancel, providing high skill expression.
*   **Action Bar System:** Limited to 5 abilities + 1 Ultimate per bar, with a "Weapon Swap" mechanic to access a second bar of 5+1 abilities.
*   **Resource Management:** No ability cooldowns; combat is governed by Mana and Stamina management.
*   **Zerg Surfing & 1vX:** The ability for highly skilled solo players to navigate and fight against massive groups ("zergs") through superior movement and positioning.
*   **Semi-Locked Targeting:** Tab-targeting for consistency, combined with area-of-effect ground targeting and range-based melee.

## Research Findings
*   **Animation Canceling:** The "Light Attack Weave" works by using an ability to cancel the end of the light attack animation, and then using a block or bash to cancel the end of the ability animation.
*   **Server Architecture:** ESO uses "Megaservers" but segments the population via Faction-locked entry to Cyrodiil and "Campaign" instances to prevent overcrowding.
*   **Netcode:** Fast-paced action combat in an MMO requires aggressive client-side prediction and server-side validation of range and line-of-sight.

## TODO: Implementation Details
- [ ] **Combat Rhythms:** Research the frame-data of ESO's "weaving" to decide how much animation canceling to support in our project.
- [ ] **Dual-Bar System:** Implement a "Weapon Swap" system that swaps the active ability set and model simultaneously.
- [ ] **Resource Logic:** Create a robust "Stamina/Magicka" system where costs are balanced to prevent spam without needing cooldowns.
- [ ] **Massive PvP:** Investigate "Keep" mechanics—doors, walls, and respawn logic for large-scale objective-based PvP.
- [ ] **Targeting System:** Design a "Soft-Lock" system where projectiles home in on a target but can be dodged or blocked.
- [ ] **Build Diversity:** Research how to implement "Skill Lines" (Weapon, Armor, Guild) that are independent of the player's core "Class."
