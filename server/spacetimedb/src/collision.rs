include!("arena.generated.rs");

use crate::common::Vector3;

pub const PLAYER_COLLISION_RADIUS: f32 = 0.45;
/// Player transform positions are capsule feet, not capsule centers.
#[allow(dead_code)] // retained for Wave 2M collider capsule shape
pub const PLAYER_CAPSULE_HEIGHT: f32 = 1.8;

#[derive(Clone, Debug)]
pub struct MoveResult {
    pub position: Vector3,
}

pub fn resolve_player_movement(current: &Vector3, desired: &Vector3) -> MoveResult {
    let _ = current;
    let clamped = clamp_to_arena_bounds(desired);
    let resolved = resolve_against_colliders(&clamped, ARENA_COLLIDERS);
    MoveResult {
        position: clamp_to_arena_bounds(&resolved),
    }
}

fn clamp_to_arena_bounds(position: &Vector3) -> Vector3 {
    Vector3 {
        x: position.x.clamp(
            ARENA_BOUNDS.min_x + PLAYER_COLLISION_RADIUS,
            ARENA_BOUNDS.max_x - PLAYER_COLLISION_RADIUS,
        ),
        y: position.y,
        z: position.z.clamp(
            ARENA_BOUNDS.min_z + PLAYER_COLLISION_RADIUS,
            ARENA_BOUNDS.max_z - PLAYER_COLLISION_RADIUS,
        ),
    }
}

fn resolve_against_colliders(
    position: &Vector3,
    colliders: &[ArenaCollider],
) -> Vector3 {
    let mut resolved = position.clone();
    for _pass in 0..2 {
        let mut moved = false;
        for collider in colliders {
            if let Some((push_x, push_z)) = penetration_push_out(&resolved, collider) {
                resolved.x += push_x;
                resolved.z += push_z;
                moved = true;
            }
        }
        if !moved {
            break;
        }
    }
    resolved
}

fn penetration_push_out(
    position: &Vector3,
    collider: &ArenaCollider,
) -> Option<(f32, f32)> {
    let dx = position.x - collider.center[0];
    let dz = position.z - collider.center[2];

    match &collider.shape {
        ColliderShape::Cylinder { radius } => {
            let combined_radius = *radius + PLAYER_COLLISION_RADIUS;
            let distance = (dx * dx + dz * dz).sqrt();
            if distance >= combined_radius {
                return None;
            }
            if distance <= f32::EPSILON {
                return Some((combined_radius, 0.0));
            }

            let penetration = combined_radius - distance;
            Some((dx / distance * penetration, dz / distance * penetration))
        }
        ColliderShape::Box { half_extents, yaw } => {
            let inverse_yaw = -*yaw;
            let inverse_cos = inverse_yaw.cos();
            let inverse_sin = inverse_yaw.sin();
            let local_x = dx * inverse_cos - dz * inverse_sin;
            let local_z = dx * inverse_sin + dz * inverse_cos;
            let overlap_x =
                half_extents[0] + PLAYER_COLLISION_RADIUS - local_x.abs();
            let overlap_z =
                half_extents[2] + PLAYER_COLLISION_RADIUS - local_z.abs();
            if overlap_x <= 0.0 || overlap_z <= 0.0 {
                return None;
            }

            let (local_push_x, local_push_z) = if overlap_x <= overlap_z {
                (away_from_center_sign(local_x) * overlap_x, 0.0)
            } else {
                (0.0, away_from_center_sign(local_z) * overlap_z)
            };
            let cos_yaw = yaw.cos();
            let sin_yaw = yaw.sin();
            Some((
                local_push_x * cos_yaw - local_push_z * sin_yaw,
                local_push_x * sin_yaw + local_push_z * cos_yaw,
            ))
        }
    }
}

