use crate::common::{
    GRAVITY, GROUNDED_EPSILON, InputState, JUMP_FORCE, MovementState, PLAYER_SPEED,
    SPRINT_MULTIPLIER, Vector3,
};
use crate::PlayerJumpState;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocomotionPhase {
    GroundedIdle,
    GroundedWalk,
    GroundedSprint,
    AirborneJump,
    AirborneFall,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vec2 {
    pub x: f32,
    pub z: f32,
}

impl Vec2 {
    pub fn zero() -> Self {
        Self { x: 0.0, z: 0.0 }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LocomotionState {
    pub phase: LocomotionPhase,
    pub horizontal_velocity: Vec2,
    pub vertical_velocity: f32,
    pub sprint_active: bool,
    pub was_jump_pressed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LocomotionConfig {
    pub walk_speed: f32,
    pub sprint_multiplier: f32,
    pub gravity: f32,
    pub jump_force: f32,
    pub ground_acceleration: f32,
    pub ground_friction: f32,
    pub air_acceleration: f32,
    pub air_friction: f32,
    pub instant_horizontal_velocity: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LocomotionContext {
    pub is_grounded: bool,
    pub was_grounded: bool,
    pub rotation_y: f32,
    pub delta_seconds: f32,
}

pub const DEFAULT_LOCOMOTION_CONFIG: LocomotionConfig = LocomotionConfig {
    walk_speed: PLAYER_SPEED,
    sprint_multiplier: SPRINT_MULTIPLIER,
    gravity: GRAVITY,
    jump_force: JUMP_FORCE,
    ground_acceleration: 1_000_000.0,
    ground_friction: 1_000_000.0,
    air_acceleration: 1_000_000.0,
    air_friction: 1_000_000.0,
    instant_horizontal_velocity: true,
};

pub fn is_moving_input(input: &InputState) -> bool {
    input.forward || input.backward || input.left || input.right
}

pub fn sprint_active_for_locomotion(
    is_grounded: bool,
    input: &InputState,
    previous_sprint_active: bool,
) -> bool {
    if is_grounded {
        is_moving_input(input) && input.sprint
    } else {
        previous_sprint_active
    }
}

// Row -> state bridge (mirrors client `locomotionStateFromMovementState`); not yet
// called by reducers in phase 1, kept for the upcoming reducer integration.
#[allow(dead_code)]
pub fn locomotion_state_from_rows(
    movement_state: &MovementState,
    jump_state: &PlayerJumpState,
    input: &InputState,
    rotation_y: f32,
) -> LocomotionState {
    let sprint_active = movement_state.sprint_active;
    let horizontal_velocity =
        desired_horizontal_velocity(input, rotation_y, sprint_active, &DEFAULT_LOCOMOTION_CONFIG);
    let phase = phase_for(
        movement_state.is_grounded,
        jump_state.vertical_velocity,
        is_moving_input(input),
        sprint_active,
    );

    LocomotionState {
        phase,
        horizontal_velocity,
        vertical_velocity: jump_state.vertical_velocity,
        sprint_active,
        was_jump_pressed: jump_state.was_jump_pressed,
    }
}

pub fn transition_locomotion(
    state: &LocomotionState,
    input: &InputState,
    context: LocomotionContext,
    config: &LocomotionConfig,
) -> LocomotionState {
    let moving = is_moving_input(input);
    let sprint_active =
        sprint_active_for_locomotion(context.is_grounded, input, state.sprint_active);
    let target_horizontal_velocity =
        desired_horizontal_velocity(input, context.rotation_y, sprint_active, config);
    let horizontal_velocity = advance_horizontal_velocity(
        state.horizontal_velocity,
        target_horizontal_velocity,
        context.is_grounded,
        moving,
        context.delta_seconds,
        config,
    );

    let mut vertical_velocity = state.vertical_velocity + config.gravity * context.delta_seconds;
    let started_jump = input.jump && !state.was_jump_pressed && context.is_grounded;
    if started_jump {
        vertical_velocity = config.jump_force;
    }

    let phase = if context.is_grounded && !started_jump {
        grounded_phase(moving, sprint_active)
    } else if started_jump || vertical_velocity > 0.0 {
        LocomotionPhase::AirborneJump
    } else {
        LocomotionPhase::AirborneFall
    };

    LocomotionState {
        phase,
        horizontal_velocity,
        vertical_velocity,
        sprint_active,
        was_jump_pressed: input.jump,
    }
}

pub fn settle_locomotion_after_move(
    state: &LocomotionState,
    input: &InputState,
    resolved_grounded: bool,
) -> LocomotionState {
    let moving = is_moving_input(input);
    // Re-apply the sprint rule against post-move groundedness. The pre-refactor
    // code applied it both before and after the move, so landing while holding
    // sprint activates it on the landing tick itself.
    let sprint_active = sprint_active_for_locomotion(resolved_grounded, input, state.sprint_active);
    let phase = phase_for(
        resolved_grounded,
        state.vertical_velocity,
        moving,
        sprint_active,
    );

    LocomotionState {
        phase,
        horizontal_velocity: state.horizontal_velocity,
        vertical_velocity: state.vertical_velocity,
        sprint_active,
        was_jump_pressed: state.was_jump_pressed,
    }
}

pub fn movement_state_from_locomotion(
    state: &LocomotionState,
    is_grounded: bool,
    was_grounded: bool,
    input: &InputState,
) -> MovementState {
    MovementState::new(is_grounded, was_grounded, input.sprint, state.sprint_active)
}

pub fn phase_for(
    is_grounded: bool,
    vertical_velocity: f32,
    moving: bool,
    sprint_active: bool,
) -> LocomotionPhase {
    if is_grounded {
        return grounded_phase(moving, sprint_active);
    }
    if vertical_velocity > 0.0 {
        LocomotionPhase::AirborneJump
    } else {
        LocomotionPhase::AirborneFall
    }
}

fn grounded_phase(moving: bool, sprint_active: bool) -> LocomotionPhase {
    if !moving {
        LocomotionPhase::GroundedIdle
    } else if sprint_active {
        LocomotionPhase::GroundedSprint
    } else {
        LocomotionPhase::GroundedWalk
    }
}

fn desired_horizontal_velocity(
    input: &InputState,
    rotation_y: f32,
    sprint_active: bool,
    config: &LocomotionConfig,
) -> Vec2 {
    let mut move_x = 0.0;
    let mut move_z = 0.0;
    let cos_yaw = rotation_y.cos();
    let sin_yaw = rotation_y.sin();

    if input.forward {
        move_x -= sin_yaw;
        move_z -= cos_yaw;
    }
    if input.backward {
        move_x += sin_yaw;
        move_z += cos_yaw;
    }
    if input.right {
        move_x += cos_yaw;
        move_z -= sin_yaw;
    }
    if input.left {
        move_x -= cos_yaw;
        move_z += sin_yaw;
    }

    let length_sq = move_x * move_x + move_z * move_z;
    if length_sq <= 0.001 {
        return Vec2::zero();
    }

    let speed = if sprint_active {
        config.walk_speed * config.sprint_multiplier
    } else {
        config.walk_speed
    };
    let scale = speed / length_sq.sqrt();
    Vec2 {
        x: move_x * scale,
        z: move_z * scale,
    }
}

fn advance_horizontal_velocity(
    current: Vec2,
    target: Vec2,
    is_grounded: bool,
    moving: bool,
    delta_seconds: f32,
    config: &LocomotionConfig,
) -> Vec2 {
    if config.instant_horizontal_velocity {
        return target;
    }

    let rate = if moving {
        if is_grounded {
            config.ground_acceleration
        } else {
            config.air_acceleration
        }
    } else if is_grounded {
        config.ground_friction
    } else {
        config.air_friction
    };
    move_toward(current, target, rate * delta_seconds)
}

fn move_toward(current: Vec2, target: Vec2, max_delta: f32) -> Vec2 {
    let dx = target.x - current.x;
    let dz = target.z - current.z;
    let distance = (dx * dx + dz * dz).sqrt();
    if distance <= max_delta || distance <= 0.0001 {
        return target;
    }
    let scale = max_delta / distance;
    Vec2 {
        x: current.x + dx * scale,
        z: current.z + dz * scale,
    }
}

pub fn is_grounded_at(position: &Vector3, ground_y: f32) -> bool {
    position.y <= ground_y + GROUNDED_EPSILON
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::{default_input, DELTA_TIME};
    fn base_state() -> LocomotionState {
        LocomotionState {
            phase: LocomotionPhase::GroundedIdle,
            horizontal_velocity: Vec2::zero(),
            vertical_velocity: 0.0,
            sprint_active: false,
            was_jump_pressed: false,
        }
    }

    fn context(is_grounded: bool) -> LocomotionContext {
        LocomotionContext {
            is_grounded,
            was_grounded: is_grounded,
            rotation_y: 0.0,
            delta_seconds: DELTA_TIME,
        }
    }

    #[test]
    fn grounded_idle_walk_and_sprint_transitions_follow_input() {
        let mut input = default_input();
        let idle = transition_locomotion(
            &base_state(),
            &input,
            context(true),
            &DEFAULT_LOCOMOTION_CONFIG,
        );
        assert_eq!(idle.phase, LocomotionPhase::GroundedIdle);

        input.forward = true;
        let walk = transition_locomotion(
            &idle,
            &input,
            context(true),
            &DEFAULT_LOCOMOTION_CONFIG,
        );
        assert_eq!(walk.phase, LocomotionPhase::GroundedWalk);
        assert!(!walk.sprint_active);

        input.sprint = true;
        let sprint = transition_locomotion(
            &walk,
            &input,
            context(true),
            &DEFAULT_LOCOMOTION_CONFIG,
        );
        assert_eq!(sprint.phase, LocomotionPhase::GroundedSprint);
        assert!(sprint.sprint_active);
    }

    #[test]
    fn jump_edge_enters_airborne_jump() {
        let mut input = default_input();
        input.jump = true;
        let next = transition_locomotion(
            &base_state(),
            &input,
            context(true),
            &DEFAULT_LOCOMOTION_CONFIG,
        );

        assert_eq!(next.phase, LocomotionPhase::AirborneJump);
        assert_eq!(next.vertical_velocity, JUMP_FORCE);
        assert!(next.was_jump_pressed);
    }

    #[test]
    fn airborne_jump_becomes_fall_at_apex() {
        let mut state = base_state();
        state.phase = LocomotionPhase::AirborneJump;
        state.vertical_velocity = 0.01;
        let next = transition_locomotion(
            &state,
            &default_input(),
            context(false),
            &DEFAULT_LOCOMOTION_CONFIG,
        );

        assert_eq!(next.phase, LocomotionPhase::AirborneFall);
        assert!(next.vertical_velocity <= 0.0);
    }

    #[test]
    fn walking_off_ledge_enters_airborne_fall() {
        let mut input = default_input();
        input.forward = true;
        let next = transition_locomotion(
            &base_state(),
            &input,
            context(false),
            &DEFAULT_LOCOMOTION_CONFIG,
        );

        assert_eq!(next.phase, LocomotionPhase::AirborneFall);
    }

    #[test]
    fn landing_maps_to_grounded_state_by_current_input() {
        let mut state = base_state();
        state.phase = LocomotionPhase::AirborneFall;
        state.vertical_velocity = -1.0;
        let mut input = default_input();
        input.forward = true;

        let landed = settle_locomotion_after_move(&state, &input, true);
        assert_eq!(landed.phase, LocomotionPhase::GroundedWalk);
    }

    #[test]
    fn landing_while_holding_sprint_activates_sprint_on_landing_tick() {
        let mut state = base_state();
        state.phase = LocomotionPhase::AirborneFall;
        state.vertical_velocity = -1.0;
        state.sprint_active = false;
        let mut input = default_input();
        input.forward = true;
        input.sprint = true;

        let landed = settle_locomotion_after_move(&state, &input, true);
        assert!(landed.sprint_active);
        assert_eq!(landed.phase, LocomotionPhase::GroundedSprint);
    }

    #[test]
    fn landing_after_releasing_sprint_deactivates_on_landing_tick() {
        let mut state = base_state();
        state.phase = LocomotionPhase::AirborneFall;
        state.vertical_velocity = -1.0;
        state.sprint_active = true;
        let mut input = default_input();
        input.forward = true;

        let landed = settle_locomotion_after_move(&state, &input, true);
        assert!(!landed.sprint_active);
        assert_eq!(landed.phase, LocomotionPhase::GroundedWalk);
    }

    #[test]
    fn midair_sprint_rules_preserve_existing_behavior() {
        let mut input = default_input();
        input.forward = true;
        input.sprint = true;

        let pressed_midair = transition_locomotion(
            &base_state(),
            &input,
            context(false),
            &DEFAULT_LOCOMOTION_CONFIG,
        );
        assert!(!pressed_midair.sprint_active);

        let mut sprinting_state = base_state();
        sprinting_state.sprint_active = true;
        input.sprint = false;
        let released_midair = transition_locomotion(
            &sprinting_state,
            &input,
            context(false),
            &DEFAULT_LOCOMOTION_CONFIG,
        );
        assert!(released_midair.sprint_active);
    }

}