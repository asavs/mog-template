use crate::collision::{self, MAX_SNAP_DOWN_HEIGHT};
use crate::castle_collision::GROUND_SNAP_DISTANCE;
use crate::common::{
    DELTA_TIME, GROUNDED_EPSILON, InputState, MovementState, PLAYER_SPEED,
    POSE_POSITION_EPSILON, POSE_ROTATION_EPSILON, SPRINT_MULTIPLIER, Vector3,
};
use crate::heightmap;
use crate::locomotion::{self, LocomotionContext, LocomotionState, Vec2, DEFAULT_LOCOMOTION_CONFIG};
use crate::{PlayerJumpState, PlayerTransform};

pub fn calculate_next_position(
    current_pos: &Vector3,
    current_ground_y: f32,
    rotation_y: f32,
    input: &InputState,
    sprint_active: bool,
    vertical_velocity: &mut f32,
    was_jump_pressed: &mut bool,
) -> Vector3 {
    let is_grounded = locomotion::is_grounded_at(current_pos, current_ground_y);
    let current_locomotion = LocomotionState {
        phase: locomotion::phase_for(
            is_grounded,
            *vertical_velocity,
            locomotion::is_moving_input(input),
            sprint_active,
        ),
        horizontal_velocity: Vec2::zero(),
        vertical_velocity: *vertical_velocity,
        sprint_active,
        was_jump_pressed: *was_jump_pressed,
    };
    let next_locomotion = locomotion::transition_locomotion(
        &current_locomotion,
        input,
        LocomotionContext {
            is_grounded,
            was_grounded: is_grounded,
            rotation_y,
            delta_seconds: DELTA_TIME,
        },
        &DEFAULT_LOCOMOTION_CONFIG,
    );

    let mut move_dir = Vector3::zero();
    let mut next_pos = current_pos.clone();

    let cos_yaw = rotation_y.cos();
    let sin_yaw = rotation_y.sin();
    let forward = Vector3 {
        x: -sin_yaw,
        y: 0.0,
        z: -cos_yaw,
    };
    let right = Vector3 {
        x: cos_yaw,
        y: 0.0,
        z: -sin_yaw,
    };

    if input.forward {
        move_dir.x += forward.x;
        move_dir.z += forward.z;
    }
    if input.backward {
        move_dir.x -= forward.x;
        move_dir.z -= forward.z;
    }
    if input.right {
        move_dir.x += right.x;
        move_dir.z += right.z;
    }
    if input.left {
        move_dir.x -= right.x;
        move_dir.z -= right.z;
    }

    let length_sq = move_dir.x * move_dir.x + move_dir.z * move_dir.z;
    if length_sq > 0.001 {
        let length = length_sq.sqrt();
        let speed = if next_locomotion.sprint_active {
            PLAYER_SPEED * SPRINT_MULTIPLIER
        } else {
            PLAYER_SPEED
        };
        let move_dist = speed * DELTA_TIME;

        next_pos.x += (move_dir.x / length) * move_dist;
        next_pos.z += (move_dir.z / length) * move_dist;
    }

    next_pos.y += next_locomotion.vertical_velocity * DELTA_TIME;

    *vertical_velocity = next_locomotion.vertical_velocity;
    if next_pos.y <= current_ground_y {
        next_pos.y = current_ground_y;
        *vertical_velocity = 0.0;
    }

    *was_jump_pressed = next_locomotion.was_jump_pressed;
    next_pos
}

pub fn is_moving(input: &InputState) -> bool {
    locomotion::is_moving_input(input)
}

pub fn sprint_active_for_state(
    is_grounded: bool,
    input: &InputState,
    previous_sprint_active: bool,
) -> bool {
    locomotion::sprint_active_for_locomotion(is_grounded, input, previous_sprint_active)
}

pub fn movement_state(
    is_grounded: bool,
    was_grounded: bool,
    input: &InputState,
    previous_sprint_active: bool,
) -> MovementState {
    let locomotion_state = LocomotionState {
        phase: locomotion::phase_for(
            is_grounded,
            0.0,
            locomotion::is_moving_input(input),
            sprint_active_for_state(is_grounded, input, previous_sprint_active),
        ),
        horizontal_velocity: Vec2::zero(),
        vertical_velocity: 0.0,
        sprint_active: sprint_active_for_state(is_grounded, input, previous_sprint_active),
        was_jump_pressed: input.jump,
    };
    locomotion::movement_state_from_locomotion(&locomotion_state, is_grounded, was_grounded, input)
}