fn away_from_center_sign(value: f32) -> f32 {
    if value < 0.0 { -1.0 } else { 1.0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(left: f32, right: f32) {
        assert!((left - right).abs() < 0.0001, "{left} != {right}");
    }

    #[test]
    fn clamps_player_inside_world_bounds() {
        let current = Vector3::zero();
        let desired = Vector3 {
            x: 10000.0,
            y: 2.0,
            z: -10000.0,
        };

        let resolved = resolve_player_movement(&current, &desired).position;

        assert_close(
            resolved.x,
            ARENA_BOUNDS.max_x - PLAYER_COLLISION_RADIUS,
        );
        assert_close(resolved.y, 2.0);
        assert_close(
            resolved.z,
            ARENA_BOUNDS.min_z + PLAYER_COLLISION_RADIUS,
        );
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
    fn box_push_out_uses_the_shallow_open_axis() {
        let blocker = ArenaCollider {
            id: "synthetic_box",
            center: [0.0, 0.0, 0.0],
            shape: ColliderShape::Box {
                half_extents: [0.5, 1.0, 0.5],
                yaw: 0.0,
            },
        };
        let position = Vector3 {
            x: 0.8,
            y: 3.0,
            z: 0.2,
        };

        let (push_x, push_z) =
            penetration_push_out(&position, &blocker).expect("position should penetrate box");

        assert_close(push_x, 0.15);
        assert_close(push_z, 0.0);
    }

    #[test]
    fn two_blockers_push_out_on_both_axes() {
        let blockers = [
            ArenaCollider {
                id: "x_blocker",
                center: [0.0, 0.0, 0.0],
                shape: ColliderShape::Box {
                    half_extents: [0.5, 1.0, 5.0],
                    yaw: 0.0,
                },
            },
            ArenaCollider {
                id: "z_blocker",
                center: [0.0, 0.0, 0.0],
                shape: ColliderShape::Box {
                    half_extents: [5.0, 1.0, 0.5],
                    yaw: 0.0,
                },
            },
        ];
        let position = Vector3 {
            x: 0.2,
            y: 0.0,
            z: 0.2,
        };

        let resolved = resolve_against_colliders(&position, &blockers);

        assert_close(resolved.x, 0.95);
        assert_close(resolved.z, 0.95);
    }

    #[test]
    fn collider_push_out_keeps_vertical_motion() {
        let blocker = ArenaCollider {
            id: "synthetic_box",
            center: [0.0, 0.0, 0.0],
            shape: ColliderShape::Box {
                half_extents: [0.5, 1.0, 0.5],
                yaw: 0.0,
            },
        };
        let position = Vector3 {
            x: 0.8,
            y: 3.0,
            z: 0.2,
        };

        let resolved = resolve_against_colliders(&position, &[blocker]);

        assert_close(resolved.x, 0.95);
        assert_close(resolved.y, 3.0);
        assert_close(resolved.z, 0.2);
    }

    #[test]
    fn rotated_box_push_out_returns_to_world_space() {
        let blocker = ArenaCollider {
            id: "rotated_box",
            center: [0.0, 0.0, 0.0],
            shape: ColliderShape::Box {
                half_extents: [0.5, 1.0, 0.5],
                yaw: std::f32::consts::FRAC_PI_2,
            },
        };
        let position = Vector3 {
            x: 0.2,
            y: 0.0,
            z: 0.8,
        };

        let (push_x, push_z) =
            penetration_push_out(&position, &blocker).expect("position should penetrate box");

        assert_close(push_x, 0.0);
        assert_close(push_z, 0.15);
    }

    #[test]
    fn wall_n_stops_movement_at_its_edge() {
        let current = Vector3::zero();
        let desired = Vector3 {
            x: 0.0,
            y: 0.0,
            z: -30.0,
        };

        let resolved = resolve_player_movement(&current, &desired).position;

        assert_close(resolved.x, 0.0);
        assert_close(resolved.z, -19.55);
    }

    #[test]
    fn pillar_nw_pushes_player_radially_outward() {
        let current = Vector3::zero();
        let desired = Vector3 {
            x: -10.5,
            y: 0.0,
            z: -10.0,
        };

        let resolved = resolve_player_movement(&current, &desired).position;

        assert_close(resolved.x, -11.35);
        assert_close(resolved.z, -10.0);
    }

    #[test]
    fn open_middle_of_arena_is_unaffected() {
        let position = Vector3 {
            x: 2.5,
            y: 1.0,
            z: -3.5,
        };

        let resolved = resolve_player_movement(&Vector3::zero(), &position).position;

        assert_eq!(resolved, position);
    }

    #[test]
    fn corner_is_clamped_on_both_axes() {
        let desired = Vector3 {
            x: 100.0,
            y: 0.0,
            z: -100.0,
        };

        let resolved = resolve_player_movement(&Vector3::zero(), &desired).position;

        assert_close(resolved.x, 19.55);
        assert_close(resolved.z, -19.55);
    }
}
