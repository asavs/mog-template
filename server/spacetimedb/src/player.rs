use crate::actions;
use crate::common::{default_input, GROUNDED_EPSILON, MovementState, Vector3, GROUND_Y};
use crate::tables::*;
use spacetimedb::{Identity, ReducerContext, Table};

const RESPAWN_DELAY_TICKS: u64 = 60;

#[spacetimedb::reducer]
pub fn join_game(ctx: &ReducerContext, username: String) -> Result<(), String> {
    let identity = ctx.sender();
    if ctx.db.player().identity().find(identity).is_some() {
        spacetimedb::log::info!(
            "Player already joined; join_game is a no-op: {}",
            identity
        );
        return Ok(());
    }

    let username = username.trim().chars().take(32).collect::<String>();
    if username.is_empty() {
        return Err("Username is required".to_string());
    }

    spacetimedb::log::info!("Player joining: {} ({})", username, identity);

    let (
        restored_username,
        restored_position,
        restored_rotation_y,
        restored_last_input_seq,
        restored_last_processed_client_tick,
        restored_current_health,
        restored_max_health,
        restored_is_dead,
        restored_respawn_tick,
    ) = if let Some(logged_out) = ctx.db.logged_out_player().identity().find(identity) {
        spacetimedb::log::info!("Restoring logged out player: {}", identity);
        let data = (
            logged_out.username.clone(),
            logged_out.position.clone(),
            logged_out.rotation_y,
            logged_out.last_input_seq,
            logged_out.last_processed_client_tick,
            logged_out.current_health,
            logged_out.max_health,
            logged_out.is_dead,
            logged_out.respawn_tick,
        );
        ctx.db.logged_out_player().identity().delete(identity);
        data
    } else {
        spacetimedb::log::info!("Creating new player record: {}", identity);
        (
            username,
            spawn_position(),
            0.0,
            0,
            0,
            PLAYER_MAX_HEALTH,
            PLAYER_MAX_HEALTH,
            false,
            0,
        )
    };

    ctx.db.player().insert(PlayerData {
        identity,
        username: restored_username,
        connected: true,
        joined_at: ctx.timestamp,
    });

    let mut restored_input = default_input();
    restored_input.sequence = restored_last_input_seq;
    restored_input.client_tick = restored_last_processed_client_tick;

    ctx.db.player_input().insert(PlayerInput {
        identity,
        input: restored_input,
        rotation_y: restored_rotation_y,
        last_input_seq: restored_last_input_seq,
        last_processed_client_tick: restored_last_processed_client_tick,
        updated_at: ctx.timestamp,
    });

    ctx.db
        .player_jump_state()
        .insert(PlayerJumpState::default_for_identity(identity));

    let restored_movement_state = idle_movement_state_for_position(&restored_position);
    let join_server_tick = crate::tick::current_server_tick(ctx);
    ctx.db.player_transform().insert(PlayerTransform {
        identity,
        position: restored_position,
        rotation_y: restored_rotation_y,
        is_moving: false,
        movement_state: restored_movement_state,
        server_tick: join_server_tick,
        updated_at: ctx.timestamp,
    });
    ctx.db.player_input_ack().insert(PlayerInputAck {
        identity,
        last_input_seq: restored_last_input_seq,
        last_processed_client_tick: restored_last_processed_client_tick,
        server_tick: join_server_tick,
    });

    ctx.db.player_health().insert(PlayerHealth {
        identity,
        current_health: restored_current_health,
        max_health: restored_max_health,
        is_dead: restored_is_dead,
        respawn_tick: restored_respawn_tick,
        updated_at: ctx.timestamp,
    });

    ctx.db.player_action_state().insert(PlayerActionState {
        identity,
        action_id: String::new(),
        phase: 0,
        phase_started_tick: 0,
        phase_ends_tick: 0,
        charge_ticks: 0,
        server_tick: join_server_tick,
    });

    seed_player_slot_bindings(ctx, identity);
    seed_player_resources(ctx, identity);

    Ok(())
}