pub fn update_transform(
    transform: &mut PlayerTransform,
    jump_state: &mut PlayerJumpState,
    input: &InputState,
    rotation_y: f32,
) {
    let terrain_ground_y = heightmap::terrain_height_at(&transform.position);
    let castle_ground = collision::castle_ground_support(&transform.position, GROUND_SNAP_DISTANCE);
    let current_ground_y = castle_ground
        .as_ref()
        .map(|support| support.y)
        .unwrap_or(terrain_ground_y);
    let was_grounded = transform.position.y <= current_ground_y + GROUNDED_EPSILON;
    let is_starting_jump = input.jump && !jump_state.was_jump_pressed && was_grounded;
    let sprint_active = sprint_active_for_state(
        was_grounded,
        input,
        transform.movement_state.sprint_active,
    );

    let desired_position = calculate_next_position(
        &transform.position,
        current_ground_y,
        rotation_y,
        input,
        sprint_active,
        &mut jump_state.vertical_velocity,
        &mut jump_state.was_jump_pressed,
    );
    let mut resolved_position =
        collision::resolve_player_movement(&transform.position, &desired_position);
    let terrain_resolved_ground_y = heightmap::terrain_height_at(&resolved_position);
    let castle_resolved_ground = collision::castle_ground_support(
        &resolved_position,
        GROUND_SNAP_DISTANCE,
    );
    let resolved_ground_y = castle_resolved_ground
        .as_ref()
        .map(|support| support.y)
        .unwrap_or(terrain_resolved_ground_y);
    if was_grounded && is_starting_jump {
        if current_ground_y - resolved_ground_y <= MAX_SNAP_DOWN_HEIGHT {
            resolved_position.y = resolved_ground_y + jump_state.vertical_velocity * DELTA_TIME;
        }
    } else if was_grounded {
        if current_ground_y - resolved_ground_y <= MAX_SNAP_DOWN_HEIGHT {
            resolved_position.y = resolved_ground_y;
            jump_state.vertical_velocity = 0.0;
        }
    } else if resolved_position.y <= resolved_ground_y {
        resolved_position.y = resolved_ground_y;
        jump_state.vertical_velocity = 0.0;
    }

    let resolved_grounded = resolved_position.y <= resolved_ground_y + GROUNDED_EPSILON;
    let locomotion_after_move = locomotion::settle_locomotion_after_move(
        &LocomotionState {
            phase: locomotion::phase_for(
                resolved_grounded,
                jump_state.vertical_velocity,
                locomotion::is_moving_input(input),
                sprint_active,
            ),
            horizontal_velocity: Vec2::zero(),
            vertical_velocity: jump_state.vertical_velocity,
            sprint_active,
            was_jump_pressed: jump_state.was_jump_pressed,
        },
        input,
        resolved_grounded,
    );
    let next_movement_state = locomotion::movement_state_from_locomotion(
        &locomotion_after_move,
        resolved_grounded,
        was_grounded,
        input,
    );

    transform.position = resolved_position;
    transform.rotation_y = rotation_y;
    transform.is_moving = is_moving(input);
    transform.movement_state = next_movement_state;
}

/// Semantic pose fields that justify publishing a `player_transform` row update.
/// Excludes `server_tick` / `updated_at` (idle rebroadcast) and input acks
/// (those live on public `player_input_ack` — audit #16).
#[derive(Clone, Debug)]
pub struct TransformPoseSnapshot {
    pub position: Vector3,
    pub rotation_y: f32,
    pub is_moving: bool,
    pub movement_state: MovementState,
}

impl From<&PlayerTransform> for TransformPoseSnapshot {
    fn from(transform: &PlayerTransform) -> Self {
        Self {
            position: transform.position.clone(),
            rotation_y: transform.rotation_y,
            is_moving: transform.is_moving,
            movement_state: transform.movement_state.clone(),
        }
    }
}

/// True when game-meaningful pose fields changed enough to justify a
/// SpacetimeDB row update (and therefore a wire delta to subscribers).
///
/// `server_tick` / `updated_at` alone must never force a publish — that is the
/// idle rebroadcast bug. Input acks are intentionally excluded; pure-ack
/// updates go through `player_input_ack` so remotes do not rebuild pose snapshots.
pub fn transform_needs_publish_from_snapshot(
    before: &TransformPoseSnapshot,
    after: &PlayerTransform,
) -> bool {
    pose_snapshot_needs_publish(before, &after.into())
}

