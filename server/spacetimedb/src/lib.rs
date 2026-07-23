mod collision;
mod common;
mod heightmap;
mod loadout;
mod locomotion;
mod player_logic;

use crate::common::{
    default_input, GROUNDED_EPSILON, InputState, MovementState, Vector3, TICK_RATE,
};
use spacetimedb::{ConnectionId, Identity, ReducerContext, ScheduleAt, Table, Timestamp};
use std::time::Duration;

const PLAYER_MAX_HEALTH: u32 = 100;
const SLASH_DAMAGE: u32 = 25;
const BLOCKED_SLASH_DAMAGE: u32 = 5;
const LIGHTNING_DAMAGE: u32 = 25;
const BLOCKED_LIGHTNING_DAMAGE: u32 = 5;
const SLASH_RANGE: f32 = 4.4;
const SLASH_ARC_COSINE: f32 = 0.70710677;
const SLASH_IMPACT_DELAY_SECONDS: f32 = 0.45;
const SLASH_COOLDOWN_SECONDS: f32 = 1.0;
const BLOCK_WINDOW_SECONDS: f32 = 0.6;
const LIGHTNING_IMPACT_DELAY_SECONDS: f32 = 0.45;
const BLOCK_RECOVERY_SECONDS: f32 = 0.25;
const LIGHTNING_COOLDOWN_TICKS: u64 = 13;
const LIGHTNING_TARGET_DISTANCE: f32 = 24.0;
const LIGHTNING_RADIUS: f32 = 3.375;
const FIREBALL_DAMAGE: u32 = 20;
const BLOCKED_FIREBALL_DAMAGE: u32 = 4;
const FIREBALL_COOLDOWN_TICKS: u64 = 10;
const FIREBALL_RELEASE_DELAY_SECONDS: f32 = 0.18;
const FIREBALL_TARGET_DISTANCE: f32 = 28.0;
const FIREBALL_SPEED: f32 = 36.0;
const FIREBALL_RADIUS: f32 = 1.2;
const FIREBALL_SPAWN_FORWARD_OFFSET: f32 = 1.2;
const FIREBALL_SPAWN_RIGHT_OFFSET: f32 = 0.42;
const FIREBALL_SPAWN_HEIGHT: f32 = 1.45;
const RESPAWN_DELAY_TICKS: u64 = 60;
const ACTION_IDLE: &str = "idle";
const ACTION_ATTACKING: &str = "attacking";
const ACTION_BLOCKING: &str = "blocking";
const ACTION_DEAD: &str = "dead";
const ANIMATION_DRINKING: &str = "drinking";
const ACTION_FEEDBACK_SERVER_ACCEPTED: &str = "server_accepted";
const TRANSIENT_EVENT_RETENTION_TICKS: u64 = 40;

#[spacetimedb::table(accessor = player, public)]
pub struct PlayerData {
    #[primary_key]
    pub identity: Identity,
    pub username: String,
    pub connected: bool,
    pub joined_at: Timestamp,
}

#[spacetimedb::table(accessor = player_character, public)]
pub struct PlayerCharacter {
    #[primary_key]
    pub identity: Identity,
    pub character_class: String,
}

#[spacetimedb::table(accessor = player_animation, public)]
pub struct PlayerAnimation {
    #[primary_key]
    pub identity: Identity,
    pub active_animation: String,
    pub attack_seq: u32,
    pub triggered_at: Timestamp,
}

#[spacetimedb::table(accessor = player_health, public)]
pub struct PlayerHealth {
    #[primary_key]
    pub identity: Identity,
    pub current_health: u32,
    pub max_health: u32,
    pub is_dead: bool,
    pub respawn_tick: u64,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = combat_event, public)]
pub struct CombatEvent {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub attacker: Identity,
    pub target: Identity,
    pub event_type: String,
    pub amount: u32,
    #[index(btree)]
    pub server_tick: u64,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = player_action_state, public)]
#[derive(Clone)]
pub struct PlayerActionState {
    #[primary_key]
    pub identity: Identity,
    pub current_action: String,
    pub action_started_tick: u64,
    pub action_active_tick: u64,
    pub action_recovery_until_tick: u64,
    #[index(btree)]
    pub action_ends_tick: u64,
    pub cooldown_ends_tick: u64,
    pub can_move: bool,
    pub can_rotate: bool,
    pub can_attack: bool,
    pub can_block: bool,
    pub feedback_policy: String,
    pub server_tick: u64,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = spell_event, public)]
pub struct SpellEvent {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub caster: Identity,
    pub spell_type: String,
    pub position: Vector3,
    #[index(btree)]
    pub server_tick: u64,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = player_combat_state)]
pub struct PlayerCombatState {
    #[primary_key]
    pub identity: Identity,
    pub last_slash_tick: u64,
}

#[spacetimedb::table(accessor = pending_slash_attack)]
pub struct PendingSlashAttack {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub attacker: Identity,
    pub resolve_tick: u64,
}

#[spacetimedb::table(accessor = pending_lightning_strike)]
pub struct PendingLightningStrike {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub caster: Identity,
    pub position: Vector3,
    pub resolve_tick: u64,
}

#[spacetimedb::table(accessor = pending_fireball_cast)]
pub struct PendingFireballCast {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub caster: Identity,
    pub target_position: Vector3,
    #[index(btree)]
    pub resolve_tick: u64,
}

#[spacetimedb::table(accessor = fireball_projectile, public)]
pub struct FireballProjectile {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub caster: Identity,
    pub position: Vector3,
    pub previous_position: Vector3,
    pub direction: Vector3,
    pub spawned_at_tick: u64,
    pub max_distance: f32,
    pub distance_traveled: f32,
    pub created_at: Timestamp,
}

#[spacetimedb::table(accessor = player_block_state)]
pub struct PlayerBlockState {
    #[primary_key]
    pub identity: Identity,
    pub block_until_tick: u64,
    #[default(false)]
    pub is_blocking: bool,
}

#[spacetimedb::table(accessor = player_spell_state)]
pub struct PlayerSpellState {
    #[primary_key]
    pub identity: Identity,
    pub last_lightning_tick: u64,
    pub last_fireball_tick: u64,
}

#[spacetimedb::table(accessor = player_input)]
pub struct PlayerInput {
    #[primary_key]
    pub identity: Identity,
    pub input: InputState,
    pub rotation_y: f32,
    pub last_input_seq: u32,
    #[default(0)]
    pub last_processed_client_tick: u32,
    pub updated_at: Timestamp,
}

#[spacetimedb::table(accessor = player_jump_state)]
pub struct PlayerJumpState {
    #[primary_key]
    pub identity: Identity,
    pub vertical_velocity: f32,
    pub was_jump_pressed: bool,
}

impl PlayerJumpState {
    pub fn default_for_identity(identity: Identity) -> Self {
        Self {
            identity,
            vertical_velocity: 0.0,
            was_jump_pressed: false,
        }
    }
}

/// Public pose channel — dirty only on semantic pose/move-state change.
/// CSP acks live on `player_input_ack` so pure-ack updates do not rebroadcast
/// full transform rows to remote subscribers (audit #16).
#[spacetimedb::table(accessor = player_transform, public)]
pub struct PlayerTransform {
    #[primary_key]
    pub identity: Identity,
    pub position: Vector3,
    pub rotation_y: f32,
    pub is_moving: bool,
    pub movement_state: MovementState,
    pub server_tick: u64,
    pub updated_at: Timestamp,
}

/// Public input-ack channel for owning-client prediction reconcile.
/// Same primary key as pose, but independent row lifetime for SpacetimeDB
/// row-level sync (update frequency and audience differ from pose).
#[spacetimedb::table(accessor = player_input_ack, public)]
pub struct PlayerInputAck {
    #[primary_key]
    pub identity: Identity,
    pub last_input_seq: u32,
    #[default(0)]
    pub last_processed_client_tick: u32,
    pub server_tick: u64,
}