#[spacetimedb::reducer]
pub fn leave_game(ctx: &ReducerContext) -> Result<(), String> {
    let identity = ctx.sender();
    if ctx.db.player().identity().find(identity).is_none() {
        return Err("Player has not joined".to_string());
    }

    spacetimedb::log::info!("Player leaving: {}", identity);
    cleanup_player(ctx, identity);
    Ok(())
}

pub(crate) fn cleanup_player(ctx: &ReducerContext, identity: Identity) {
    if let Some(player) = ctx.db.player().identity().find(identity) {
        let transform = ctx.db.player_transform().identity().find(identity);
        let input_ack = ctx.db.player_input_ack().identity().find(identity);
        let health = ctx.db.player_health().identity().find(identity);
        let logged_out = LoggedOutPlayerData {
            identity: player.identity,
            username: player.username.clone(),
            position: transform
                .as_ref()
                .map(|row| row.position.clone())
                .unwrap_or_else(Vector3::zero),
            rotation_y: transform.as_ref().map(|row| row.rotation_y).unwrap_or(0.0),
            last_input_seq: input_ack
                .as_ref()
                .map(|row| row.last_input_seq)
                .unwrap_or(0),
            last_processed_client_tick: input_ack
                .as_ref()
                .map(|row| row.last_processed_client_tick)
                .unwrap_or(0),
            current_health: health
                .as_ref()
                .map(|row| row.current_health)
                .unwrap_or(PLAYER_MAX_HEALTH),
            max_health: health
                .as_ref()
                .map(|row| row.max_health)
                .unwrap_or(PLAYER_MAX_HEALTH),
            is_dead: health.as_ref().map(|row| row.is_dead).unwrap_or(false),
            respawn_tick: health.as_ref().map(|row| row.respawn_tick).unwrap_or(0),
            last_seen: ctx.timestamp,
        };

        if ctx
            .db
            .logged_out_player()
            .identity()
            .find(identity)
            .is_some()
        {
            ctx.db.logged_out_player().identity().update(logged_out);
        } else {
            ctx.db.logged_out_player().insert(logged_out);
        }

        ctx.db.player().identity().delete(identity);
        ctx.db.player_input().identity().delete(identity);
        ctx.db.player_jump_state().identity().delete(identity);
        ctx.db.player_transform().identity().delete(identity);
        ctx.db.player_input_ack().identity().delete(identity);
        ctx.db.player_health().identity().delete(identity);
        ctx.db.player_action_state().identity().delete(identity);

        let slot_bindings: Vec<PlayerSlotBinding> = ctx
            .db
            .player_slot_binding()
            .identity()
            .filter(identity)
            .collect();
        for row in slot_bindings {
            ctx.db.player_slot_binding().id().delete(&row.id);
        }

        let resources: Vec<PlayerResource> = ctx
            .db
            .player_resource()
            .identity()
            .filter(identity)
            .collect();
        for row in resources {
            ctx.db.player_resource().id().delete(&row.id);
        }

        let cooldowns: Vec<PlayerCooldown> = ctx
            .db
            .player_cooldown()
            .identity()
            .filter(identity)
            .collect();
        for row in cooldowns {
            ctx.db.player_cooldown().id().delete(&row.id);
        }
    }
}