pub fn pose_snapshot_needs_publish(
    before: &TransformPoseSnapshot,
    after: &TransformPoseSnapshot,
) -> bool {
    !positions_near_equal(&before.position, &after.position)
        || !rotations_near_equal(before.rotation_y, after.rotation_y)
        || before.is_moving != after.is_moving
        || before.movement_state != after.movement_state
}

fn positions_near_equal(a: &Vector3, b: &Vector3) -> bool {
    (a.x - b.x).abs() <= POSE_POSITION_EPSILON
        && (a.y - b.y).abs() <= POSE_POSITION_EPSILON
        && (a.z - b.z).abs() <= POSE_POSITION_EPSILON
}

fn rotations_near_equal(a: f32, b: f32) -> bool {
    let delta = (a - b).rem_euclid(std::f32::consts::TAU);
    let shortest = if delta > std::f32::consts::PI {
        std::f32::consts::TAU - delta
    } else {
        delta
    };
    shortest <= POSE_ROTATION_EPSILON
}

#[cfg(test)]
mod tests {
    use super::*;
    // Explicit imports: tests must not rely on production `use` lists via super::*
    // (see public #24). JUMP_FORCE / GRAVITY are locomotion-owned constants.
    use crate::common::{GROUND_Y, GRAVITY, JUMP_FORCE, default_input};

    fn assert_close(left: f32, right: f32) {
        assert!((left - right).abs() < 0.0001, "{left} != {right}");
    }

    fn snapshot(fields: TransformPoseSnapshot) -> TransformPoseSnapshot {
        fields
    }

    fn idle_snapshot() -> TransformPoseSnapshot {
        TransformPoseSnapshot {
            position: Vector3::zero(),
            rotation_y: 0.0,
            is_moving: false,
            movement_state: MovementState::grounded(),
        }
    }

    #[test]
    fn idle_pose_does_not_need_publish() {
        let before = idle_snapshot();
        let after = idle_snapshot();
        assert!(!pose_snapshot_needs_publish(&before, &after));
    }

    #[test]
    fn sub_epsilon_position_noise_does_not_need_publish() {
        let before = idle_snapshot();
        let after = snapshot(TransformPoseSnapshot {
            position: Vector3 {
                x: POSE_POSITION_EPSILON * 0.5,
                y: 0.0,
                z: 0.0,
            },
            ..idle_snapshot()
        });
        assert!(!pose_snapshot_needs_publish(&before, &after));
    }

    #[test]
    fn position_change_needs_publish() {
        let before = idle_snapshot();
        let after = snapshot(TransformPoseSnapshot {
            position: Vector3 {
                x: 0.01,
                y: 0.0,
                z: 0.0,
            },
            ..idle_snapshot()
        });
        assert!(pose_snapshot_needs_publish(&before, &after));
    }

    #[test]
    fn rotation_change_needs_publish() {
        let before = idle_snapshot();
        let after = snapshot(TransformPoseSnapshot {
            rotation_y: 0.05,
            ..idle_snapshot()
        });
        assert!(pose_snapshot_needs_publish(&before, &after));
    }

    #[test]
    fn movement_state_change_needs_publish() {
        let before = idle_snapshot();
        let after = snapshot(TransformPoseSnapshot {
            is_moving: true,
            movement_state: MovementState::new(true, true, false, false),
            ..idle_snapshot()
        });
        assert!(pose_snapshot_needs_publish(&before, &after));
    }

    #[test]
    fn pose_snapshot_ignores_identity_of_ack_channel() {
        // Pure-ack changes live on player_input_ack; pose gate is pose-only.
        // Two identical pose snapshots never need a transform publish.
        let before = idle_snapshot();
        let after = idle_snapshot();
        assert!(!pose_snapshot_needs_publish(&before, &after));
    }

    #[test]
    fn idle_does_not_move() {
        let start = Vector3::zero();
        let mut vertical_velocity = 0.0;
        let mut was_jump_pressed = false;
        let next = calculate_next_position(
            &start,
            GROUND_Y,
            0.0,
            &default_input(),
            false,
            &mut vertical_velocity,
            &mut was_jump_pressed,
        );
        assert_eq!(next, start);
    }

    #[test]
    fn forward_moves_down_z() {
        let mut input = default_input();
        input.forward = true;
        let mut vertical_velocity = 0.0;
        let mut was_jump_pressed = false;
        let next = calculate_next_position(
            &Vector3::zero(),
            GROUND_Y,
            0.0,
            &input,
            false,
            &mut vertical_velocity,
            &mut was_jump_pressed,
        );
        assert_close(next.x, 0.0);
        assert_close(next.z, -PLAYER_SPEED * DELTA_TIME);
    }

