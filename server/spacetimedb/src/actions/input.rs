use super::defs_generated;
use super::InputEdge;
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

/// Build the `PlayerActionState` for a Press edge from a resolved slot binding.
/// Pure / host-free so unit tests can call it without `ctx.db`.
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

    let phase = if def.hold.is_some() { 1u8 } else { 2u8 };

    Ok(PlayerActionState {
        identity,
        action_id: action_id.to_string(),
        phase,
        phase_started_tick: server_tick,
        phase_ends_tick: 0, // stub — full windup/charge timing lands next wave
        charge_ticks: 0,
        server_tick,
    })
}

#[spacetimedb::reducer]
pub fn action_input(
    ctx: &ReducerContext,
    slot: String,
    edge: InputEdge,
    aim: Option<Vector3>,
) -> Result<(), String> {
    let _ = aim;
    let identity = ctx.sender();

    if ctx.db.player().identity().find(identity).is_none() {
        return Err("Player has not joined".to_string());
    }

    let binding = find_binding(
        ctx.db.player_slot_binding().identity().filter(identity),
        &slot,
    )?;

    match edge {
        InputEdge::Press => {
            let server_tick = crate::tick::current_server_tick(ctx);
            let state = build_press_state(identity, &binding, server_tick)?;

            if ctx
                .db
                .player_action_state()
                .identity()
                .find(identity)
                .is_some()
            {
                ctx.db.player_action_state().identity().update(state);
            } else {
                ctx.db.player_action_state().insert(state);
            }
            Ok(())
        }
        InputEdge::Release => {
            // TODO(wave1->wave2): full release/charge-fraction logic
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_binding_unknown_slot_errors() {
        let Err(err) = find_binding(std::iter::empty(), "primary") else {
            panic!("expected Err for unknown slot");
        };
        assert!(
            err.contains("Unknown slot: primary"),
            "expected Unknown slot error, got: {err}"
        );
    }

    #[test]
    fn build_press_state_primary_prefers_hold_action_and_charges() {
        let binding = PlayerSlotBinding {
            id: 0,
            identity: Identity::__dummy(),
            slot: "primary".to_string(),
            tap_action: Some("attack_light".to_string()),
            hold_action: Some("attack_heavy".to_string()),
            hold_threshold_ticks: 5,
        };

        let state = build_press_state(Identity::__dummy(), &binding, 42).expect("press state");
        assert_eq!(state.action_id, "attack_heavy");
        assert_eq!(state.phase, 1); // Charging — attack_heavy has hold in ACTION_DEFS
        assert_eq!(state.phase_started_tick, 42);
        assert_eq!(state.phase_ends_tick, 0);
        assert_eq!(state.charge_ticks, 0);
        assert_eq!(state.server_tick, 42);
    }
}
