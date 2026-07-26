use super::defs_generated::{self, ActionDef, HoldSpec};
use super::{effects, state, InputEdge};
use crate::common::Vector3;
use crate::tables::*;
use spacetimedb::{Identity, ReducerContext, Table};

/// Find the slot-binding row for `slot` among a player's bindings.
/// Pure / host-free so unit tests can call it without `ctx.db`.
pub(crate) fn find_binding(
    bindings: impl IntoIterator<Item = PlayerSlotBinding>,
    slot: &str,
) -> Result<PlayerSlotBinding, String> {
    bindings
        .into_iter()
        .find(|row| row.slot == slot)
        .ok_or_else(|| format!("Unknown slot: {slot}"))
}

/// Build the `PlayerActionState` a Press edge should produce for a resolved slot binding.
/// Pure / host-free so unit tests can call it without `ctx.db`. Charge-mode hold actions
/// enter Charging (a force-release deadline at `max_ticks`); everything else (instant, or
/// sustain-mode hold) enters Windup directly — sustain has no "charging" phase of its own,
/// per docs/action-pipeline.md ("hold.mode=sustain: Press enters Windup->Held").
pub(crate) fn build_press_state(
    identity: Identity,
    binding: &PlayerSlotBinding,
    server_tick: u64,
) -> Result<PlayerActionState, String> {
    let action_id = binding
        .hold_action
        .as_deref()
        .or(binding.tap_action.as_deref())
        .ok_or_else(|| "Slot has no bound action".to_string())?;

    let def = defs_generated::ACTION_DEFS
        .iter()
        .find(|d| d.id == action_id)
        .ok_or_else(|| format!("Unknown action_id: {action_id}"))?;

    let (phase, phase_ends_tick) = match &def.hold {
        Some(HoldSpec::Charge { max_ticks, .. }) => (state::PHASE_CHARGING, server_tick + *max_ticks as u64),
        _ => (state::PHASE_WINDUP, server_tick + def.phases.windup_ticks as u64),
    };

    Ok(PlayerActionState {
        identity,
        action_id: action_id.to_string(),
        phase,
        phase_started_tick: server_tick,
        phase_ends_tick,
        charge_ticks: 0,
        server_tick,
    })
}

/// Outcome of resolving a Release edge while Charging a dual-bound slot's hold action.
pub(crate) enum ChargeReleaseResolution {
    /// Released before `hold_threshold_ticks`: charging ticks already served convert into
    /// the tap action's windup (same `phase_started_tick`, so no latency is added when the
    /// threshold is authored ~= the tap action's `windupTicks`).
    ResolvedToTap { next: PlayerActionState },
    /// Released at/after `hold_threshold_ticks`: the hold action releases with its charge
    /// fraction.
    ResolvedToHold { next: PlayerActionState, charge_fraction: f32 },
    /// This Release edge doesn't apply to the current row (wrong slot / not a charge-mode
    /// hold / no fallback tap action bound): ignored.
    Ignored,
}