    #[test]
    fn diagonal_movement_is_normalized() {
        let mut input = default_input();
        input.forward = true;
        input.right = true;
        let mut vertical_velocity = 0.0;
        let mut was_jump_pressed = false;
        let next = calculate_next_position(
            &Vector3::zero(),
            GROUND_Y,
            0.0,
            &input,
            false,
            &mut vertical_velocity,
            &mut was_jump_pressed,
        );
        let dist = (next.x * next.x + next.z * next.z).sqrt();
        assert_close(dist, PLAYER_SPEED * DELTA_TIME);
    }

    #[test]
    fn sprint_uses_multiplier() {
        let mut input = default_input();
        input.forward = true;
        input.sprint = true;
        let mut vertical_velocity = 0.0;
        let mut was_jump_pressed = false;
        let next = calculate_next_position(
            &Vector3::zero(),
            GROUND_Y,
            0.0,
            &input,
            true,
            &mut vertical_velocity,
            &mut was_jump_pressed,
        );
        assert_close(next.z, -(PLAYER_SPEED * SPRINT_MULTIPLIER * DELTA_TIME));
    }

    #[test]
    fn midair_sprint_press_does_not_activate_sprint() {
        let mut input = default_input();
        input.forward = true;
        input.sprint = true;

        assert!(!sprint_active_for_state(false, &input, false));

        let mut vertical_velocity = 0.0;
        let mut was_jump_pressed = false;
        let next = calculate_next_position(
            &Vector3 {
                x: 0.0,
                y: GROUND_Y + 1.0,
                z: 0.0,
            },
            GROUND_Y,
            0.0,
            &input,
            false,
            &mut vertical_velocity,
            &mut was_jump_pressed,
        );
        assert_close(next.z, -PLAYER_SPEED * DELTA_TIME);
    }

    #[test]
    fn midair_sprint_release_preserves_active_sprint_until_grounded() {
        let mut input = default_input();
        input.forward = true;
        input.sprint = false;

        assert!(sprint_active_for_state(false, &input, true));
        assert!(!sprint_active_for_state(true, &input, true));
    }

    #[test]
    fn movement_state_separates_sprint_intent_from_active() {
        let mut input = default_input();
        input.sprint = true;
        let idle_state = movement_state(true, true, &input, false);

        assert!(idle_state.sprint_intent);
        assert!(!idle_state.sprint_active);

        input.forward = true;
        let moving_state = movement_state(false, true, &input, true);

        assert!(moving_state.sprint_intent);
        assert!(moving_state.sprint_active);
        assert!(moving_state.is_airborne);
        assert!(moving_state.was_grounded);
    }

    #[test]
    fn rotation_changes_forward_direction() {
        let mut input = default_input();
        input.forward = true;
        let mut vertical_velocity = 0.0;
        let mut was_jump_pressed = false;
        let next = calculate_next_position(
            &Vector3::zero(),
            GROUND_Y,
            std::f32::consts::FRAC_PI_2,
            &input,
            false,
            &mut vertical_velocity,
            &mut was_jump_pressed,
        );
        assert_close(next.x, -PLAYER_SPEED * DELTA_TIME);
        assert_close(next.z, 0.0);
    }

    #[test]
    fn jump_moves_up_on_ground() {
        let mut input = default_input();
        input.jump = true;
        let mut vertical_velocity = 0.0;
        let mut was_jump_pressed = false;
        let next = calculate_next_position(
            &Vector3::zero(),
            GROUND_Y,
            0.0,
            &input,
            false,
            &mut vertical_velocity,
            &mut was_jump_pressed,
        );
        assert_close(next.y, JUMP_FORCE * DELTA_TIME);
    }

    #[test]
    fn jump_tuning_matches_lower_faster_target_envelope() {
        let gravity_magnitude = GRAVITY.abs();
        let apex_meters = (JUMP_FORCE * JUMP_FORCE) / (2.0 * gravity_magnitude);
        let total_airtime_seconds = (2.0 * JUMP_FORCE) / gravity_magnitude;

        assert!(
            apex_meters > 1.7 && apex_meters < 1.9,
            "jump apex should stay near 1.8m, got {apex_meters}"
        );
        assert!(
            total_airtime_seconds > 0.65 && total_airtime_seconds < 0.75,
            "jump airtime should stay near 0.7s, got {total_airtime_seconds}"
        );
    }
}
