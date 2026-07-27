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
- Single-bound slots ignore the irrelevant edge. `aim` is accepted on the wire for both Press
  and Release but is **not persisted or read** — `player_action_state` has no column for it
  (the schema was frozen during implementation waves; see "Source of truth" above), so it is
  logged and dropped (`action_input`'s `let _ = aim;`). Targeted effects instead read the
  actor's LIVE `player_transform` at the moment the active window fires: `melee_arc` and
  `displace_self` use the live facing (`forward_vector(rotation_y)`) from the actor's
  position at that tick, and `aoe_at_target` resolves its target point as
  `actor_position + forward * maxRange` — always exactly `maxRange` out along current facing,
  never short of it and never off-axis toward wherever the player was aiming when they
  pressed. A target that turns after Windup starts changes where its own attack lands (nothing
  freezes `canRotate` mid-cast defs); a target that stands still gets exactly what "aim" would
  have produced anyway. See "Post-v2 candidates" below for what real aim capture would need.

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
| `tick_stats` (public, singleton) | `id = 0` PK, `server_tick`, `last_interval_us`, `interval_ewma_us` (alpha 1/10), `max_interval_us_window`, `late_ticks_window` (interval > 1.5x target), `window_started_tick` (window restarts every 100 ticks ≈ 5 s); rewritten once per `game_tick` from `ctx.timestamp` deltas — measures scheduler cadence between invocations, not tick-body duration |

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

A full-layer (`motionLayer: full`), hold-capable def — today, only `attack_heavy` — is silent
during Charging: `driveAnimationFromActionState` only runs the phased enter/held/exit path for
`motionLayer: upper` defs, because `AnimationController.playPhased` is hard-wired to the
overlay slot (`this.overlay`), never the full-body override layer `playFullBody`/`playAbility`
`{upperBodyOnly: false}` uses. The swing itself plays normally once Charging releases into
Windup; only the charge-up HOLD has no visual. Checked at Checkpoint B integration for a
same-wave fix and left as-is: making `playPhased` (or an override-layer sibling of it) support
the full-body layer is a real change to `anim/AnimationController.ts`'s layer model, not a
call-site wire-up, and risks the one thing this wave's own charter forbids — destabilizing
`anim/`'s test suite for a wave that owns integration, not animation-layer design.

## Post-v2 candidates

Gaps intentionally left open by the waves that shipped this pipeline, recorded here so they
are a choice someone can pick up rather than a thing someone rediscovers by reading Rust:

- **Aim capture.** `action_input`'s `aim` parameter is wire-contract-complete but inert (see
  "Input" above) — every targeted effect reads live facing/position at fire time instead of
  wherever the player was actually aiming when they pressed or released. Real aim would need
  a persisted column (`player_action_state` or a new small table keyed by identity) written at
  Press and optionally refreshed at Release, since the frozen-schema constraint that blocked it
  during Wave 2 no longer applies once a wave is scoped to extend the schema on purpose.
- **Full-body charge pose.** `attack_heavy`'s Charging phase (and any future full-layer,
  hold-capable def) has no held pose — see the note just above. Needs `AnimationController` to
  either grow an override-layer phased path alongside `playPhased`'s overlay-only one, or grow
  a "hold this layer at reduced weight" primitive `animBridge.ts` can drive during Charging.
  Either is an `anim/` design change with its own test-suite responsibility, not a wire-up.
