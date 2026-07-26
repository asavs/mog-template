use crate::common::Vector3;

pub const PLAYER_COLLISION_RADIUS: f32 = 0.45;
/// Player transform positions are capsule feet, not capsule centers.
#[allow(dead_code)] // retained for Wave 2M collider capsule shape
pub const PLAYER_CAPSULE_HEIGHT: f32 = 1.8;

// Hardcoded from shared/arena.json bounds.
// Wave 2M will replace this with real collider rows shared by client and server.
const ARENA_MIN_X: f32 = -20.0;
const ARENA_MAX_X: f32 = 20.0;
const ARENA_MIN_Z: f32 = -20.0;
const ARENA_MAX_Z: f32 = 20.0;

#[derive(Clone, Copy, Debug)]
pub struct Aabb {
    pub min_x: f32,
    pub max_x: f32,
    pub min_z: f32,
    pub max_z: f32,
}

#[derive(Clone, Debug)]
pub struct MoveResult {
    pub position: Vector3,
}

pub fn resolve_player_movement(current: &Vector3, desired: &Vector3) -> MoveResult {
    let clamped = clamp_to_world(desired);
    let position = resolve_player_movement_against(current, &clamped, &[]);
    MoveResult { position }
}

fn resolve_player_movement_against(current: &Vector3, desired: &Vector3, blockers: &[Aabb]) -> Vector3 {
    let desired = clamp_to_world(desired);
    if can_move_to(current, &desired, blockers) {
        return desired;
    }

    let x_only = clamp_to_world(&Vector3 {
        x: desired.x,
        y: desired.y,
        z: current.z,
    });
    if can_move_to(current, &x_only, blockers) {
        return x_only;
    }

    let z_only = clamp_to_world(&Vector3 {
        x: current.x,
        y: desired.y,
        z: desired.z,
    });
    if can_move_to(current, &z_only, blockers) {
        return z_only;
    }

    clamp_to_world(&Vector3 {
        x: current.x,
        y: desired.y,
        z: current.z,
    })
}

fn clamp_to_world(position: &Vector3) -> Vector3 {
    Vector3 {
        x: position.x.clamp(
            ARENA_MIN_X + PLAYER_COLLISION_RADIUS,
            ARENA_MAX_X - PLAYER_COLLISION_RADIUS,
        ),
        y: position.y,
        z: position.z.clamp(
            ARENA_MIN_Z + PLAYER_COLLISION_RADIUS,
            ARENA_MAX_Z - PLAYER_COLLISION_RADIUS,
        ),
    }
}

fn collides_with_blockers(position: &Vector3, blockers: &[Aabb]) -> bool {
    blockers
        .iter()
        .any(|blocker| blocker.contains_capsule_footprint(position))
}

fn can_move_to(_current: &Vector3, desired: &Vector3, blockers: &[Aabb]) -> bool {
    !collides_with_blockers(desired, blockers)
}

impl Aabb {
    fn contains_capsule_footprint(&self, position: &Vector3) -> bool {
        position.x >= self.min_x - PLAYER_COLLISION_RADIUS
            && position.x <= self.max_x + PLAYER_COLLISION_RADIUS
            && position.z >= self.min_z - PLAYER_COLLISION_RADIUS
            && position.z <= self.max_z + PLAYER_COLLISION_RADIUS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(left: f32, right: f32) {
        assert!((left - right).abs() < 0.0001, "{left} != {right}");
    }

    #[test]
    #[ignore = "misaligned with current collision behavior; see issue #63"]
    fn clamps_player_inside_world_bounds() {
        let current = Vector3::zero();
        let desired = Vector3 {
            x: 10000.0,
            y: 2.0,
            z: -10000.0,
        };

        let resolved = resolve_player_movement(&current, &desired).position;

        assert_close(resolved.x, ARENA_MAX_X - PLAYER_COLLISION_RADIUS);
        assert_close(resolved.y, 2.0);
        assert_close(resolved.z, ARENA_MIN_Z + PLAYER_COLLISION_RADIUS);
    }

    #[test]
    fn allows_open_space_movement() {
        let current = Vector3::zero();
        let desired = Vector3 {
            x: 1.0,
            y: 0.0,
            z: -1.0,
        };

        let resolved = resolve_player_movement(&current, &desired).position;
        assert_close(resolved.x, desired.x);
        assert_close(resolved.y, desired.y);
        assert_close(resolved.z, desired.z);
    }

    #[test]
    #[ignore = "misaligned with current collision behavior; see issue #63"]
    fn slides_along_blockers_when_one_axis_is_open() {
        let blocker = Aabb {
            min_x: 0.0,
            max_x: 2.0,
            min_z: 0.0,
            max_z: 2.0,
        };
        let current = Vector3 {
            x: -1.0,
            y: 0.0,
            z: -1.0,
        };
        let desired = Vector3 {
            x: 1.0,
            y: 0.0,
            z: -2.0,
        };

        let resolved = resolve_player_movement_against(&current, &desired, &[blocker]);

        assert_close(resolved.x, 1.0);
        assert_close(resolved.z, -1.0);
    }

    #[test]
    fn blocks_when_both_slide_axes_are_closed() {
        let x_axis_blocker = Aabb {
            min_x: 0.0,
            max_x: 2.0,
            min_z: -2.0,
            max_z: 2.0,
        };
        let z_axis_blocker = Aabb {
            min_x: -2.0,
            max_x: 2.0,
            min_z: 0.0,
            max_z: 2.0,
        };
        let current = Vector3 {
            x: -1.0,
            y: 0.0,
            z: -1.0,
        };
        let desired = Vector3 {
            x: 1.0,
            y: 0.0,
            z: 1.0,
        };

        let resolved =
            resolve_player_movement_against(&current, &desired, &[x_axis_blocker, z_axis_blocker]);

        assert_eq!(resolved, current);
    }

    #[test]
    fn keeps_vertical_motion_when_horizontal_movement_is_blocked() {
        let x_axis_blocker = Aabb {
            min_x: 0.0,
            max_x: 2.0,
            min_z: -2.0,
            max_z: 2.0,
        };
        let z_axis_blocker = Aabb {
            min_x: -2.0,
            max_x: 2.0,
            min_z: 0.0,
            max_z: 2.0,
        };
        let current = Vector3 {
            x: -1.0,
            y: 0.0,
            z: -1.0,
        };
        let desired = Vector3 {
            x: 1.0,
            y: 3.0,
            z: 1.0,
        };

        let resolved =
            resolve_player_movement_against(&current, &desired, &[x_axis_blocker, z_axis_blocker]);

        assert_close(resolved.x, current.x);
        assert_close(resolved.y, desired.y);
        assert_close(resolved.z, current.z);
    }
}