#[spacetimedb::table(accessor = logged_out_player)]
pub struct LoggedOutPlayerData {
    #[primary_key]
    pub identity: Identity,
    pub username: String,
    pub position: Vector3,
    pub rotation_y: f32,
    pub last_input_seq: u32,
    #[default(0)]
    pub last_processed_client_tick: u32,
    pub last_seen: Timestamp,
    #[default(PLAYER_MAX_HEALTH)]
    pub current_health: u32,
    #[default(PLAYER_MAX_HEALTH)]
    pub max_health: u32,
    #[default(false)]
    pub is_dead: bool,
    #[default(0u64)]
    pub respawn_tick: u64,
    #[default(0u64)]
    pub last_slash_tick: u64,
    #[default(0u64)]
    pub block_until_tick: u64,
    #[default(0u64)]
    pub last_lightning_tick: u64,
    #[default(0u64)]
    pub last_fireball_tick: u64,
}

#[spacetimedb::table(accessor = client_session)]
pub struct ClientSession {
    #[primary_key]
    pub connection_id: ConnectionId,
    pub identity: Identity,
    pub connected_at: Timestamp,
}

#[spacetimedb::table(accessor = config, public)]
pub struct Config {
    #[primary_key]
    pub version: u32,
    pub tick_rate: u32,
}

#[spacetimedb::table(accessor = tick_state)]
pub struct TickState {
    #[primary_key]
    pub version: u32,
    pub server_tick: u64,
}

#[spacetimedb::table(accessor = game_tick_schedule, public, scheduled(game_tick))]
pub struct GameTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    if ctx.db.config().count() == 0 {
        ctx.db.config().insert(Config {
            version: 1,
            tick_rate: TICK_RATE as u32,
        });
    }

    if ctx.db.tick_state().count() == 0 {
        ctx.db.tick_state().insert(TickState {
            version: 1,
            server_tick: 0,
        });
    }

    if ctx.db.game_tick_schedule().count() == 0 {
        let interval = Duration::from_millis((1000.0 / TICK_RATE) as u64);
        ctx.db.game_tick_schedule().insert(GameTickSchedule {
            scheduled_id: 0,
            scheduled_at: ScheduleAt::Interval(interval.into()),
        });
    }

    // Clear stale client sessions on init/restart
    for session in ctx.db.client_session().iter() {
        ctx.db
            .client_session()
            .connection_id()
            .delete(&session.connection_id);
    }
}

#[spacetimedb::reducer(client_connected)]
pub fn identity_connected(ctx: &ReducerContext) {
    let Some(connection_id) = ctx.connection_id() else {
        spacetimedb::log::warn!("Identity connected without connection id: {}", ctx.sender());
        return;
    };

    spacetimedb::log::info!("Identity connected: {} ({:?})", ctx.sender(), connection_id);
    if ctx
        .db
        .client_session()
        .connection_id()
        .find(&connection_id)
        .is_none()
    {
        ctx.db.client_session().insert(ClientSession {
            connection_id,
            identity: ctx.sender(),
            connected_at: ctx.timestamp,
        });
    }
}

