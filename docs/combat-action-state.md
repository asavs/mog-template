# Combat Action State

Combat actions are server-authoritative. Clients may request slash or start/stop block, but visible paladin slash/block feedback should come from accepted server state instead of replaying on every local input.

## Player Action State

The server publishes one `player_action_state` row per player:

- `current_action`: `idle`, `attacking`, `blocking`, or `dead`
- `action_started_tick`: server tick when the action was accepted
- `action_active_tick`: first tick where the action has gameplay effect
- `action_recovery_until_tick`: tick until recovery restrictions clear
- `action_ends_tick`: tick when the action should return to idle
- `cooldown_ends_tick`: tick before the same action can be accepted again
- `can_move`, `can_rotate`, `can_attack`, `can_block`: client and server gating flags
- `feedback_policy`: currently `server_accepted`

## Current Paladin Rules

- Slash is accepted only while `can_attack` is true.
- Slash has a one second server cooldown.
- Slash damage resolves after a `0.45s` windup. The current slash animation is `1.5s` raw and plays at `1.6x`, for a `0.9375s` visible attack window.
- The measured peak right-hand motion in `paladin-slash.fbx` lands at about `0.427s` after animation time scaling, so the `0.45s` server impact delay is intentionally near the visible blade contact.
- Slash recovery runs from impact until the one second cooldown/action end. The cooldown is expected to cover the full visible slash animation.
- Block start is accepted only while `can_block` is true.
- Block is held until the client sends block stop.
- Held block has `current_action = blocking`, no fixed `action_ends_tick`, and `can_attack = false`.
- Releasing block clears the defensive window and enters a short idle recovery where attack/block remain disabled.
- Slash and block cannot cancel each other during active/recovery windows.
- Death forces `current_action = dead`; respawn restores idle action state.

## Combat Feedback

Damage feedback is driven by authoritative `combat_event` rows:

- `slash_hit`: a slash connected for full damage.
- `slash_blocked`: a slash connected against a held block and dealt mitigated damage.
- `slash_miss`: a slash resolved without a valid target in range/arc.

The client renders lightweight transient feedback near the target for hits/blocks and near the attacker for misses. These cues are intentionally simple; richer particles, sound, and shield impact art can build on the same event types later.

## Verification

Run the focused headless gameplay script against the deployed VM after publishing the server module:

```bash
./scripts/publish-server.sh
cd client
npm run test:combat-action:vm
```

The script joins as a paladin, verifies idle/slash/block state flags, spams slash reducer requests during cooldown, asserts that `player_animation.attackSeq` does not increment during the cooldown window, verifies the authoritative `slash_miss` event for an empty swing, verifies block remains active while held, and verifies block release recovery.

The client unit suite also includes `slash-timing.test.ts`, which parses the actual FBX clip and compares measured animation timing against the Rust slash impact/cooldown constants. This is the regression guard for #19-style slash readability tuning.
