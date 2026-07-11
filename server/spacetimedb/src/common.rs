use spacetimedb::SpacetimeType;

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct Vector3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vector3 {
    pub fn zero() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            z: 0.0,
        }
    }
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct InputState {
    pub forward: bool,
    pub backward: bool,
    pub left: bool,
    pub right: bool,
    pub sprint: bool,
    pub jump: bool,
    pub sequence: u32,
    pub client_tick: u32,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub struct MovementState {
    pub is_grounded: bool,
    pub was_grounded: bool,
    pub is_airborne: bool,
    pub sprint_intent: bool,
    pub sprint_active: bool,
}

impl MovementState {
    pub fn new(
        is_grounded: bool,
        was_grounded: bool,
        sprint_intent: bool,
        sprint_active: bool,
    ) -> Self {
        Self {
            is_grounded,
            was_grounded,
            is_airborne: !is_grounded,
            sprint_intent,
            sprint_active,
        }
    }

    pub fn grounded() -> Self {
        Self::new(true, true, false, false)
    }
}

pub const PLAYER_SPEED: f32 = 6.0;
pub const SPRINT_MULTIPLIER: f32 = 1.8;
// Tuned for roughly a 1.8m apex and 0.7s total airtime on flat ground.
pub const GRAVITY: f32 = -28.8;
pub const JUMP_FORCE: f32 = 10.2;
pub const GROUND_Y: f32 = 0.0;
pub const GROUNDED_EPSILON: f32 = 0.01;
pub const TICK_RATE: f32 = 20.0;
pub const DELTA_TIME: f32 = 1.0 / TICK_RATE;

pub fn default_input() -> InputState {
    InputState {
        forward: false,
        backward: false,
        left: false,
        right: false,
        sprint: false,
        jump: false,
        sequence: 0,
        client_tick: 0,
    }
}