#[spacetimedb::reducer(client_disconnected)]
pub fn identity_disconnected(ctx: &ReducerContext) {
    let identity = ctx.sender();
    let Some(connection_id) = ctx.connection_id() else {
        spacetimedb::log::warn!("Identity disconnected without connection id: {}", identity);
        return;
    };

    spacetimedb::log::info!("Identity disconnected: {} ({:?})", identity, connection_id);
    ctx.db
        .client_session()
        .connection_id()
        .delete(&connection_id);

    let still_connected = ctx
        .db
        .client_session()
        .iter()
        .any(|session| session.identity == identity);
    if !still_connected {
        cleanup_player(ctx, identity);
    }
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

fn cleanup_player(ctx: &ReducerContext, identity: Identity) {
    if let Some(player) = ctx.db.player().identity().find(identity) {
        let transform = ctx.db.player_transform().identity().find(identity);
        let input_ack = ctx.db.player_input_ack().identity().find(identity);
        let health = ctx.db.player_health().identity().find(identity);
        let combat_state = ctx.db.player_combat_state().identity().find(identity);
        let block_state = ctx.db.player_block_state().identity().find(identity);
        let spell_state = ctx.db.player_spell_state().identity().find(identity);
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
            last_slash_tick: combat_state
                .as_ref()
                .map(|row| row.last_slash_tick)
                .unwrap_or(0),
            block_until_tick: block_state
                .as_ref()
                .filter(|row| !row.is_blocking)
                .map(|row| row.block_until_tick)
                .unwrap_or(0),
            last_lightning_tick: spell_state
                .as_ref()
                .map(|row| row.last_lightning_tick)
                .unwrap_or(0),
            last_fireball_tick: spell_state
                .as_ref()
                .map(|row| row.last_fireball_tick)
                .unwrap_or(0),
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
        ctx.db.player_animation().identity().delete(identity);
        ctx.db.player_health().identity().delete(identity);
        ctx.db.player_action_state().identity().delete(identity);
        ctx.db.player_combat_state().identity().delete(identity);
        let pending_slashes: Vec<PendingSlashAttack> = ctx
            .db
            .pending_slash_attack()
            .iter()
            .filter(|attack| attack.attacker == identity)
            .collect();
        for pending_slash in pending_slashes {
            ctx.db.pending_slash_attack().id().delete(&pending_slash.id);
        }
        let pending_lightning_strikes: Vec<PendingLightningStrike> = ctx
            .db
            .pending_lightning_strike()
            .iter()
            .filter(|strike| strike.caster == identity)
            .collect();
        for pending_lightning_strike in pending_lightning_strikes {
            ctx.db
                .pending_lightning_strike()
                .id()
                .delete(&pending_lightning_strike.id);
        }
        let pending_fireball_casts: Vec<PendingFireballCast> = ctx
            .db
            .pending_fireball_cast()
            .caster()
            .filter(identity)
            .collect();
        for pending_fireball_cast in pending_fireball_casts {
            ctx.db
                .pending_fireball_cast()
                .id()
                .delete(&pending_fireball_cast.id);
        }
        let fireball_projectiles: Vec<FireballProjectile> = ctx
            .db
            .fireball_projectile()
            .iter()
            .filter(|projectile| projectile.caster == identity)
            .collect();
        for fireball_projectile in fireball_projectiles {
            ctx.db
                .fireball_projectile()
                .id()
                .delete(&fireball_projectile.id);
        }
        ctx.db.player_block_state().identity().delete(identity);
        ctx.db.player_spell_state().identity().delete(identity);
    }
}

#[spacetimedb::reducer]
pub fn join_game(ctx: &ReducerContext, username: String) -> Result<(), String> {
    join_game_as(ctx, username, "wizard".to_string())
}

#[spacetimedb::reducer]
pub fn join_game_as(
    ctx: &ReducerContext,
    username: String,
    character_class: String,
) -> Result<(), String> {
    let identity = ctx.sender();
    if ctx.db.player().identity().find(identity).is_some() {
        spacetimedb::log::info!(
            "Player already joined; join_game_as is a no-op: {}",
            identity
        );
        return Ok(());
    }

    let username = username.trim().chars().take(32).collect::<String>();
    if username.is_empty() {
        return Err("Username is required".to_string());
    }
    let character_class = normalize_character_class(character_class)?;

    spacetimedb::log::info!(
        "Player joining: {} as {} ({})",
        username,
        character_class,
        identity
    );

    let (
        restored_username,
        restored_character_class,
        restored_position,
        restored_rotation_y,
        restored_last_input_seq,
        restored_last_processed_client_tick,
        restored_current_health,
        restored_max_health,
        restored_is_dead,
        restored_respawn_tick,
        restored_last_slash_tick,
        restored_block_until_tick,
        restored_last_lightning_tick,
        restored_last_fireball_tick,
    ) = if let Some(logged_out) = ctx.db.logged_out_player().identity().find(identity) {
        spacetimedb::log::info!("Restoring logged out player: {}", identity);
        // Normalize the stored class so legacy rows (paladin/wizard/wizard2)
        // keep working without a migration; un-normalizable values default to wizard.
        let restored_class = ctx
            .db
            .player_character()
            .identity()
            .find(identity)
            .and_then(|row| normalize_character_class(row.character_class).ok())
            .unwrap_or_else(|| "wizard".to_string());
        let data = (
            logged_out.username.clone(),
            restored_class,
            logged_out.position.clone(),
            logged_out.rotation_y,
            logged_out.last_input_seq,
            logged_out.last_processed_client_tick,
            logged_out.current_health,
            logged_out.max_health,
            logged_out.is_dead,
            logged_out.respawn_tick,
            logged_out.last_slash_tick,
            logged_out.block_until_tick,
            logged_out.last_lightning_tick,
            logged_out.last_fireball_tick,
        );
        ctx.db.logged_out_player().identity().delete(identity);
        data
    } else {
        spacetimedb::log::info!("Creating new player record: {}", identity);
        (
            username,
            character_class,
            spawn_position(),
            0.0,
            0,
            0,
            PLAYER_MAX_HEALTH,
            PLAYER_MAX_HEALTH,
            false,
            0,
            0,
            0,
            0,
            0,
        )
    };

    let player_data = PlayerData {
        identity,
        username: restored_username,
        connected: true,
        joined_at: ctx.timestamp,
    };
    ctx.db.player().insert(player_data);

    let player_character = PlayerCharacter {
        identity,
        character_class: restored_character_class,
    };
    if ctx
        .db
        .player_character()
        .identity()
        .find(identity)
        .is_some()
    {
        ctx.db
            .player_character()
            .identity()
            .update(player_character);
    } else {
        ctx.db.player_character().insert(player_character);
    }

    let mut restored_input = default_input();
    restored_input.sequence = restored_last_input_seq;
    restored_input.client_tick = restored_last_processed_client_tick;

    let player_input = PlayerInput {
        identity,
        input: restored_input,
        rotation_y: restored_rotation_y,
        last_input_seq: restored_last_input_seq,
        last_processed_client_tick: restored_last_processed_client_tick,
        updated_at: ctx.timestamp,
    };
    ctx.db.player_input().insert(player_input);

    ctx.db
        .player_jump_state()
        .insert(PlayerJumpState::default_for_identity(identity));

    let restored_movement_state = idle_movement_state_for_position(&restored_position);
    let join_server_tick = current_server_tick(ctx);
    let player_transform = PlayerTransform {
        identity,
        position: restored_position,
        rotation_y: restored_rotation_y,
        is_moving: false,
        movement_state: restored_movement_state,
        server_tick: join_server_tick,
        updated_at: ctx.timestamp,
    };
    ctx.db.player_transform().insert(player_transform);
    ctx.db.player_input_ack().insert(PlayerInputAck {
        identity,
        last_input_seq: restored_last_input_seq,
        last_processed_client_tick: restored_last_processed_client_tick,
        server_tick: join_server_tick,
    });

    let player_health = PlayerHealth {
        identity,
        current_health: restored_current_health,
        max_health: restored_max_health,
        is_dead: restored_is_dead,
        respawn_tick: restored_respawn_tick,
        updated_at: ctx.timestamp,
    };
    ctx.db.player_health().insert(player_health);

    ctx.db
        .player_action_state()
        .insert(default_player_action_state(
            identity,
            current_server_tick(ctx),
            ctx.timestamp,
            restored_is_dead,
        ));

    ctx.db.player_combat_state().insert(PlayerCombatState {
        identity,
        last_slash_tick: restored_last_slash_tick,
    });

    ctx.db.player_block_state().insert(PlayerBlockState {
        identity,
        is_blocking: restored_block_until_tick > 0,
        block_until_tick: restored_block_until_tick,
    });

    ctx.db.player_spell_state().insert(PlayerSpellState {
        identity,
        last_lightning_tick: restored_last_lightning_tick,
        last_fireball_tick: restored_last_fireball_tick,
    });

    Ok(())
}

fn normalize_character_class(character_class: String) -> Result<String, String> {
    loadout::normalize_preset_id(&character_class)
}

// Grant-derived capabilities (loadout presets). Stored rows may still carry legacy
// class strings until players rejoin — normalize first; bad values fall back to wizard.
fn class_capabilities(class: &str) -> loadout::Capabilities {
    loadout::capabilities_for_class(class)
}

#[spacetimedb::reducer]
pub fn trigger_slash_attack(ctx: &ReducerContext) -> Result<(), String> {
    let identity = ctx.sender();
    if ctx.db.player().identity().find(identity).is_none() {
        return Err("Player has not joined".to_string());
    }

    let Some(player_character) = ctx.db.player_character().identity().find(identity) else {
        return Err("Player character row is missing".to_string());
    };
    if !class_capabilities(&player_character.character_class).melee {
        return Err("This class cannot slash".to_string());
    }

    let Some(attacker_health) = ctx.db.player_health().identity().find(identity) else {
        return Err("Player health row is missing".to_string());
    };
    if attacker_health.is_dead {
        return Ok(());
    }

    let server_tick = current_server_tick(ctx);
    if !refresh_player_action_state(ctx, identity, server_tick).can_attack {
        return Ok(());
    }

    if let Some(mut combat_state) = ctx.db.player_combat_state().identity().find(identity) {
        if combat_state.last_slash_tick != 0
            && server_tick.saturating_sub(combat_state.last_slash_tick) < slash_cooldown_ticks()
        {
            return Ok(());
        }
        combat_state.last_slash_tick = server_tick;
        ctx.db.player_combat_state().identity().update(combat_state);
    } else {
        ctx.db.player_combat_state().insert(PlayerCombatState {
            identity,
            last_slash_tick: server_tick,
        });
    }

    trigger_player_animation(ctx, identity, "slash");
    set_player_action_state(
        ctx,
        slash_action_state(identity, server_tick, ctx.timestamp),
    );

    ctx.db.pending_slash_attack().insert(PendingSlashAttack {
        id: 0,
        attacker: identity,
        resolve_tick: server_tick + slash_impact_delay_ticks(),
    });

    Ok(())
}

#[spacetimedb::reducer]
pub fn trigger_block_animation(ctx: &ReducerContext) -> Result<(), String> {
    let identity = ctx.sender();
    if ctx.db.player().identity().find(identity).is_none() {
        return Err("Player has not joined".to_string());
    }

    let Some(player_character) = ctx.db.player_character().identity().find(identity) else {
        return Err("Player character row is missing".to_string());
    };
    if !class_capabilities(&player_character.character_class).block {
        return Err("This class cannot block".to_string());
    }

    let Some(player_health) = ctx.db.player_health().identity().find(identity) else {
        return Err("Player health row is missing".to_string());
    };
    if player_health.is_dead {
        return Ok(());
    }

    let server_tick = current_server_tick(ctx);
    if !refresh_player_action_state(ctx, identity, server_tick).can_block {
        return Ok(());
    }

    let block_until_tick = server_tick + block_window_ticks();
    trigger_player_animation(ctx, identity, "block");
    set_player_block_window(ctx, identity, true, block_until_tick);
    set_player_action_state(
        ctx,
        one_shot_block_action_state(identity, server_tick, block_until_tick, ctx.timestamp),
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn start_block(ctx: &ReducerContext) -> Result<(), String> {
    start_blocking(ctx)
}

#[spacetimedb::reducer]
pub fn stop_block(ctx: &ReducerContext) -> Result<(), String> {
    let identity = ctx.sender();
    if ctx.db.player().identity().find(identity).is_none() {
        return Err("Player has not joined".to_string());
    }

    let Some(player_character) = ctx.db.player_character().identity().find(identity) else {
        return Err("Player character row is missing".to_string());
    };
    if !class_capabilities(&player_character.character_class).block {
        return Err("This class cannot block".to_string());
    }

    let Some(player_health) = ctx.db.player_health().identity().find(identity) else {
        return Err("Player health row is missing".to_string());
    };
    if player_health.is_dead {
        return Ok(());
    }

    let server_tick = current_server_tick(ctx);
    let is_blocking = ctx
        .db
        .player_action_state()
        .identity()
        .find(identity)
        .map(|action_state| action_state.current_action == ACTION_BLOCKING)
        .unwrap_or(false);
    if !is_blocking {
        return Ok(());
    }

    clear_player_block_window(ctx, identity, server_tick);
    set_player_action_state(
        ctx,
        block_recovery_action_state(
            identity,
            server_tick,
            server_tick + block_recovery_ticks(),
            ctx.timestamp,
        ),
    );
    Ok(())
}

fn start_blocking(ctx: &ReducerContext) -> Result<(), String> {
    let identity = ctx.sender();
    if ctx.db.player().identity().find(identity).is_none() {
        return Err("Player has not joined".to_string());
    }

    let Some(player_character) = ctx.db.player_character().identity().find(identity) else {
        return Err("Player character row is missing".to_string());
    };
    if !class_capabilities(&player_character.character_class).block {
        return Err("This class cannot block".to_string());
    }

    let Some(player_health) = ctx.db.player_health().identity().find(identity) else {
        return Err("Player health row is missing".to_string());
    };
    if player_health.is_dead {
        return Ok(());
    }

    let server_tick = current_server_tick(ctx);
    if !refresh_player_action_state(ctx, identity, server_tick).can_block {
        return Ok(());
    }

    trigger_player_animation(ctx, identity, "block");
    set_player_block_window(ctx, identity, true, held_block_until_tick());
    set_player_action_state(
        ctx,
        held_block_action_state(identity, server_tick, ctx.timestamp),
    );
    Ok(())
}

#[spacetimedb::reducer]
pub fn trigger_lightning_strike(
    ctx: &ReducerContext,
    target_position: Vector3,
) -> Result<(), String> {
    let identity = ctx.sender();
    if ctx.db.player().identity().find(identity).is_none() {
        return Err("Player has not joined".to_string());
    }

    let Some(player_character) = ctx.db.player_character().identity().find(identity) else {
        return Err("Player character row is missing".to_string());
    };
    if !class_capabilities(&player_character.character_class).cast {
        return Err("This class cannot cast lightning strike".to_string());
    }

    let Some(caster_health) = ctx.db.player_health().identity().find(identity) else {
        return Err("Player health row is missing".to_string());
    };
    if caster_health.is_dead {
        return Ok(());
    }

    let server_tick = current_server_tick(ctx);
    if let Some(mut spell_state) = ctx.db.player_spell_state().identity().find(identity) {
        if spell_state.last_lightning_tick != 0
            && server_tick.saturating_sub(spell_state.last_lightning_tick)
                < LIGHTNING_COOLDOWN_TICKS
        {
            return Ok(());
        }
        spell_state.last_lightning_tick = server_tick;
        ctx.db.player_spell_state().identity().update(spell_state);
    } else {
        ctx.db.player_spell_state().insert(PlayerSpellState {
            identity,
            last_lightning_tick: server_tick,
            last_fireball_tick: 0,
        });
    }

    trigger_player_animation(ctx, identity, "cast");

    let Some(caster_transform) = ctx.db.player_transform().identity().find(identity) else {
        return Ok(());
    };
    let mut strike_position =
        clamped_lightning_target(&caster_transform.position, &target_position);
    strike_position.y = heightmap::terrain_height_at(&strike_position);

    ctx.db
        .pending_lightning_strike()
        .insert(PendingLightningStrike {
            id: 0,
            caster: identity,
            position: strike_position,
            resolve_tick: server_tick + lightning_impact_delay_ticks(),
        });

    Ok(())
}

#[spacetimedb::reducer]
pub fn trigger_fireball(ctx: &ReducerContext, target_position: Vector3) -> Result<(), String> {
    let identity = ctx.sender();
    if ctx.db.player().identity().find(identity).is_none() {
        return Err("Player has not joined".to_string());
    }

    let Some(player_character) = ctx.db.player_character().identity().find(identity) else {
        return Err("Player character row is missing".to_string());
    };
    if !class_capabilities(&player_character.character_class).cast {
        return Err("This class cannot cast fireball".to_string());
    }

    let Some(caster_health) = ctx.db.player_health().identity().find(identity) else {
        return Err("Player health row is missing".to_string());
    };
    if caster_health.is_dead {
        return Ok(());
    }

    let server_tick = current_server_tick(ctx);
    if let Some(mut spell_state) = ctx.db.player_spell_state().identity().find(identity) {
        if spell_state.last_fireball_tick != 0
            && server_tick.saturating_sub(spell_state.last_fireball_tick) < FIREBALL_COOLDOWN_TICKS
        {
            return Ok(());
        }
        spell_state.last_fireball_tick = server_tick;
        ctx.db.player_spell_state().identity().update(spell_state);
    } else {
        ctx.db.player_spell_state().insert(PlayerSpellState {
            identity,
            last_lightning_tick: 0,
            last_fireball_tick: server_tick,
        });
    }

    trigger_player_animation(ctx, identity, "cast");

    ctx.db.pending_fireball_cast().insert(PendingFireballCast {
        id: 0,
        caster: identity,
        target_position,
        resolve_tick: server_tick + fireball_release_delay_ticks(),
    });

    Ok(())
}

#[spacetimedb::reducer]
pub fn trigger_drinking_potion(ctx: &ReducerContext) -> Result<(), String> {
    let identity = ctx.sender();
    if ctx.db.player().identity().find(identity).is_none() {
        return Err("Player has not joined".to_string());
    }

    let Some(player_character) = ctx.db.player_character().identity().find(identity) else {
        return Err("Player character row is missing".to_string());
    };
    if !class_capabilities(&player_character.character_class).drink_potion {
        return Err("This class cannot drink potions".to_string());
    }

    let Some(player_health) = ctx.db.player_health().identity().find(identity) else {
        return Err("Player health row is missing".to_string());
    };
    if player_health.is_dead {
        return Ok(());
    }

    trigger_player_animation(ctx, identity, ANIMATION_DRINKING);
    Ok(())
}

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

#[spacetimedb::reducer(update)]
pub fn game_tick(ctx: &ReducerContext, _tick_info: GameTickSchedule) -> Result<(), String> {
    if ctx.sender() != ctx.identity() {
        return Err("Only the scheduler can run game_tick".to_string());
    }

    let server_tick = next_server_tick(ctx);
    respawn_ready_players(ctx, server_tick);
    refresh_active_player_action_states(ctx, server_tick);

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
            publish_input_ack_if_changed(
                ctx,
                player_input.identity,
                player_input.last_input_seq,
                player_input.last_processed_client_tick,
                server_tick,
            );
        }
    }

    resolve_pending_slash_attacks(ctx, server_tick);
    resolve_pending_lightning_strikes(ctx, server_tick);
    update_fireball_projectiles(ctx, server_tick);
    resolve_pending_fireball_casts(ctx, server_tick);
    cleanup_old_spell_events(ctx, server_tick);
    cleanup_old_combat_events(ctx, server_tick);

    Ok(())
}

/// Publish `player_input_ack` only when the owning client's reconcile watermark moved.
/// Pure-ack updates must not touch `player_transform` (row-level sync would fan out pose).
fn publish_input_ack_if_changed(
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

fn current_server_tick(ctx: &ReducerContext) -> u64 {
    ctx.db
        .tick_state()
        .version()
        .find(1)
        .map(|state| state.server_tick)
        .unwrap_or(0)
}

fn next_server_tick(ctx: &ReducerContext) -> u64 {
    if let Some(mut state) = ctx.db.tick_state().version().find(1) {
        state.server_tick += 1;
        let tick = state.server_tick;
        ctx.db.tick_state().version().update(state);
        tick
    } else {
        0
    }
}

fn normalize_rotation(rotation_y: f32) -> f32 {
    rotation_y.rem_euclid(2.0 * std::f32::consts::PI)
}

fn trigger_player_animation(ctx: &ReducerContext, identity: Identity, active_animation: &str) {
    if let Some(mut player_animation) = ctx.db.player_animation().identity().find(identity) {
        player_animation.active_animation = active_animation.to_string();
        player_animation.attack_seq = player_animation.attack_seq.saturating_add(1);
        player_animation.triggered_at = ctx.timestamp;
        ctx.db
            .player_animation()
            .identity()
            .update(player_animation);
    } else {
        ctx.db.player_animation().insert(PlayerAnimation {
            identity,
            active_animation: active_animation.to_string(),
            attack_seq: 1,
            triggered_at: ctx.timestamp,
        });
    }
}

fn default_player_action_state(
    identity: Identity,
    server_tick: u64,
    updated_at: Timestamp,
    is_dead: bool,
) -> PlayerActionState {
    if is_dead {
        dead_action_state(identity, server_tick, updated_at)
    } else {
        idle_action_state(identity, server_tick, updated_at)
    }
}

fn idle_action_state(
    identity: Identity,
    server_tick: u64,
    updated_at: Timestamp,
) -> PlayerActionState {
    PlayerActionState {
        identity,
        current_action: ACTION_IDLE.to_string(),
        action_started_tick: 0,
        action_active_tick: 0,
        action_recovery_until_tick: 0,
        action_ends_tick: 0,
        cooldown_ends_tick: 0,
        can_move: true,
        can_rotate: true,
        can_attack: true,
        can_block: true,
        feedback_policy: ACTION_FEEDBACK_SERVER_ACCEPTED.to_string(),
        server_tick,
        updated_at,
    }
}

fn slash_action_state(
    identity: Identity,
    server_tick: u64,
    updated_at: Timestamp,
) -> PlayerActionState {
    let impact_tick = server_tick + slash_impact_delay_ticks();
    let cooldown_ends_tick = server_tick + slash_cooldown_ticks();
    let action_ends_tick = impact_tick.max(cooldown_ends_tick);
    PlayerActionState {
        identity,
        current_action: ACTION_ATTACKING.to_string(),
        action_started_tick: server_tick,
        action_active_tick: impact_tick,
        action_recovery_until_tick: action_ends_tick,
        action_ends_tick,
        cooldown_ends_tick,
        can_move: true,
        can_rotate: true,
        can_attack: false,
        can_block: false,
        feedback_policy: ACTION_FEEDBACK_SERVER_ACCEPTED.to_string(),
        server_tick,
        updated_at,
    }
}

fn held_block_action_state(
    identity: Identity,
    server_tick: u64,
    updated_at: Timestamp,
) -> PlayerActionState {
    PlayerActionState {
        identity,
        current_action: ACTION_BLOCKING.to_string(),
        action_started_tick: server_tick,
        action_active_tick: server_tick,
        action_recovery_until_tick: 0,
        action_ends_tick: 0,
        cooldown_ends_tick: 0,
        can_move: true,
        can_rotate: true,
        can_attack: false,
        can_block: false,
        feedback_policy: ACTION_FEEDBACK_SERVER_ACCEPTED.to_string(),
        server_tick,
        updated_at,
    }
}

fn block_recovery_action_state(
    identity: Identity,
    server_tick: u64,
    recovery_until_tick: u64,
    updated_at: Timestamp,
) -> PlayerActionState {
    PlayerActionState {
        identity,
        current_action: ACTION_IDLE.to_string(),
        action_started_tick: server_tick,
        action_active_tick: server_tick,
        action_recovery_until_tick: recovery_until_tick,
        action_ends_tick: recovery_until_tick,
        cooldown_ends_tick: recovery_until_tick,
        can_move: true,
        can_rotate: true,
        can_attack: false,
        can_block: false,
        feedback_policy: ACTION_FEEDBACK_SERVER_ACCEPTED.to_string(),
        server_tick,
        updated_at,
    }
}

fn one_shot_block_action_state(
    identity: Identity,
    server_tick: u64,
    block_until_tick: u64,
    updated_at: Timestamp,
) -> PlayerActionState {
    PlayerActionState {
        identity,
        current_action: ACTION_BLOCKING.to_string(),
        action_started_tick: server_tick,
        action_active_tick: server_tick,
        action_recovery_until_tick: block_until_tick,
        action_ends_tick: block_until_tick,
        cooldown_ends_tick: block_until_tick,
        can_move: true,
        can_rotate: true,
        can_attack: false,
        can_block: false,
        feedback_policy: ACTION_FEEDBACK_SERVER_ACCEPTED.to_string(),
        server_tick,
        updated_at,
    }
}

fn dead_action_state(
    identity: Identity,
    server_tick: u64,
    updated_at: Timestamp,
) -> PlayerActionState {
    PlayerActionState {
        identity,
        current_action: ACTION_DEAD.to_string(),
        action_started_tick: server_tick,
        action_active_tick: server_tick,
        action_recovery_until_tick: 0,
        action_ends_tick: 0,
        cooldown_ends_tick: 0,
        can_move: false,
        can_rotate: false,
        can_attack: false,
        can_block: false,
        feedback_policy: ACTION_FEEDBACK_SERVER_ACCEPTED.to_string(),
        server_tick,
        updated_at,
    }
}

fn set_player_action_state(ctx: &ReducerContext, action_state: PlayerActionState) {
    if ctx
        .db
        .player_action_state()
        .identity()
        .find(action_state.identity)
        .is_some()
    {
        ctx.db.player_action_state().identity().update(action_state);
    } else {
        ctx.db.player_action_state().insert(action_state);
    }
}

fn refresh_player_action_state(
    ctx: &ReducerContext,
    identity: Identity,
    server_tick: u64,
) -> PlayerActionState {
    let Some(action_state) = ctx.db.player_action_state().identity().find(identity) else {
        let action_state = idle_action_state(identity, server_tick, ctx.timestamp);
        ctx.db.player_action_state().insert(idle_action_state(
            identity,
            server_tick,
            ctx.timestamp,
        ));
        return action_state;
    };

    refresh_action_state(ctx, action_state, server_tick)
}

fn refresh_action_state(
    ctx: &ReducerContext,
    action_state: PlayerActionState,
    server_tick: u64,
) -> PlayerActionState {
    if action_state.current_action == ACTION_DEAD {
        return action_state;
    }

    if action_state.action_ends_tick == 0 || action_state.action_ends_tick > server_tick {
        return action_state;
    }

    let mut refreshed = idle_action_state(action_state.identity, server_tick, ctx.timestamp);
    refreshed.cooldown_ends_tick = action_state.cooldown_ends_tick;
    refreshed.can_attack = action_state.cooldown_ends_tick <= server_tick;
    refreshed.can_block = action_state.cooldown_ends_tick <= server_tick;
    ctx.db
        .player_action_state()
        .identity()
        .update(refreshed.clone());
    refreshed
}

fn refresh_active_player_action_states(ctx: &ReducerContext, server_tick: u64) {
    let expired_action_states: Vec<PlayerActionState> = ctx
        .db
        .player_action_state()
        .action_ends_tick()
        .filter(1u64..=server_tick)
        .collect();
    for action_state in expired_action_states {
        refresh_action_state(ctx, action_state, server_tick);
    }
}

fn set_player_block_window(
    ctx: &ReducerContext,
    identity: Identity,
    is_blocking: bool,
    block_until_tick: u64,
) {
    if let Some(mut block_state) = ctx.db.player_block_state().identity().find(identity) {
        block_state.is_blocking = is_blocking;
        block_state.block_until_tick = block_until_tick;
        ctx.db.player_block_state().identity().update(block_state);
    } else {
        ctx.db.player_block_state().insert(PlayerBlockState {
            identity,
            is_blocking,
            block_until_tick,
        });
    }
}

fn clear_player_block_window(ctx: &ReducerContext, identity: Identity, server_tick: u64) {
    if let Some(mut block_state) = ctx.db.player_block_state().identity().find(identity) {
        block_state.is_blocking = false;
        block_state.block_until_tick = server_tick;
        ctx.db.player_block_state().identity().update(block_state);
    }
}

fn slash_impact_delay_ticks() -> u64 {
    (TICK_RATE * SLASH_IMPACT_DELAY_SECONDS).round() as u64
}

fn slash_cooldown_ticks() -> u64 {
    (TICK_RATE * SLASH_COOLDOWN_SECONDS).round() as u64
}

fn block_window_ticks() -> u64 {
    (TICK_RATE * BLOCK_WINDOW_SECONDS).round() as u64
}

fn lightning_impact_delay_ticks() -> u64 {
    (TICK_RATE * LIGHTNING_IMPACT_DELAY_SECONDS).round() as u64
}

fn fireball_release_delay_ticks() -> u64 {
    (TICK_RATE * FIREBALL_RELEASE_DELAY_SECONDS).round() as u64
}

fn held_block_until_tick() -> u64 {
    u64::MAX
}

fn block_recovery_ticks() -> u64 {
    (TICK_RATE * BLOCK_RECOVERY_SECONDS).round() as u64
}

fn clamped_lightning_target(caster_position: &Vector3, requested_position: &Vector3) -> Vector3 {
    let mut dx = requested_position.x - caster_position.x;
    let mut dz = requested_position.z - caster_position.z;

    if !dx.is_finite() || !dz.is_finite() {
        dx = 0.0;
        dz = 0.0;
    }

    let distance_sq = dx * dx + dz * dz;
    if distance_sq > LIGHTNING_TARGET_DISTANCE * LIGHTNING_TARGET_DISTANCE {
        let distance = distance_sq.sqrt().max(0.001);
        let scale = LIGHTNING_TARGET_DISTANCE / distance;
        dx *= scale;
        dz *= scale;
    }

    Vector3 {
        x: caster_position.x + dx,
        y: caster_position.y,
        z: caster_position.z + dz,
    }
}

fn fireball_forward_direction(rotation_y: f32) -> Vector3 {
    let rotation_y = if rotation_y.is_finite() { rotation_y } else { 0.0 };
    Vector3 {
        x: -rotation_y.sin(),
        y: 0.0,
        z: -rotation_y.cos(),
    }
}

fn fireball_direction(caster_transform: &PlayerTransform) -> Vector3 {
    fireball_forward_direction(caster_transform.rotation_y)
}

fn fireball_spawn_position(caster_transform: &PlayerTransform, forward: &Vector3) -> Vector3 {
    let right = Vector3 {
        x: -forward.z,
        y: 0.0,
        z: forward.x,
    };
    let mut position = Vector3 {
        x: caster_transform.position.x
            + forward.x * FIREBALL_SPAWN_FORWARD_OFFSET
            + right.x * FIREBALL_SPAWN_RIGHT_OFFSET,
        y: caster_transform.position.y,
        z: caster_transform.position.z
            + forward.z * FIREBALL_SPAWN_FORWARD_OFFSET
            + right.z * FIREBALL_SPAWN_RIGHT_OFFSET,
    };
    position.y = heightmap::terrain_height_at(&position) + FIREBALL_SPAWN_HEIGHT;
    position
}

fn fireball_direction_from_spawn(
    caster_position: &Vector3,
    spawn_position: &Vector3,
    forward: &Vector3,
) -> Vector3 {
    let target = Vector3 {
        x: caster_position.x + forward.x * FIREBALL_TARGET_DISTANCE,
        y: caster_position.y,
        z: caster_position.z + forward.z * FIREBALL_TARGET_DISTANCE,
    };
    let dx = target.x - spawn_position.x;
    let dz = target.z - spawn_position.z;
    let length = (dx * dx + dz * dz).sqrt();
    if length <= 0.0001 {
        return forward.clone();
    }

    Vector3 {
        x: dx / length,
        y: 0.0,
        z: dz / length,
    }
}

fn resolve_pending_slash_attacks(ctx: &ReducerContext, server_tick: u64) {
    let pending_slashes: Vec<PendingSlashAttack> = ctx.db.pending_slash_attack().iter().collect();
    for pending_slash in pending_slashes {
        if pending_slash.resolve_tick > server_tick {
            continue;
        }

        ctx.db.pending_slash_attack().id().delete(&pending_slash.id);

        if ctx
            .db
            .player_health()
            .identity()
            .find(pending_slash.attacker)
            .map(|health| health.is_dead)
            .unwrap_or(true)
        {
            continue;
        }

        apply_slash_damage(ctx, pending_slash.attacker, server_tick);
    }
}

fn resolve_pending_lightning_strikes(ctx: &ReducerContext, server_tick: u64) {
    let pending_lightning_strikes: Vec<PendingLightningStrike> =
        ctx.db.pending_lightning_strike().iter().collect();
    for pending_lightning_strike in pending_lightning_strikes {
        if pending_lightning_strike.resolve_tick > server_tick {
            continue;
        }

        ctx.db
            .pending_lightning_strike()
            .id()
            .delete(&pending_lightning_strike.id);

        if ctx
            .db
            .player_health()
            .identity()
            .find(pending_lightning_strike.caster)
            .map(|health| health.is_dead)
            .unwrap_or(true)
        {
            continue;
        }

        ctx.db.spell_event().insert(SpellEvent {
            id: 0,
            caster: pending_lightning_strike.caster,
            spell_type: "lightning_strike".to_string(),
            position: pending_lightning_strike.position.clone(),
            server_tick,
            created_at: ctx.timestamp,
        });

        apply_lightning_damage(
            ctx,
            pending_lightning_strike.caster,
            &pending_lightning_strike.position,
            server_tick,
        );
    }
}

fn resolve_pending_fireball_casts(ctx: &ReducerContext, server_tick: u64) {
    let pending_fireball_casts: Vec<PendingFireballCast> = ctx
        .db
        .pending_fireball_cast()
        .resolve_tick()
        .filter(..=server_tick)
        .collect();

    for pending_fireball_cast in pending_fireball_casts {
        ctx.db
            .pending_fireball_cast()
            .id()
            .delete(&pending_fireball_cast.id);

        if ctx
            .db
            .player_health()
            .identity()
            .find(pending_fireball_cast.caster)
            .map(|health| health.is_dead)
            .unwrap_or(true)
        {
            continue;
        }

        spawn_fireball_projectile(
            ctx,
            pending_fireball_cast.caster,
            server_tick,
        );
    }
}

fn spawn_fireball_projectile(
    ctx: &ReducerContext,
    caster: Identity,
    server_tick: u64,
) {
    let Some(caster_transform) = ctx.db.player_transform().identity().find(caster) else {
        return;
    };

    let forward = fireball_direction(&caster_transform);
    let position = fireball_spawn_position(&caster_transform, &forward);
    let direction = fireball_direction_from_spawn(&caster_transform.position, &position, &forward);

    ctx.db.fireball_projectile().insert(FireballProjectile {
        id: 0,
        caster,
        previous_position: position.clone(),
        position,
        direction,
        spawned_at_tick: server_tick,
        max_distance: FIREBALL_TARGET_DISTANCE,
        distance_traveled: 0.0,
        created_at: ctx.timestamp,
    });
}

fn update_fireball_projectiles(ctx: &ReducerContext, server_tick: u64) {
    let projectiles: Vec<FireballProjectile> = ctx.db.fireball_projectile().iter().collect();
    let step_distance = FIREBALL_SPEED / TICK_RATE;

    for mut projectile in projectiles {
        if ctx
            .db
            .player_health()
            .identity()
            .find(projectile.caster)
            .map(|health| health.is_dead)
            .unwrap_or(true)
        {
            ctx.db.fireball_projectile().id().delete(&projectile.id);
            continue;
        }

        projectile.previous_position = projectile.position.clone();
        projectile.position.x += projectile.direction.x * step_distance;
        projectile.position.z += projectile.direction.z * step_distance;
        projectile.position.y =
            heightmap::terrain_height_at(&projectile.position) + FIREBALL_SPAWN_HEIGHT;
        projectile.distance_traveled += step_distance;

        if let Some(target) = first_fireball_hit_target(ctx, &projectile) {
            ctx.db.fireball_projectile().id().delete(&projectile.id);
            ctx.db.spell_event().insert(SpellEvent {
                id: 0,
                caster: projectile.caster,
                spell_type: "fireball_impact".to_string(),
                position: projectile.position.clone(),
                server_tick,
                created_at: ctx.timestamp,
            });
            apply_fireball_damage(ctx, projectile.caster, target, server_tick);
            continue;
        }

        if projectile.distance_traveled >= projectile.max_distance {
            ctx.db.fireball_projectile().id().delete(&projectile.id);
            ctx.db.spell_event().insert(SpellEvent {
                id: 0,
                caster: projectile.caster,
                spell_type: "fireball_impact".to_string(),
                position: projectile.position.clone(),
                server_tick,
                created_at: ctx.timestamp,
            });
            continue;
        }

        ctx.db.fireball_projectile().id().update(projectile);
    }
}

fn cleanup_old_spell_events(ctx: &ReducerContext, server_tick: u64) {
    if server_tick > TRANSIENT_EVENT_RETENTION_TICKS {
        ctx.db
            .spell_event()
            .server_tick()
            .delete(..server_tick - TRANSIENT_EVENT_RETENTION_TICKS);
    }
}

fn cleanup_old_combat_events(ctx: &ReducerContext, server_tick: u64) {
    if server_tick > TRANSIENT_EVENT_RETENTION_TICKS {
        ctx.db
            .combat_event()
            .server_tick()
            .delete(..server_tick - TRANSIENT_EVENT_RETENTION_TICKS);
    }
}

fn first_fireball_hit_target(
    ctx: &ReducerContext,
    projectile: &FireballProjectile,
) -> Option<Identity> {
    let targets: Vec<PlayerHealth> = ctx.db.player_health().iter().collect();
    for target_health in targets {
        if target_health.identity == projectile.caster || target_health.is_dead {
            continue;
        }

        let Some(target_transform) = ctx
            .db
            .player_transform()
            .identity()
            .find(target_health.identity)
        else {
            continue;
        };

        if distance_sq_to_segment_2d(
            &target_transform.position,
            &projectile.previous_position,
            &projectile.position,
        ) <= FIREBALL_RADIUS * FIREBALL_RADIUS
        {
            return Some(target_health.identity);
        }
    }

    None
}

fn apply_fireball_damage(
    ctx: &ReducerContext,
    caster: Identity,
    target: Identity,
    server_tick: u64,
) {
    let Some(mut target_health) = ctx.db.player_health().identity().find(target) else {
        return;
    };
    if target_health.is_dead {
        return;
    }

    let damage = spell_damage_for_target(ctx, target_health.identity, server_tick, FIREBALL_DAMAGE);
    target_health.current_health = target_health.current_health.saturating_sub(damage);
    target_health.updated_at = ctx.timestamp;
    ctx.db.combat_event().insert(CombatEvent {
        id: 0,
        attacker: caster,
        target: target_health.identity,
        event_type: "fireball_hit".to_string(),
        amount: damage,
        server_tick,
        created_at: ctx.timestamp,
    });

    if target_health.current_health == 0 {
        target_health.is_dead = true;
        target_health.respawn_tick = server_tick + RESPAWN_DELAY_TICKS;
        clear_player_block_window(ctx, target_health.identity, server_tick);
        set_player_action_state(
            ctx,
            dead_action_state(target_health.identity, server_tick, ctx.timestamp),
        );
        ctx.db.combat_event().insert(CombatEvent {
            id: 0,
            attacker: caster,
            target: target_health.identity,
            event_type: "death".to_string(),
            amount: 0,
            server_tick,
            created_at: ctx.timestamp,
        });
    }

    ctx.db.player_health().identity().update(target_health);
}

fn apply_lightning_damage(
    ctx: &ReducerContext,
    caster: Identity,
    strike_position: &Vector3,
    server_tick: u64,
) {
    let targets: Vec<PlayerHealth> = ctx.db.player_health().iter().collect();
    for mut target_health in targets {
        if target_health.identity == caster || target_health.is_dead {
            continue;
        }

        let Some(target_transform) = ctx
            .db
            .player_transform()
            .identity()
            .find(target_health.identity)
        else {
            continue;
        };

        if !is_target_in_lightning_radius(strike_position, &target_transform.position) {
            continue;
        }

        let damage =
            spell_damage_for_target(ctx, target_health.identity, server_tick, LIGHTNING_DAMAGE);
        target_health.current_health = target_health.current_health.saturating_sub(damage);
        target_health.updated_at = ctx.timestamp;
        ctx.db.combat_event().insert(CombatEvent {
            id: 0,
            attacker: caster,
            target: target_health.identity,
            event_type: "lightning_hit".to_string(),
            amount: damage,
            server_tick,
            created_at: ctx.timestamp,
        });

        if target_health.current_health == 0 {
            target_health.is_dead = true;
            target_health.respawn_tick = server_tick + RESPAWN_DELAY_TICKS;
            clear_player_block_window(ctx, target_health.identity, server_tick);
            set_player_action_state(
                ctx,
                dead_action_state(target_health.identity, server_tick, ctx.timestamp),
            );
            ctx.db.combat_event().insert(CombatEvent {
                id: 0,
                attacker: caster,
                target: target_health.identity,
                event_type: "death".to_string(),
                amount: 0,
                server_tick,
                created_at: ctx.timestamp,
            });
        }

        ctx.db.player_health().identity().update(target_health);
    }
}

fn apply_slash_damage(ctx: &ReducerContext, attacker: Identity, server_tick: u64) {
    let Some(attacker_transform) = ctx.db.player_transform().identity().find(attacker) else {
        return;
    };

    let forward = Vector3 {
        x: -attacker_transform.rotation_y.sin(),
        y: 0.0,
        z: -attacker_transform.rotation_y.cos(),
    };

    let mut hit_count = 0;
    let targets: Vec<PlayerHealth> = ctx.db.player_health().iter().collect();
    for mut target_health in targets {
        if target_health.identity == attacker || target_health.is_dead {
            continue;
        }

        let Some(target_transform) = ctx
            .db
            .player_transform()
            .identity()
            .find(target_health.identity)
        else {
            continue;
        };

        if !is_target_in_slash_arc(
            &attacker_transform.position,
            &target_transform.position,
            &forward,
        ) {
            continue;
        }

        let blocked = is_player_blocking(ctx, target_health.identity, server_tick);
        let damage = if blocked {
            BLOCKED_SLASH_DAMAGE
        } else {
            SLASH_DAMAGE
        };
        target_health.current_health = target_health.current_health.saturating_sub(damage);
        target_health.updated_at = ctx.timestamp;
        hit_count += 1;
        ctx.db.combat_event().insert(CombatEvent {
            id: 0,
            attacker,
            target: target_health.identity,
            event_type: if blocked { "slash_blocked" } else { "slash_hit" }.to_string(),
            amount: damage,
            server_tick,
            created_at: ctx.timestamp,
        });

        if target_health.current_health == 0 {
            target_health.is_dead = true;
            target_health.respawn_tick = server_tick + RESPAWN_DELAY_TICKS;
            clear_player_block_window(ctx, target_health.identity, server_tick);
            set_player_action_state(
                ctx,
                dead_action_state(target_health.identity, server_tick, ctx.timestamp),
            );
            ctx.db.combat_event().insert(CombatEvent {
                id: 0,
                attacker,
                target: target_health.identity,
                event_type: "death".to_string(),
                amount: 0,
                server_tick,
                created_at: ctx.timestamp,
            });
        }

        ctx.db.player_health().identity().update(target_health);
    }

    if hit_count == 0 {
        ctx.db.combat_event().insert(CombatEvent {
            id: 0,
            attacker,
            target: attacker,
            event_type: "slash_miss".to_string(),
            amount: 0,
            server_tick,
            created_at: ctx.timestamp,
        });
    }
}

fn spell_damage_for_target(
    ctx: &ReducerContext,
    target: Identity,
    server_tick: u64,
    base_damage: u32,
) -> u32 {
    if is_player_blocking(ctx, target, server_tick) {
        if base_damage == LIGHTNING_DAMAGE {
            BLOCKED_LIGHTNING_DAMAGE
        } else if base_damage == FIREBALL_DAMAGE {
            BLOCKED_FIREBALL_DAMAGE
        } else {
            BLOCKED_SLASH_DAMAGE
        }
    } else {
        base_damage
    }
}

fn is_player_blocking(ctx: &ReducerContext, target: Identity, server_tick: u64) -> bool {
    ctx.db
        .player_block_state()
        .identity()
        .find(target)
        .map(|block_state| block_state.is_blocking && block_state.block_until_tick >= server_tick)
        .unwrap_or(false)
}

fn is_target_in_lightning_radius(strike_position: &Vector3, target_position: &Vector3) -> bool {
    let dx = target_position.x - strike_position.x;
    let dz = target_position.z - strike_position.z;
    dx * dx + dz * dz <= LIGHTNING_RADIUS * LIGHTNING_RADIUS
}

fn distance_sq_to_segment_2d(point: &Vector3, start: &Vector3, end: &Vector3) -> f32 {
    let segment_x = end.x - start.x;
    let segment_z = end.z - start.z;
    let length_sq = segment_x * segment_x + segment_z * segment_z;
    if length_sq <= 0.0001 {
        let dx = point.x - start.x;
        let dz = point.z - start.z;
        return dx * dx + dz * dz;
    }

    let t = (((point.x - start.x) * segment_x + (point.z - start.z) * segment_z) / length_sq)
        .clamp(0.0, 1.0);
    let closest_x = start.x + segment_x * t;
    let closest_z = start.z + segment_z * t;
    let dx = point.x - closest_x;
    let dz = point.z - closest_z;
    dx * dx + dz * dz
}

fn is_target_in_slash_arc(
    attacker_position: &Vector3,
    target_position: &Vector3,
    forward: &Vector3,
) -> bool {
    let to_target = Vector3 {
        x: target_position.x - attacker_position.x,
        y: 0.0,
        z: target_position.z - attacker_position.z,
    };
    let distance_sq = to_target.x * to_target.x + to_target.z * to_target.z;
    if distance_sq > SLASH_RANGE * SLASH_RANGE {
        return false;
    }
    if distance_sq <= 0.0001 {
        return true;
    }

    let distance = distance_sq.sqrt();
    let direction = Vector3 {
        x: to_target.x / distance,
        y: 0.0,
        z: to_target.z / distance,
    };
    direction.x * forward.x + direction.z * forward.z >= SLASH_ARC_COSINE
}

fn respawn_ready_players(ctx: &ReducerContext, server_tick: u64) {
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
        clear_player_block_window(ctx, identity, server_tick);
        set_player_action_state(ctx, idle_action_state(identity, server_tick, ctx.timestamp));

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

        ctx.db.combat_event().insert(CombatEvent {
            id: 0,
            attacker: identity,
            target: identity,
            event_type: "respawn".to_string(),
            amount: 0,
            server_tick,
            created_at: ctx.timestamp,
        });
    }
}

fn spawn_position() -> Vector3 {
    let mut position = Vector3::zero();
    position.y = heightmap::terrain_height_at(&position);
    position
}

fn idle_movement_state_for_position(position: &Vector3) -> MovementState {
    let ground_y = heightmap::terrain_height_at(position);
    let is_grounded = position.y <= ground_y + GROUNDED_EPSILON;
    MovementState::new(is_grounded, is_grounded, false, false)
}

#[cfg(test)]
mod tests {
    use super::{
        class_capabilities, fireball_direction_from_spawn, fireball_forward_direction,
        normalize_character_class, Vector3,
    };
    use std::f32::consts::FRAC_PI_2;

    #[test]
    fn normalize_remaps_legacy_paladin_classes() {
        assert_eq!(normalize_character_class("paladin".to_string()).unwrap(), "paladin");
        assert_eq!(normalize_character_class("pally".to_string()).unwrap(), "paladin");
        assert_eq!(normalize_character_class("  PALADIN ".to_string()).unwrap(), "paladin");
    }

    #[test]
    fn normalize_remaps_legacy_wizard_classes() {
        assert_eq!(normalize_character_class("wizard".to_string()).unwrap(), "wizard");
        assert_eq!(normalize_character_class("wizard2".to_string()).unwrap(), "wizard");
        assert_eq!(normalize_character_class("Wizard2".to_string()).unwrap(), "wizard");
    }

    #[test]
    fn normalize_rejects_unknown_classes() {
        assert!(normalize_character_class("knight".to_string()).is_err());
        assert!(normalize_character_class(String::new()).is_err());
    }

    #[test]
    fn capabilities_per_class() {
        let paladin = class_capabilities("paladin");
        assert!(paladin.melee);
        assert!(paladin.block);
        assert!(!paladin.cast);

        let wizard = class_capabilities("wizard");
        assert!(!wizard.melee);
        assert!(!wizard.block);
        assert!(wizard.cast);
    }

    #[test]
    fn both_classes_can_drink_potions() {
        assert!(class_capabilities("paladin").drink_potion);
        assert!(class_capabilities("wizard").drink_potion);
    }

    #[test]
    fn slash_rejected_for_wizard() {
        assert!(!class_capabilities("wizard").melee);
    }

    #[test]
    fn spells_rejected_for_paladin() {
        assert!(!class_capabilities("paladin").cast);
    }

    #[test]
    fn capabilities_resolve_legacy_stored_classes() {
        assert!(class_capabilities("paladin").melee);
        assert!(class_capabilities("wizard2").cast);
    }

    #[test]
    fn fireball_direction_comes_from_release_yaw() {
        let forward = fireball_forward_direction(0.0);
        assert!(forward.x.abs() < 0.0001);
        assert!((forward.z + 1.0).abs() < 0.0001);

        let left = fireball_forward_direction(FRAC_PI_2);
        assert!((left.x + 1.0).abs() < 0.0001);
        assert!(left.z.abs() < 0.0001);
    }

    #[test]
    fn fireball_direction_converges_from_hand_spawn_to_center_aim_line() {
        let caster_position = Vector3 {
            x: 10.0,
            y: 0.0,
            z: 5.0,
        };
        let spawn = Vector3 {
            x: 10.42,
            y: 1.45,
            z: 3.8,
        };
        let forward = fireball_forward_direction(0.0);
        let direction = fireball_direction_from_spawn(&caster_position, &spawn, &forward);

        assert!(direction.x < 0.0);
        assert!(direction.z < -0.99);
    }

    #[test]
    fn fireball_direction_falls_back_for_invalid_yaw() {
        let direction = fireball_forward_direction(f32::NAN);

        assert!(direction.x.abs() < 0.0001);
        assert!((direction.z + 1.0).abs() < 0.0001);
    }
}