pub(crate) fn respawn_ready_players(ctx: &ReducerContext, server_tick: u64) {
    let health_rows: Vec<PlayerHealth> = ctx.db.player_health().iter().collect();
    for mut health in health_rows {
        if !health.is_dead || health.respawn_tick > server_tick {
            continue;
        }

        let identity = health.identity;
        health.current_health = health.max_health;
        health.is_dead = false;
        health.respawn_tick = 0;
        health.updated_at = ctx.timestamp;
        ctx.db.player_health().identity().update(health);

        if let Some(mut action_state) = ctx.db.player_action_state().identity().find(identity) {
            action_state.action_id = String::new();
            action_state.phase = 0;
            action_state.phase_started_tick = 0;
            action_state.phase_ends_tick = 0;
            action_state.charge_ticks = 0;
            action_state.server_tick = server_tick;
            ctx.db.player_action_state().identity().update(action_state);
        }

        if let Some(mut transform) = ctx.db.player_transform().identity().find(identity) {
            transform.position = spawn_position();
            transform.is_moving = false;
            transform.movement_state = MovementState::grounded();
            transform.server_tick = server_tick;
            transform.updated_at = ctx.timestamp;
            ctx.db.player_transform().identity().update(transform);
        }

        if let Some(mut input) = ctx.db.player_input().identity().find(identity) {
            input.input = default_input();
            input.updated_at = ctx.timestamp;
            ctx.db.player_input().identity().update(input);
        }

        if let Some(mut jump_state) = ctx.db.player_jump_state().identity().find(identity) {
            jump_state.vertical_velocity = 0.0;
            jump_state.was_jump_pressed = false;
            ctx.db.player_jump_state().identity().update(jump_state);
        }

        seed_player_resources(ctx, identity);

        spacetimedb::log::info!("Player respawned: {}", identity);
    }
}

/// Death cancels any in-flight action state: clears `action_id`/phase back to Idle so a
/// dead player cannot keep charging/attacking/blocking. Called from
/// `actions::effects::apply_damage` when a hit brings health to 0. Idempotent no-op if the
/// player has no action-state row or is already idle.
pub(crate) fn cancel_action_state(ctx: &ReducerContext, identity: Identity, server_tick: u64) {
    if let Some(mut action_state) = ctx.db.player_action_state().identity().find(identity) {
        if action_state.action_id.is_empty() && action_state.phase == 0 {
            return;
        }
        action_state.action_id = String::new();
        action_state.phase = 0;
        action_state.phase_started_tick = server_tick;
        action_state.phase_ends_tick = 0;
        action_state.charge_ticks = 0;
        action_state.server_tick = server_tick;
        ctx.db.player_action_state().identity().update(action_state);
    }
}

fn seed_player_slot_bindings(ctx: &ReducerContext, identity: Identity) {
    for binding in actions::SLOT_BINDINGS {
        ctx.db.player_slot_binding().insert(PlayerSlotBinding {
            id: 0,
            identity,
            slot: binding.slot.to_string(),
            tap_action: binding.tap_action.map(str::to_string),
            hold_action: binding.hold_action.map(str::to_string),
            hold_threshold_ticks: binding.hold_threshold_ticks,
        });
    }
}

fn seed_player_resources(ctx: &ReducerContext, identity: Identity) {
    // Clear existing resources for this identity, then re-seed from defs.
    let existing: Vec<PlayerResource> = ctx
        .db
        .player_resource()
        .identity()
        .filter(identity)
        .collect();
    for row in existing {
        ctx.db.player_resource().id().delete(&row.id);
    }

    for resource in actions::RESOURCE_DEFS {
        ctx.db.player_resource().insert(PlayerResource {
            id: 0,
            identity,
            kind: resource.kind.to_string(),
            amount: resource.on_respawn,
        });
    }
}

/// Flat-ground spawn at world origin.
/// Wave-later: select from shared/arena.json `spawns` array (not wired yet).
fn spawn_position() -> Vector3 {
    Vector3 {
        x: 0.0,
        y: 0.0,
        z: 0.0,
    }
}

fn idle_movement_state_for_position(position: &Vector3) -> MovementState {
    let is_grounded = position.y <= GROUND_Y + GROUNDED_EPSILON;
    MovementState::new(is_grounded, is_grounded, false, false)
}

#[allow(dead_code)]
pub(crate) fn respawn_delay_ticks() -> u64 {
    RESPAWN_DELAY_TICKS
}
