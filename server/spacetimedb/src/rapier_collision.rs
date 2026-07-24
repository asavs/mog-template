use crate::castle_collision::{self, CapsuleMoveResult};
use crate::common::{DELTA_TIME, Vector3};
use rapier3d::control::{CharacterLength, KinematicCharacterController};
use rapier3d::prelude::*;
use std::sync::OnceLock;

static RAPIER_CASTLE: OnceLock<Option<RapierCastleWorld>> = OnceLock::new();

struct RapierCastleWorld {
    bodies: RigidBodySet,
    colliders: ColliderSet,
    broad_phase: BroadPhaseBvh,
    narrow_phase: NarrowPhase,
    controller: KinematicCharacterController,
}

pub fn resolve_capsule_sweep(
    current: &Vector3,
    desired: &Vector3,
    radius: f32,
    height: f32,
) -> Option<CapsuleMoveResult> {
    let world = rapier_castle_world()?;
    if !vector3_is_finite(current) || !vector3_is_finite(desired) || !is_valid_capsule(radius, height) {
        return Some(CapsuleMoveResult {
            position: safe_move_position(current, desired),
            ground_normal: None,
            hit_ceiling: false,
            hit_wall: false,
        });
    }

    let desired_translation = vector![
        desired.x - current.x,
        desired.y - current.y,
        desired.z - current.z,
    ];
    let capsule = SharedShape::capsule_y(capsule_segment_half_height(radius, height), radius);
    let character_pos = Pose::from_translation(vector![
        current.x,
        current.y + height * 0.5,
        current.z,
    ]);
    let query_pipeline = world.broad_phase.as_query_pipeline(
        world.narrow_phase.query_dispatcher(),
        &world.bodies,
        &world.colliders,
        QueryFilter::default(),
    );

    let mut collisions = Vec::new();
    let movement = world.controller.move_shape(
        DELTA_TIME,
        &query_pipeline,
        capsule.as_ref(),
        &character_pos,
        desired_translation,
        |collision| collisions.push(collision),
    );

    let position = Vector3 {
        x: current.x + movement.translation.x,
        y: current.y + movement.translation.y,
        z: current.z + movement.translation.z,
    };
    let mut ground_normal = if movement.grounded {
        Some(Vector3 { x: 0.0, y: 1.0, z: 0.0 })
    } else {
        None
    };
    let mut hit_ceiling = false;
    let mut hit_wall = false;
    for collision in collisions {
        let normal = collision.hit.normal1;
        if normal.y >= castle_collision::MIN_WALKABLE_NORMAL_Y && desired_translation.y <= 0.0 {
            ground_normal = Some(Vector3 { x: normal.x, y: normal.y, z: normal.z });
        }
        if normal.y < -castle_collision::CAPSULE_SKIN && desired_translation.y > 0.0 {
            hit_ceiling = true;
        }
        if normal.y.abs() < castle_collision::MIN_WALKABLE_NORMAL_Y {
            hit_wall = true;
        }
    }

    Some(CapsuleMoveResult { position, ground_normal, hit_ceiling, hit_wall })
}

pub fn snap_capsule_down(
    position: &Vector3,
    max_distance: f32,
    radius: f32,
    height: f32,
) -> Option<CapsuleMoveResult> {
    let desired = Vector3 { x: position.x, y: position.y - max_distance, z: position.z };
    resolve_capsule_sweep(position, &desired, radius, height)
}

fn rapier_castle_world() -> Option<&'static RapierCastleWorld> {
    RAPIER_CASTLE
        .get_or_init(build_rapier_castle_world)
        .as_ref()
}

fn build_rapier_castle_world() -> Option<RapierCastleWorld> {
    let asset = castle_collision::castle_collision();
    let vertices = asset
        .vertices
        .chunks_exact(3)
        .map(|vertex| vector![vertex[0], vertex[1], vertex[2]])
        .collect::<Vec<_>>();
    let indices = asset
        .indices
        .chunks_exact(3)
        .map(|triangle| [triangle[0], triangle[1], triangle[2]])
        .collect::<Vec<_>>();
    let tri_mesh_flags = TriMeshFlags::FIX_INTERNAL_EDGES
        | TriMeshFlags::DELETE_DEGENERATE_TRIANGLES
        | TriMeshFlags::DELETE_DUPLICATE_TRIANGLES;
    let collider = match ColliderBuilder::trimesh_with_flags(vertices, indices, tri_mesh_flags) {
        Ok(builder) => builder.build(),
        Err(error) => {
            spacetimedb::log::warn!("Rapier castle trimesh build failed; falling back to custom controller: {:?}", error);
            return None;
        }
    };

    let mut bodies = RigidBodySet::new();
    let mut colliders = ColliderSet::new();
    let mut broad_phase = BroadPhaseBvh::new();
    let mut narrow_phase = NarrowPhase::new();
    colliders.insert(collider);
    PhysicsPipeline::new().step(
        &Vector::ZERO,
        &IntegrationParameters::default(),
        &mut IslandManager::new(),
        &mut broad_phase,
        &mut narrow_phase,
        &mut bodies,
        &mut colliders,
        &mut ImpulseJointSet::new(),
        &mut MultibodyJointSet::new(),
        &mut CCDSolver::new(),
        &(),
        &(),
    );

    Some(RapierCastleWorld {
        bodies,
        colliders,
        broad_phase,
        narrow_phase,
        controller: KinematicCharacterController {
            up: Vector::Y,
            offset: CharacterLength::Absolute(castle_collision::CAPSULE_SKIN),
            slide: true,
            autostep: None,
            max_slope_climb_angle: 60.0_f32.to_radians(),
            min_slope_slide_angle: 60.0_f32.to_radians(),
            snap_to_ground: Some(CharacterLength::Absolute(castle_collision::GROUND_SNAP_DISTANCE)),
            normal_nudge_factor: castle_collision::CAPSULE_SKIN,
        },
    })
}

fn capsule_segment_half_height(radius: f32, height: f32) -> f32 {
    ((height - radius * 2.0) * 0.5).max(0.0)
}

fn vector3_is_finite(value: &Vector3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

fn is_valid_capsule(radius: f32, height: f32) -> bool {
    radius.is_finite() && height.is_finite() && radius > 0.0 && height >= radius * 2.0
}

fn safe_move_position(current: &Vector3, desired: &Vector3) -> Vector3 {
    if vector3_is_finite(current) {
        current.clone()
    } else if vector3_is_finite(desired) {
        desired.clone()
    } else {
        Vector3::zero()
    }
}
