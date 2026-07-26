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
            // actions::state::movement_fraction(action_id, phase) gates move speed by action
            // phase (docs/action-pipeline.md, "movement" field). A player with no action-state
            // row (never granted one, or idle) reads as fraction 1.0 — the same fail-open the
            // client's `deriveGates` uses for an unrecognized/empty action id.
            let action_state = ctx.db.player_action_state().identity().find(transform.identity);
            let movement_fraction = action_state
                .as_ref()
                .map(|state| actions::state::movement_fraction(&state.action_id, state.phase))
                .unwrap_or(1.0);
            // actions::state::can_rotate(action_id, phase) freezes character yaw mid-action
            // (docs/action-pipeline.md, "canRotate" field). When frozen, the incoming
            // `player_input.rotation_y` (whatever the player's camera currently points at) is
            // dropped in favor of the transform's own last-applied yaw — both the stored facing
            // AND the movement-direction calculation inside `update_transform` key off this
            // same value, so a rooted-yaw def can't be strafed around its frozen facing either.
            let can_rotate = action_state
                .as_ref()
                .map(|state| actions::state::can_rotate(&state.action_id, state.phase))
                .unwrap_or(true);
            let effective_rotation_y = if can_rotate { player_input.rotation_y } else { transform.rotation_y };
            player_logic::update_transform(
                &mut transform,
                &mut jump_state,
                &player_input.input,
                effective_rotation_y,
                movement_fraction,
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

/// Advance every live projectile by `speed / TICK_RATE`, resolve a segment hit test against
/// player capsules (fixed radius, not the def's own `radius` field — see
/// `actions::effects::first_target_hit_by_segment`), apply damage on hit, and despawn at
/// `max_distance`. Speed/damage/max_distance are re-derived from `ACTION_DEFS` by
/// `action_id` each tick (the `Projectile` row itself only stores position/kinematics).
fn step_projectiles(ctx: &ReducerContext, server_tick: u64) {
    let rows: Vec<Projectile> = ctx.db.projectile().iter().collect();
    for mut projectile in rows {
        let Some(def) = actions::state::find_action_def(&projectile.action_id) else {
            ctx.db.projectile().id().delete(&projectile.id);
            continue;
        };
        let Some((speed, max_distance, damage, blocked_damage)) = def.effects.iter().find_map(|effect| match effect {
            actions::EffectDef::Projectile { speed, max_distance, damage, blocked_damage, .. } => Some((*speed, *max_distance, damage, blocked_damage)),
            _ => None,
        }) else {
            ctx.db.projectile().id().delete(&projectile.id);
            continue;
        };

        let (new_position, step) = actions::effects::step_projectile_position(&projectile.position, &projectile.direction, speed, crate::common::TICK_RATE);
        projectile.previous_position = projectile.position.clone();
        projectile.position = new_position;
        projectile.distance_traveled += step;

        if let Some(target) = actions::effects::first_target_hit_by_segment(ctx, &projectile.previous_position, &projectile.position, projectile.owner) {
            // All current projectile defs are instant (hold: null) — full damage fraction.
            let fraction = 1.0;
            let raw = actions::effects::lerp_scaled(damage, fraction).round().max(0.0) as u32;
            let blocked = actions::effects::lerp_scaled(blocked_damage, fraction).round().max(0.0) as u32;
            actions::effects::apply_damage(ctx, projectile.owner, target, &projectile.action_id, raw, Some(blocked), server_tick, Some(projectile.position.clone()));
            ctx.db.projectile().id().delete(&projectile.id);
            continue;
        }

        if projectile.distance_traveled >= max_distance {
            ctx.db.projectile().id().delete(&projectile.id);
            continue;
        }

        ctx.db.projectile().id().update(projectile);
    }
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