/// Pure / host-free so unit tests can call it without `ctx.db`.
pub(crate) fn resolve_charge_release(
    current: &PlayerActionState,
    binding: &PlayerSlotBinding,
    server_tick: u64,
) -> ChargeReleaseResolution {
    let Some(hold_action_id) = binding.hold_action.as_deref() else {
        return ChargeReleaseResolution::Ignored;
    };
    if current.action_id != hold_action_id {
        return ChargeReleaseResolution::Ignored;
    }
    let Some(hold_def) = state::find_action_def(hold_action_id) else {
        return ChargeReleaseResolution::Ignored;
    };
    let Some(HoldSpec::Charge { min_ticks, max_ticks }) = &hold_def.hold else {
        return ChargeReleaseResolution::Ignored;
    };

    let held_ticks = server_tick.saturating_sub(current.phase_started_tick) as u32;

    if held_ticks < binding.hold_threshold_ticks {
        let Some(tap_action_id) = binding.tap_action.as_deref() else {
            return ChargeReleaseResolution::Ignored;
        };
        let Some(tap_def) = state::find_action_def(tap_action_id) else {
            return ChargeReleaseResolution::Ignored;
        };
        let mut next = current.clone();
        next.action_id = tap_action_id.to_string();
        next.phase = state::PHASE_WINDUP;
        next.phase_ends_tick = current.phase_started_tick + tap_def.phases.windup_ticks as u64;
        next.charge_ticks = 0;
        next.server_tick = server_tick;
        ChargeReleaseResolution::ResolvedToTap { next }
    } else {
        let fraction = state::charge_fraction(*min_ticks, *max_ticks, held_ticks);
        let mut next = current.clone();
        next.phase = state::PHASE_WINDUP;
        next.phase_started_tick = server_tick;
        next.phase_ends_tick = server_tick + hold_def.phases.windup_ticks as u64;
        next.charge_ticks = held_ticks.min(*max_ticks) as u64;
        next.server_tick = server_tick;
        ChargeReleaseResolution::ResolvedToHold { next, charge_fraction: fraction }
    }
}

/// Cooldown + resource gate-and-spend for a Press that is about to commit `def` as the new
/// action. Thin host shell: the boolean gate logic itself is `state::cooldown_ready` /
/// `state::resource_check`.
fn gate_and_spend(ctx: &ReducerContext, identity: Identity, def: &ActionDef, server_tick: u64) -> Result<(), String> {
    let cooldown_row = ctx
        .db
        .player_cooldown()
        .identity()
        .filter(identity)
        .find(|row| row.action_id == def.id);
    let ready_tick = cooldown_row.as_ref().map(|row| row.ready_tick);
    if !state::cooldown_ready(ready_tick, server_tick) {
        return Err(format!("Action on cooldown: {}", def.id));
    }

    if let Some(cost) = &def.resource {
        let available = ctx
            .db
            .player_resource()
            .identity()
            .filter(identity)
            .find(|row| row.kind == cost.kind)
            .map(|row| row.amount);
        state::resource_check(&def.resource, available)?;
    }

    let new_ready_tick = server_tick + def.cooldown_ticks as u64;
    match cooldown_row {
        Some(mut row) => {
            row.ready_tick = new_ready_tick;
            ctx.db.player_cooldown().id().update(row);
        }
        None => {
            ctx.db.player_cooldown().insert(PlayerCooldown {
                id: 0,
                identity,
                action_id: def.id.to_string(),
                ready_tick: new_ready_tick,
            });
        }
    }

    if let Some(cost) = &def.resource {
        if let Some(mut row) = ctx
            .db
            .player_resource()
            .identity()
            .filter(identity)
            .find(|row| row.kind == cost.kind)
        {
            row.amount = row.amount.saturating_sub(cost.cost);
            ctx.db.player_resource().id().update(row);
        }
    }

    Ok(())
}

fn handle_press(
    ctx: &ReducerContext,
    identity: Identity,
    binding: &PlayerSlotBinding,
    server_tick: u64,
) -> Result<(), String> {
    let new_state = build_press_state(identity, binding, server_tick)?;
    let def = state::find_action_def(&new_state.action_id)
        .ok_or_else(|| format!("Unknown action_id: {}", new_state.action_id))?;

    let existing = ctx.db.player_action_state().identity().find(identity);
    if let Some(current) = &existing {
        let current_def = state::find_action_def(&current.action_id);
        if !state::can_interrupt(current_def, current.phase, &current.action_id) {
            return Err(format!("Action '{}' cannot be interrupted right now", current.action_id));
        }
    }

    gate_and_spend(ctx, identity, def, server_tick)?;

    if existing.is_some() {
        ctx.db.player_action_state().identity().update(new_state);
    } else {
        ctx.db.player_action_state().insert(new_state);
    }
    Ok(())
}

