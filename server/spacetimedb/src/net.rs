use crate::common::InputState;
use crate::tables::*;
use spacetimedb::{Identity, ReducerContext, Table};

#[spacetimedb::reducer]
pub fn update_player_input(
    ctx: &ReducerContext,
    input: InputState,
    rotation_y: f32,
) -> Result<(), String> {
    let identity = ctx.sender();

    if !rotation_y.is_finite() {
        return Err("Rotation must be finite".to_string());
    }

    if ctx.db.player().identity().find(identity).is_none() {
        spacetimedb::log::warn!("Input received for unknown player: {}", identity);
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
        return Ok(());
    }

    if let Some(mut player_input) = ctx.db.player_input().identity().find(identity) {
        if input.sequence <= player_input.last_input_seq {
            return Ok(());
        }

        player_input.last_input_seq = input.sequence;
        player_input.last_processed_client_tick = input.client_tick;
        player_input.input = input;
        player_input.rotation_y = normalize_rotation(rotation_y);
        player_input.updated_at = ctx.timestamp;
        ctx.db.player_input().identity().update(player_input);
        Ok(())
    } else {
        Err("Player input row is missing".to_string())
    }
}

fn normalize_rotation(rotation_y: f32) -> f32 {
    rotation_y.rem_euclid(2.0 * std::f32::consts::PI)
}

/// Publish `player_input_ack` only when the owning client's reconcile watermark moved.
/// Pure-ack updates must not touch `player_transform` (row-level sync would fan out pose).
pub fn publish_input_ack_if_changed(
    ctx: &ReducerContext,
    identity: Identity,
    last_input_seq: u32,
    last_processed_client_tick: u32,
    server_tick: u64,
) {
    if let Some(existing) = ctx.db.player_input_ack().identity().find(identity) {
        if existing.last_input_seq == last_input_seq
            && existing.last_processed_client_tick == last_processed_client_tick
        {
            return;
        }
        ctx.db.player_input_ack().identity().update(PlayerInputAck {
            identity,
            last_input_seq,
            last_processed_client_tick,
            server_tick,
        });
    } else {
        ctx.db.player_input_ack().insert(PlayerInputAck {
            identity,
            last_input_seq,
            last_processed_client_tick,
            server_tick,
        });
    }
}
