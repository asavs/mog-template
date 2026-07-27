use crate::common::{InputState, MovementState, Vector3};
// Bring game_tick into scope for the scheduled(...) attribute on GameTickSchedule.
#[allow(unused_imports)]
use crate::tick::game_tick;
use spacetimedb::{ConnectionId, Identity, ScheduleAt, Timestamp};

pub const PLAYER_MAX_HEALTH: u32 = 100;

#[spacetimedb::table(accessor = player, public)]
pub struct PlayerData {
    #[primary_key]
    pub identity: Identity,
    pub username: String,
    pub connected: bool,
    pub joined_at: Timestamp,
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
    /// Wall-clock microseconds of the previous game_tick invocation (ctx.timestamp),
    /// 0 when no tick has run yet; private companion for tick_stats, kept on this row
    /// because it is already written every tick so tick health costs no extra row write.
    #[default(0i64)]
    pub last_tick_at_us: i64,
}

/// Public singleton (id = 0) exposing measured game_tick health: invocation-to-invocation
/// interval, EWMA, and a short sliding window of max/late so ops and clients can see
/// server cadence without scraping logs.
#[spacetimedb::table(accessor = tick_stats, public)]
pub struct TickStats {
    #[primary_key]
    pub id: u32,
    pub server_tick: u64,
    pub last_interval_us: u64,
    pub interval_ewma_us: u64,
    pub max_interval_us_window: u64,
    pub late_ticks_window: u32,
    pub window_started_tick: u64,
}

#[spacetimedb::table(accessor = game_tick_schedule, public, scheduled(game_tick))]
pub struct GameTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

#[spacetimedb::table(accessor = player_action_state, public)]
#[derive(Clone)]
pub struct PlayerActionState {
    #[primary_key]
    pub identity: Identity,
    /// "" means idle / no action.
    pub action_id: String,
    /// 0 Idle, 1 Charging, 2 Windup, 3 Active, 4 Held, 5 Recovery
    pub phase: u8,
    pub phase_started_tick: u64,
    /// 0 = indefinite (e.g. sustain Held).
    #[index(btree)]
    pub phase_ends_tick: u64,
    pub charge_ticks: u64,
    pub server_tick: u64,
}

#[spacetimedb::table(accessor = player_cooldown, public)]
pub struct PlayerCooldown {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub identity: Identity,
    pub action_id: String,
    pub ready_tick: u64,
}

#[spacetimedb::table(accessor = player_resource, public)]
pub struct PlayerResource {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub identity: Identity,
    pub kind: String,
    pub amount: u32,
}

#[spacetimedb::table(accessor = action_event, public)]
pub struct ActionEvent {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub actor: Identity,
    pub target: Option<Identity>,
    pub action_id: String,
    /// "hit" / "blocked" / "miss" / "heal" / "release"
    pub kind: String,
    pub amount: i32,
    pub position: Option<Vector3>,
    #[index(btree)]
    pub server_tick: u64,
}

#[spacetimedb::table(accessor = projectile, public)]
pub struct Projectile {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub owner: Identity,
    pub action_id: String,
    pub position: Vector3,
    pub previous_position: Vector3,
    pub direction: Vector3,
    pub spawned_at_tick: u64,
    pub distance_traveled: f32,
    pub max_distance: f32,
}

#[spacetimedb::table(accessor = player_slot_binding, public)]
pub struct PlayerSlotBinding {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub identity: Identity,
    pub slot: String,
    pub tap_action: Option<String>,
    pub hold_action: Option<String>,
    pub hold_threshold_ticks: u32,
}