fn handle_release(
    ctx: &ReducerContext,
    identity: Identity,
    binding: &PlayerSlotBinding,
    server_tick: u64,
) -> Result<(), String> {
    let Some(current) = ctx.db.player_action_state().identity().find(identity) else {
        return Ok(());
    };

    match current.phase {
        state::PHASE_CHARGING => {
            match resolve_charge_release(&current, binding, server_tick) {
                ChargeReleaseResolution::ResolvedToTap { next } => {
                    ctx.db.player_action_state().identity().update(next);
                }
                ChargeReleaseResolution::ResolvedToHold { next, charge_fraction } => {
                    let action_id = next.action_id.clone();
                    ctx.db.player_action_state().identity().update(next);
                    effects::emit_release_event(ctx, identity, &action_id, charge_fraction, server_tick);
                }
                ChargeReleaseResolution::Ignored => {}
            }
            Ok(())
        }
        state::PHASE_HELD => {
            let recovery_ticks = state::find_action_def(&current.action_id)
                .map(|def| def.phases.recovery_ticks)
                .unwrap_or(0);
            let mut next = current.clone();
            next.phase = state::PHASE_RECOVERY;
            next.phase_started_tick = server_tick;
            next.phase_ends_tick = server_tick + recovery_ticks as u64;
            next.server_tick = server_tick;
            ctx.db.player_action_state().identity().update(next);
            Ok(())
        }
        // Irrelevant edge for the current phase: ignored. Single-bound slots ignore the
        // edge they don't use (per doc); a Release mid-Windup for a sustain action before
        // Held is reached is likewise a no-op here (flagged as a contract note — see the
        // wave2-actions report).
        _ => Ok(()),
    }
}

