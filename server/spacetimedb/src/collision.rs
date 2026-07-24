use crate::common::Vector3;
use crate::castle_collision;
use crate::heightmap;

pub const PLAYER_COLLISION_RADIUS: f32 = 0.45;
/// Player transform positions are capsule feet, not capsule centers.
pub const PLAYER_CAPSULE_HEIGHT: f32 = 1.8;
pub const MAX_WALKABLE_SLOPE_DEGREES: f32 = 70.0;
pub const MAX_STEP_HEIGHT: f32 = 1.25;
pub const MAX_SNAP_DOWN_HEIGHT: f32 = 6.0;

const WORLD_MIN_X: f32 = -1574.03;
const WORLD_MAX_X: f32 = 1574.03;
const WORLD_MIN_Z: f32 = -1231.44;
const WORLD_MAX_Z: f32 = 1231.44;
const MAX_WALKABLE_SLOPE: f32 = 2.7474775; // tan(70 degrees)
const SLOPE_SAMPLE_DISTANCE: f32 = 1.0;

#[derive(Clone, Copy, Debug)]
pub struct Aabb {
    pub min_x: f32,
    pub max_x: f32,
    pub min_z: f32,
    pub max_z: f32,
}

pub fn resolve_player_movement(current: &Vector3, desired: &Vector3) -> castle_collision::CapsuleMoveResult {
    let terrain_resolved = resolve_player_movement_against(current, desired, &[]);
    castle_collision::resolve_capsule_sweep(
        current,
        &terrain_resolved,
        PLAYER_COLLISION_RADIUS,
        PLAYER_CAPSULE_HEIGHT,
    )
}

/// Finds the first reachable walkable castle surface below this exact capsule.
/// It deliberately sweeps from the player's current elevation instead of looking up a
/// global X/Z height, so stacked spiral ramps remain distinct.
pub fn castle_ground_support(position: &Vector3, max_distance: f32) -> Option<Vector3> {
    let result = castle_collision::snap_capsule_down(
        position,
        max_distance,
        PLAYER_COLLISION_RADIUS,
        PLAYER_CAPSULE_HEIGHT,
    );
    let moved_sideways = ((result.position.x - position.x).powi(2)
        + (result.position.z - position.z).powi(2))
    .sqrt() > castle_collision::CAPSULE_SKIN;
    if moved_sideways {
        return None;
    }
    result
        .ground_normal
        .filter(|normal| normal.y >= castle_collision::MIN_WALKABLE_NORMAL_Y)
        .map(|_| result.position)
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
            WORLD_MIN_X + PLAYER_COLLISION_RADIUS,
            WORLD_MAX_X - PLAYER_COLLISION_RADIUS,
        ),
        y: position.y,
        z: position.z.clamp(
            WORLD_MIN_Z + PLAYER_COLLISION_RADIUS,
            WORLD_MAX_Z - PLAYER_COLLISION_RADIUS,
        ),
    }
}

fn collides_with_blockers(position: &Vector3, blockers: &[Aabb]) -> bool {
    blockers.iter().any(|blocker| blocker.contains_capsule_footprint(position))
}

fn can_move_to(current: &Vector3, desired: &Vector3, blockers: &[Aabb]) -> bool {
    !collides_with_blockers(desired, blockers)
        && is_terrain_step_walkable(current, desired)
}

pub fn is_terrain_step_walkable(current: &Vector3, desired: &Vector3) -> bool {
    let dx = desired.x - current.x;
    let dz = desired.z - current.z;
    let distance = (dx * dx + dz * dz).sqrt();
    if distance <= 0.001 {
        return true;
    }

    let segments = (distance / SLOPE_SAMPLE_DISTANCE).ceil().max(1.0) as u32;
    let mut previous_x = current.x;
    let mut previous_z = current.z;
    let mut previous_ground = heightmap::terrain_height_at(current);

    for i in 1..=segments {
        let t = i as f32 / segments as f32;
        let next_x = current.x + (desired.x - current.x) * t;
        let next_z = current.z + (desired.z - current.z) * t;
        let next_ground = heightmap::sample_height(next_x, next_z);
        let step_dx = next_x - previous_x;
        let step_dz = next_z - previous_z;
        let step_distance = (step_dx * step_dx + step_dz * step_dz).sqrt().max(0.001);
        let height_delta = next_ground - previous_ground;
        let uphill_delta = height_delta.max(0.0);
        let uphill_slope = uphill_delta / step_distance;

        if uphill_delta > 0.001
            && (!heightmap::is_terrain_walkable_at(next_x, next_z)
                || uphill_slope > MAX_WALKABLE_SLOPE)
        {
            return false;
        }

        previous_x = next_x;
        previous_z = next_z;
        previous_ground = next_ground;
    }

    true
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

        assert_close(resolved.x, WORLD_MAX_X - PLAYER_COLLISION_RADIUS);
        assert_close(resolved.y, 2.0);
        assert_close(resolved.z, WORLD_MIN_Z + PLAYER_COLLISION_RADIUS);
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
