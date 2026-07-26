# The action pipeline

One generic, data-driven pipeline expresses every combat primitive. Adding an action is a row
in `shared/actions.json`; adding an *effect kind* is the only code extension point (one match
arm in `server/spacetimedb/src/actions/effects.rs`). Nothing else in the system may branch on
an action id.

This document is the wire contract between client and server. The JSON files and the table
shapes below are frozen during implementation waves; changes go through the integration owner
and a regeneration pass, never through an individual slice.

## Source of truth

`shared/actions.json` → `tools/gen-actions/` codegen →
- `server/spacetimedb/src/actions/defs.generated.rs` (`ACTION_DEFS`, `SLOT_BINDINGS`, `RESOURCE_DEFS`)
- `client/src/actions/defs.generated.ts` (same data, typed)

There is no `action_def` database table: the defs are static data, compile-time-checked on
both sides, and drift-gated in CI (`npm run gen:actions:check`, mirroring `gen:loadout:check`).
The JSON's `tickRate` must equal `common.rs::TICK_RATE`; the server asserts this at `init`.

`shared/arena.json` is the world's collision contract: bounds, spawn points, and collider rows
(`box` / `cylinder`, 2D circle-vs-shape resolution plus bounds clamp) consumed identically by
`client/src/sim/ground.ts` and `server/spacetimedb/src/collision.rs`. Visual geometry may be
anything; these rows are what both simulations agree on.

## ActionDef

| Field | Meaning |
|---|---|
| `phases` | `windupTicks / activeTicks / recoveryTicks` at 20 Hz |
| `cooldownTicks` | gate from action START to next start of the same action |
| `hold` | `null` (instant), `{mode:"charge", minTicks, maxTicks}` (release fires; force-release at max), or `{mode:"sustain", maxTicks:0}` (indefinite; effects apply during Held) |
| `movement` | phase → fraction of move speed (missing phase = 0). The same number picks the anim mask width client-side — movement is one value, gameplay and presentation both derive from it |
| `canRotate` | whether aim yaw may update mid-action |
| `resource` | `null` or `{kind, cost}`, checked and spent at action start |
| `effects` | list applied at the active window (or during Held for sustain). Any numeric damage field may be `[min, max]`: lerped by `chargeFraction`; a scalar is constant |
| `motion` | content key (`motion.act_*`), presentation only — the server carries it, never interprets it |
| `motionLayer` | `upper` (band-masked overlay) or `full` (override layer) |
| `interrupt` | earliest own-phase at which a NEW action may cancel this one: `never` / `recovery` / `always` |

Effect kinds at launch: `melee_arc`, `projectile`, `aoe_at_target`, `heal_self`,
`displace_self`, `invulnerable`, `mitigation`.

- `displace_self`: server moves the actor `distance` along facing, spread over active ticks,
  through the normal collision + transform channel — CSP sees it as any other correction.
- `invulnerable`: damage application checks the actor's phase is Active before applying.
- `mitigation`: incoming damage × `multiplier` while Held; the attack's `blockedDamage`
  overrides when present (chip damage).
- `aoe_at_target` with `maxRange: 0` is self-centered.

## Phase machine

`Idle → [Charging] → Windup → Active → [Held] → Recovery → Idle`

- Instant actions skip Charging and Held.
- `hold.mode=charge`: Press enters Charging; Release transitions to Windup with
  `chargeFraction = clamp((heldTicks − minTicks) / (maxTicks − minTicks), 0, 1)`;
  the server force-releases at `maxTicks`.
- `hold.mode=sustain`: Press enters Windup→Held (activeTicks=0); Release exits Held into
  Recovery. Effects marked on the def apply throughout Held.

## Input: one reducer, raw edges

```rust
action_input(slot: String, edge: InputEdge /* Press | Release */, aim: Option<Vector3>)
```

Slot bindings (`shared/actions.json` `slots`) resolve edges server-side:

- Press on a dual-bound slot (tap + hold actions) enters the hold action's Charging
  immediately; those ticks count toward the tap action's windup, and `holdThresholdTicks` is
  authored ≈ the tap action's `windupTicks`, so a tap costs zero added latency.
- Release before `holdThresholdTicks` resolves the tap action (Charging ticks already served
  convert to its windup); at/after threshold, the hold action releases with its
  `chargeFraction`.
- Single-bound slots ignore the irrelevant edge. `aim` is captured at Press and refreshed at
  Release; the server clamps targeted effects to their `maxRange`.

The threshold lives server-side because sustain and charge require server-measured hold time
anyway; tap-vs-hold therefore cannot desync from what the server resolves. The client mirrors
the threshold locally for presentation only — presentation never gates gameplay.

Movement input (`update_player_input`, the CSP tick channel, input acks, jump physics) is a
separate, unchanged path. Sprint remains in the wire but no key binds it by default.

## Tables

| Table | Shape |
|---|---|
| `player_action_state` (public) | `identity` PK, `action_id: String` ("" = idle), `phase: u8` (0 Idle, 1 Charging, 2 Windup, 3 Active, 4 Held, 5 Recovery), `phase_started_tick`, `phase_ends_tick` (0 = indefinite), `charge_ticks`, `server_tick` |
| `player_cooldown` (public) | `id` PK auto, `identity` btree, `action_id`, `ready_tick` |
| `player_resource` (public) | `id` PK auto, `identity` btree, `kind`, `amount` |
| `action_event` (public, transient) | `id` PK auto, `actor`, `target: Option<Identity>`, `action_id`, `kind: String` (`hit`/`blocked`/`miss`/`heal`/`release`), `amount: i32`, `position: Option<Vector3>`, `server_tick` btree; reaped after N ticks |
| `projectile` (public) | `id` PK auto, `owner`, `action_id`, `position`, `previous_position`, `direction`, `spawned_at_tick`, `distance_traveled`, `max_distance` |
| `player_slot_binding` (public) | `id` PK auto, `identity` btree, `slot`, `tap_action`, `hold_action`, `hold_threshold_ticks`; seeded from `SLOT_BINDINGS` on join. Row membership IS the capability gate |

No stored `can_move`/`can_attack` flags: **both sides derive gates from
`(action_id, phase)` plus the shared defs** (`client/src/actions/gates.ts`,
`server .../actions/state.rs`). One source of truth; the flags cannot drift.

Pending-work tables do not exist: the tick loop advances any `player_action_state` whose
`phase_ends_tick` has arrived (btree scan), applies active-window effects, steps projectiles,
and reaps stale events.

## Default keymap (data rows in `client/src/input/keymap.ts`)

| Input | Slot / channel |
|---|---|
| W A S D | movement (CSP input channel) |
| Mouse | third-person camera / aim |
| LMB | `primary` (tap = light, hold = heavy) |
| RMB | `block` (hold) |
| Space | jump (CSP input channel) |
| Left Shift | `roll` |
| 1–5 | `ability1`–`ability5` |
| R | `potion` |

The keymap is data; rebinding (including unbinding jump or binding sprint) is a row edit.

## Presentation bridge

`client/src/presentation/animBridge.ts` maps `(action_id, phase)` + defs onto the
AnimationController: hold-capable defs run the phased path (`<motion>_enter` / `<motion>_hold`
/ `<motion>_exit`, degrading to the base key when variants are unbound); instant defs play
`motion` as an overlay (`motionLayer: upper`) or override (`full`); the mask width derives
from the def's `movement` value; Recovery enters the controller's recovery state; hit/death
react from `action_event` / health rows. Missing clips degrade to procedural or to nothing —
a granted action always fires.
