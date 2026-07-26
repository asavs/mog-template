use crate::collision;
use crate::common::{
    DELTA_TIME, GROUNDED_EPSILON, InputState, MovementState, PLAYER_SPEED,
    POSE_POSITION_EPSILON, POSE_ROTATION_EPSILON, SPRINT_MULTIPLIER, Vector3,
};
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

#[allow(dead_code)] // public API retained for tests / future call sites
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
    let ground_y = crate::common::GROUND_Y;
    let was_grounded = transform.position.y <= ground_y + GROUNDED_EPSILON;
    let sprint_active = sprint_active_for_state(was_grounded, input, transform.movement_state.sprint_active);

    let desired_position = calculate_next_position(
        &transform.position,
        ground_y,
        rotation_y,
        input,
        sprint_active,
        &mut jump_state.vertical_velocity,
        &mut jump_state.was_jump_pressed,
    );

    let mut resolved_position = collision::resolve_player_movement(&transform.position, &desired_position).position;
    if resolved_position.y <= ground_y {
        resolved_position.y = ground_y;
        jump_state.vertical_velocity = 0.0;
    }

    let resolved_grounded = resolved_position.y <= ground_y + GROUNDED_EPSILON;
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
        &locomotion_after_move, resolved_grounded, was_grounded, input,
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

    // --- Golden movement-trace fixture (Wave 2M pass B) ---

    use serde::{Deserialize, Serialize};
    use spacetimedb::{Identity, Timestamp};

    const MOVEMENT_TRACE_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../shared/fixtures/movement-trace.json"
    );

    #[derive(Serialize, Deserialize, Clone, Copy, Debug)]
    #[serde(rename_all = "camelCase")]
    struct TraceInput {
        forward: bool,
        backward: bool,
        left: bool,
        right: bool,
        sprint: bool,
        jump: bool,
    }

    impl TraceInput {
        const fn none() -> Self {
            Self {
                forward: false,
                backward: false,
                left: false,
                right: false,
                sprint: false,
                jump: false,
            }
        }

        const fn forward() -> Self {
            Self {
                forward: true,
                ..Self::none()
            }
        }

        const fn backward() -> Self {
            Self {
                backward: true,
                ..Self::none()
            }
        }

        const fn left() -> Self {
            Self {
                left: true,
                ..Self::none()
            }
        }

        const fn right() -> Self {
            Self {
                right: true,
                ..Self::none()
            }
        }

        fn to_input_state(self) -> InputState {
            InputState {
                forward: self.forward,
                backward: self.backward,
                left: self.left,
                right: self.right,
                sprint: self.sprint,
                jump: self.jump,
                sequence: 0,
                client_tick: 0,
            }
        }
    }

    #[derive(Serialize, Deserialize, Debug)]
    #[serde(rename_all = "camelCase")]
    struct TraceFrame {
        tick: u32,
        input: TraceInput,
        rotation_y: f32,
        expected: [f32; 3],
    }

    #[derive(Serialize, Deserialize, Debug)]
    #[serde(rename_all = "camelCase")]
    struct TraceMeta {
        generated_by: String,
        regenerate: String,
        tick_rate: f32,
        delta_seconds: f32,
        player_collision_radius: f32,
        start_position: [f32; 3],
        start_rotation_y: f32,
    }

    #[derive(Serialize, Deserialize, Debug)]
    #[serde(rename_all = "camelCase")]
    struct MovementTrace {
        meta: TraceMeta,
        frames: Vec<TraceFrame>,
    }

    /// Deterministic canned input script (~200 ticks) covering open walks,
    /// sprint, jump arc, wall contact + jump-at-wall, corner settle, pillar
    /// contact + slide, and idle. `rotation_y` is always 0 (forward = -z).
    fn scripted_inputs() -> Vec<(TraceInput, f32)> {
        let mut out: Vec<(TraceInput, f32)> = Vec::new();
        let yaw = 0.0_f32;

        let mut push = |n: usize, input: TraceInput| {
            for _ in 0..n {
                out.push((input, yaw));
            }
        };

        // Phase 1 — open-space walks (ticks 0-63): each cardinal ~8 ticks,
        // returning toward center between directions.
        // forward 0-7, return 8-15
        push(8, TraceInput::forward());
        push(8, TraceInput::backward());
        // backward 16-23, return 24-31
        push(8, TraceInput::backward());
        push(8, TraceInput::forward());
        // right 32-39, return 40-47
        push(8, TraceInput::right());
        push(8, TraceInput::left());
        // left 48-55, return 56-63
        push(8, TraceInput::left());
        push(8, TraceInput::right());

        // Phase 2 — sprint (ticks 64-78): hold forward + sprint ~15 ticks.
        push(
            15,
            TraceInput {
                forward: true,
                sprint: true,
                ..TraceInput::none()
            },
        );

        // Phase 3 — isolated jump on flat open ground (ticks 79-100):
        // press jump 1 tick then release; ~20 idle ticks for full arc.
        push(2, TraceInput::none());
        push(
            1,
            TraceInput {
                jump: true,
                ..TraceInput::none()
            },
        );
        push(20, TraceInput::none());

        // Phase 4 — walk into wall_n and jump at contact (ticks 101-153):
        // from z≈-8 after sprint, forward ~40 ticks reaches z≈-19.55 clamp;
        // hold into wall, then jump while still holding forward.
        push(40, TraceInput::forward());
        push(6, TraceInput::forward());
        push(
            1,
            TraceInput {
                forward: true,
                jump: true,
                ..TraceInput::none()
            },
        );
        push(12, TraceInput::forward());

        // Phase 5 — diagonal/along-wall approach into NE corner (ticks 154-197):
        // sprint right along wall_n toward x=+20, then forward+right to settle
        // against both bounds (x and z near ±19.55).
        push(
            36,
            TraceInput {
                right: true,
                sprint: true,
                ..TraceInput::none()
            },
        );
        push(
            8,
            TraceInput {
                forward: true,
                right: true,
                ..TraceInput::none()
            },
        );

        // Phase 6 — pillar_ne contact + diagonal slide (ticks 198-244):
        // from SE-ish corner (~19.55, -19.55) steer left+backward toward
        // pillar_ne (10, -10); hold into it, then add a second axis to slide.
        push(
            38,
            TraceInput {
                left: true,
                backward: true,
                ..TraceInput::none()
            },
        );
        push(
            6,
            TraceInput {
                left: true,
                backward: true,
                ..TraceInput::none()
            },
        );
        // Slide: keep left and drop backward, add forward to graze around the cylinder.
        push(
            10,
            TraceInput {
                left: true,
                forward: true,
                ..TraceInput::none()
            },
        );

        // Phase 7 — idle (ticks 245-249)
        push(5, TraceInput::none());

        out
    }

    fn throwaway_transform(start: [f32; 3], rotation_y: f32) -> PlayerTransform {
        PlayerTransform {
            identity: Identity::__dummy(),
            position: Vector3 {
                x: start[0],
                y: start[1],
                z: start[2],
            },
            rotation_y,
            is_moving: false,
            movement_state: MovementState::grounded(),
            server_tick: 0,
            updated_at: Timestamp::UNIX_EPOCH,
        }
    }

    fn throwaway_jump_state() -> PlayerJumpState {
        PlayerJumpState {
            identity: Identity::__dummy(),
            vertical_velocity: 0.0,
            was_jump_pressed: false,
        }
    }

    fn simulate_trace_frames(
        start_position: [f32; 3],
        start_rotation_y: f32,
        script: &[(TraceInput, f32)],
    ) -> Vec<TraceFrame> {
        let mut transform = throwaway_transform(start_position, start_rotation_y);
        let mut jump_state = throwaway_jump_state();
        let mut frames = Vec::with_capacity(script.len());

        for (tick, (trace_input, rotation_y)) in script.iter().enumerate() {
            let input = trace_input.to_input_state();
            update_transform(&mut transform, &mut jump_state, &input, *rotation_y);
            frames.push(TraceFrame {
                tick: tick as u32,
                input: *trace_input,
                rotation_y: *rotation_y,
                expected: [
                    transform.position.x,
                    transform.position.y,
                    transform.position.z,
                ],
            });
        }
        frames
    }

    #[test]
    #[ignore = "generator: writes shared/fixtures/movement-trace.json; run with --ignored"]
    fn generate_movement_trace_fixture() {
        let start_position = [0.0_f32, 0.0, 0.0];
        let start_rotation_y = 0.0_f32;
        let script = scripted_inputs();
        let frames = simulate_trace_frames(start_position, start_rotation_y, &script);

        let trace = MovementTrace {
            meta: TraceMeta {
                generated_by: "server".to_string(),
                regenerate: "cargo test -p server --manifest-path server/spacetimedb/Cargo.toml -- --ignored generate_movement_trace_fixture --nocapture".to_string(),
                tick_rate: crate::common::TICK_RATE,
                delta_seconds: DELTA_TIME,
                player_collision_radius: collision::PLAYER_COLLISION_RADIUS,
                start_position,
                start_rotation_y,
            },
            frames,
        };

        let json = serde_json::to_string_pretty(&trace).expect("serialize movement trace");
        let path = std::path::Path::new(MOVEMENT_TRACE_PATH);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create fixtures directory");
        }
        std::fs::write(path, format!("{json}\n")).expect("write movement-trace.json");
        eprintln!(
            "wrote {} frames to {}",
            trace.frames.len(),
            path.display()
        );
    }

    #[test]
    fn movement_trace_fixture_replays_deterministically() {
        let raw = std::fs::read_to_string(MOVEMENT_TRACE_PATH).unwrap_or_else(|err| {
            panic!(
                "failed to read movement trace fixture at {MOVEMENT_TRACE_PATH}: {err}\n\
                 regenerate with: cargo test -p server --manifest-path server/spacetimedb/Cargo.toml \
                 -- --ignored generate_movement_trace_fixture --nocapture"
            );
        });
        let trace: MovementTrace =
            serde_json::from_str(&raw).expect("deserialize movement-trace.json");

        assert!(
            !trace.frames.is_empty(),
            "fixture must contain at least one frame"
        );

        let script: Vec<(TraceInput, f32)> = trace
            .frames
            .iter()
            .map(|f| (f.input, f.rotation_y))
            .collect();
        let recomputed = simulate_trace_frames(
            trace.meta.start_position,
            trace.meta.start_rotation_y,
            &script,
        );

        assert_eq!(recomputed.len(), trace.frames.len());
        for (stored, fresh) in trace.frames.iter().zip(recomputed.iter()) {
            assert_eq!(stored.tick, fresh.tick);
            assert_close(fresh.expected[0], stored.expected[0]);
            assert_close(fresh.expected[1], stored.expected[1]);
            assert_close(fresh.expected[2], stored.expected[2]);
        }
    }
}
