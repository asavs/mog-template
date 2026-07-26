// GENERATED FILE — edit shared/arena.json and run npm run gen:arena
// Source: shared/arena.json
// Included directly into collision.rs via `include!("arena.generated.rs")` — no `mod` needed.
// NOTE: this file is spliced into collision.rs by `include!`, not compiled as its own
// module, so it cannot use inner (`#![...]`) attributes — only outer (`#[...]`) ones.

#[allow(dead_code)]
pub const GROUND_Y: f32 = 0.0;

#[allow(dead_code)]
pub struct ArenaBounds {
    pub min_x: f32,
    pub max_x: f32,
    pub min_z: f32,
    pub max_z: f32,
}

pub const ARENA_BOUNDS: ArenaBounds = ArenaBounds { min_x: -20.0, max_x: 20.0, min_z: -20.0, max_z: 20.0 };

#[allow(dead_code)]
pub struct ArenaSpawn {
    pub position: [f32; 3],
    pub yaw: f32,
}

#[allow(dead_code)]
pub const ARENA_SPAWNS: &[ArenaSpawn] = &[
    ArenaSpawn { position: [0.0, 0.0, -14.0], yaw: 0.0 },
    ArenaSpawn { position: [0.0, 0.0, 14.0], yaw: 3.14159 },
    ArenaSpawn { position: [-14.0, 0.0, 0.0], yaw: 1.5708 },
    ArenaSpawn { position: [14.0, 0.0, 0.0], yaw: -1.5708 },
];

pub enum ColliderShape {
    Box { half_extents: [f32; 3], yaw: f32 },
    Cylinder { radius: f32 },
}

pub struct ArenaCollider {
    #[allow(dead_code)]
    pub id: &'static str,
    pub center: [f32; 3],
    pub shape: ColliderShape,
}

pub const ARENA_COLLIDERS: &[ArenaCollider] = &[
    ArenaCollider { id: "wall_n", center: [0.0, 0.0, -20.5], shape: ColliderShape::Box { half_extents: [21.0, 2.0, 0.5], yaw: 0.0 } },
    ArenaCollider { id: "wall_s", center: [0.0, 0.0, 20.5], shape: ColliderShape::Box { half_extents: [21.0, 2.0, 0.5], yaw: 0.0 } },
    ArenaCollider { id: "wall_w", center: [-20.5, 0.0, 0.0], shape: ColliderShape::Box { half_extents: [0.5, 2.0, 21.0], yaw: 0.0 } },
    ArenaCollider { id: "wall_e", center: [20.5, 0.0, 0.0], shape: ColliderShape::Box { half_extents: [0.5, 2.0, 21.0], yaw: 0.0 } },
    ArenaCollider { id: "pillar_nw", center: [-10.0, 0.0, -10.0], shape: ColliderShape::Cylinder { radius: 0.9 } },
    ArenaCollider { id: "pillar_ne", center: [10.0, 0.0, -10.0], shape: ColliderShape::Cylinder { radius: 0.9 } },
    ArenaCollider { id: "pillar_sw", center: [-10.0, 0.0, 10.0], shape: ColliderShape::Cylinder { radius: 0.9 } },
    ArenaCollider { id: "pillar_se", center: [10.0, 0.0, 10.0], shape: ColliderShape::Cylinder { radius: 0.9 } },
];