#[spacetimedb::reducer]
pub fn action_input(
    ctx: &ReducerContext,
    slot: String,
    edge: InputEdge,
    aim: Option<Vector3>,
) -> Result<(), String> {
    // `aim` is accepted for wire-contract compliance (captured at Press, refreshed at
    // Release per docs/action-pipeline.md). `player_action_state` has no column to persist
    // it across ticks (frozen schema), so facing-based effects read the actor's live
    // `player_transform.rotation_y` / position at the moment the active window fires
    // instead. Flagged as a contract ambiguity in the wave2-actions report.
    let _ = aim;
    let identity = ctx.sender();

    if ctx.db.player().identity().find(identity).is_none() {
        return Err("Player has not joined".to_string());
    }
    if ctx
        .db
        .player_health()
        .identity()
        .find(identity)
        .map(|health| health.is_dead)
        .unwrap_or(false)
    {
        return Err("Player is dead".to_string());
    }

    let binding = find_binding(
        ctx.db.player_slot_binding().identity().filter(identity),
        &slot,
    )?;
    let server_tick = crate::tick::current_server_tick(ctx);

    match edge {
        InputEdge::Press => handle_press(ctx, identity, &binding, server_tick),
        InputEdge::Release => handle_release(ctx, identity, &binding, server_tick),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::defs_generated::SLOT_BINDINGS;

    #[test]
    fn find_binding_unknown_slot_errors() {
        let Err(err) = find_binding(std::iter::empty(), "primary") else {
            panic!("expected Err for unknown slot");
        };
        assert!(err.contains("Unknown slot: primary"), "got: {err}");
    }

    #[test]
    fn build_press_state_charge_mode_enters_charging() {
        let binding = PlayerSlotBinding {
            id: 0,
            identity: Identity::__dummy(),
            slot: "primary".to_string(),
            tap_action: Some("attack_light".to_string()),
            hold_action: Some("attack_heavy".to_string()),
            hold_threshold_ticks: 5,
        };
        let result = build_press_state(Identity::__dummy(), &binding, 42).expect("press state");
        assert_eq!(result.action_id, "attack_heavy");
        assert_eq!(result.phase, state::PHASE_CHARGING);
        assert_eq!(result.phase_started_tick, 42);
        assert_eq!(result.phase_ends_tick, 42 + 30); // attack_heavy max_ticks
        assert_eq!(result.charge_ticks, 0);
    }

    #[test]
    fn build_press_state_sustain_mode_enters_windup_not_charging() {
        let binding = PlayerSlotBinding {
            id: 0,
            identity: Identity::__dummy(),
            slot: "block".to_string(),
            tap_action: None,
            hold_action: Some("block".to_string()),
            hold_threshold_ticks: 0,
        };
        let result = build_press_state(Identity::__dummy(), &binding, 10).expect("press state");
        assert_eq!(result.action_id, "block");
        assert_eq!(result.phase, state::PHASE_WINDUP, "sustain must not enter Charging");
        assert_eq!(result.phase_ends_tick, 10 + 2); // block windup_ticks
    }

    #[test]
    fn build_press_state_instant_tap_only_enters_windup() {
        for binding_def in SLOT_BINDINGS.iter().filter(|b| b.hold_action.is_none()) {
            let binding = PlayerSlotBinding {
                id: 0,
                identity: Identity::__dummy(),
                slot: binding_def.slot.to_string(),
                tap_action: binding_def.tap_action.map(str::to_string),
                hold_action: binding_def.hold_action.map(str::to_string),
                hold_threshold_ticks: binding_def.hold_threshold_ticks,
            };
            let result = build_press_state(Identity::__dummy(), &binding, 5).expect("press state");
            assert_eq!(result.phase, state::PHASE_WINDUP, "{}: tap-only slot must enter Windup", binding_def.slot);
        }
    }

    fn dual_bound_binding() -> PlayerSlotBinding {
        let binding_def = SLOT_BINDINGS
            .iter()
            .find(|b| b.tap_action.is_some() && b.hold_action.is_some())
            .expect("at least one dual-bound slot");
        PlayerSlotBinding {
            id: 0,
            identity: Identity::__dummy(),
            slot: binding_def.slot.to_string(),
            tap_action: binding_def.tap_action.map(str::to_string),
            hold_action: binding_def.hold_action.map(str::to_string),
            hold_threshold_ticks: binding_def.hold_threshold_ticks,
        }
    }

    #[test]
    fn charge_release_before_threshold_resolves_to_tap() {
        let binding = dual_bound_binding();
        let pressed = build_press_state(Identity::__dummy(), &binding, 100).unwrap();
        let release_tick = 100 + binding.hold_threshold_ticks as u64 - 1;
        let ChargeReleaseResolution::ResolvedToTap { next } = resolve_charge_release(&pressed, &binding, release_tick) else {
            panic!("expected tap resolution below threshold");
        };
        assert_eq!(next.action_id, binding.tap_action.clone().unwrap());
        assert_eq!(next.phase, state::PHASE_WINDUP);
    }

    #[test]
    fn charge_release_at_threshold_resolves_to_hold() {
        let binding = dual_bound_binding();
        let pressed = build_press_state(Identity::__dummy(), &binding, 100).unwrap();
        let release_tick = 100 + binding.hold_threshold_ticks as u64;
        let ChargeReleaseResolution::ResolvedToHold { next, charge_fraction } = resolve_charge_release(&pressed, &binding, release_tick) else {
            panic!("expected hold resolution at threshold");
        };
        assert_eq!(next.action_id, binding.hold_action.clone().unwrap());
        assert_eq!(next.phase, state::PHASE_WINDUP);
        assert!(charge_fraction >= 0.0 && charge_fraction <= 1.0);
    }

    #[test]
    fn charge_release_ignored_for_non_charging_or_wrong_slot() {
        let binding = dual_bound_binding();
        let mut idle = build_press_state(Identity::__dummy(), &binding, 100).unwrap();
        idle.action_id = "some_other_action".to_string();
        matches!(resolve_charge_release(&idle, &binding, 200), ChargeReleaseResolution::Ignored);
    }
}
