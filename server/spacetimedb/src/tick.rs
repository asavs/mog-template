use crate::actions;
use crate::common::MovementState;
use crate::net;
use crate::player;
use crate::player_logic;
use crate::tables::*;
use spacetimedb::{ReducerContext, Table};

const TRANSIENT_EVENT_RETENTION_TICKS: u64 = 40;

#[spacetimedb::reducer(update)]
pub fn game_tick(ctx: &ReducerContext, _tick_info: GameTickSchedule) -> Result<(), String> {
    if ctx.sender() != ctx.identity() {
        return Err("Only the scheduler can run game_tick".to_string());
    }

    let server_tick = next_server_tick(ctx);
    player::respawn_ready_players(ctx, server_tick);
    actions::state::advance_all(ctx, server_tick);

    let transforms: Vec<PlayerTransform> = ctx.db.player_transform().iter().collect();
    for mut transform in transforms {
        let before = player_logic::TransformPoseSnapshot::from(&transform);

        if ctx
            .db
            .player_health()
            .identity()
            .find(transform.identity)
            .map(|health| health.is_dead)
            .unwrap_or(false)
        {
            transform.is_moving = false;
            transform.movement_state = idle_movement_state_for_position(&transform.position);
            if player_logic::transform_needs_publish_from_snapshot(&before, &transform) {
                transform.server_tick = server_tick;
                transform.updated_at = ctx.timestamp;
                ctx.db.player_transform().identity().update(transform);
            }
            continue;
        }

        if let Some(player_input) = ctx.db.player_input().identity().find(transform.identity) {
            let mut jump_state = ctx
                .db
                .player_jump_state()
                .identity()
                .find(transform.identity)
                .unwrap_or_else(|| PlayerJumpState::default_for_identity(transform.identity));
            player_logic::update_transform(
                &mut transform,
                &mut jump_state,
                &player_input.input,
                player_input.rotation_y,
            );
            if ctx
                .db
                .player_jump_state()
                .identity()
                .find(transform.identity)
                .is_some()
            {
                ctx.db.player_jump_state().identity().update(jump_state);
            } else {
                ctx.db.player_jump_state().insert(jump_state);
            }
            // Pose channel: semantic pose deltas only (no idle rebroadcast, no pure-ack).
            if player_logic::transform_needs_publish_from_snapshot(&before, &transform) {
                transform.server_tick = server_tick;
                transform.updated_at = ctx.timestamp;
                ctx.db.player_transform().identity().update(transform);
            }
            // Ack channel: own row so remotes do not receive full pose on ack-only ticks.
            net::publish_input_ack_if_changed(
                ctx,
                player_input.identity,
                player_input.last_input_seq,
                player_input.last_processed_client_tick,
                server_tick,
            );
        }
    }

    step_projectiles(ctx, server_tick);
    cleanup_old_action_events(ctx, server_tick);

    Ok(())
}

pub(crate) fn current_server_tick(ctx: &ReducerContext) -> u64 {
    ctx.db
        .tick_state()
        .version()
        .find(1)
        .map(|state| state.server_tick)
        .unwrap_or(0)
}

pub(crate) fn next_server_tick(ctx: &ReducerContext) -> u64 {
    if let Some(mut state) = ctx.db.tick_state().version().find(1) {
        state.server_tick += 1;
        let tick = state.server_tick;
        ctx.db.tick_state().version().update(state);
        tick
    } else {
        0
    }
}

fn step_projectiles(ctx: &ReducerContext, server_tick: u64) {
    // TODO(wave1->wave2): step projectile positions, resolve hits via actions::effects
    let _ = (ctx, server_tick);
}

fn cleanup_old_action_events(ctx: &ReducerContext, server_tick: u64) {
    if server_tick > TRANSIENT_EVENT_RETENTION_TICKS {
        ctx.db
            .action_event()
            .server_tick()
            .delete(..server_tick - TRANSIENT_EVENT_RETENTION_TICKS);
    }
}

fn idle_movement_state_for_position(position: &crate::common::Vector3) -> MovementState {
    use crate::common::{GROUND_Y, GROUNDED_EPSILON};
    let is_grounded = position.y <= GROUND_Y + GROUNDED_EPSILON;
    MovementState::new(is_grounded, is_grounded, false, false)
}
