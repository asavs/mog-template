use crate::common::Vector3;
use std::sync::OnceLock;

const MAGIC: &[u8; 4] = b"CC01";
const VERSION: u32 = 1;
const HEADER_BYTES: usize = 232;

/// Canonical transformed triangles for `Castle Collision.002`, baked from the active map GLB.
/// The grid selects deterministic broad-phase candidates only; callers must run narrow phase
/// against `vertices` and `indices` for every returned id.
static CASTLE_COLLISION_BIN: &[u8] = include_bytes!("castle_collision.bin");

pub struct CastleCollisionData {
    pub min: [f32; 3],
    pub max: [f32; 3],
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    grid_x: usize,
    grid_y: usize,
    grid_z: usize,
    offsets: Vec<u32>,
    triangle_ids: Vec<u32>,
}

static CASTLE_COLLISION: OnceLock<CastleCollisionData> = OnceLock::new();

pub const CAPSULE_SKIN: f32 = 0.002;
/// cos(70°), kept in sync with `client/src/castleController.ts`.
pub const MIN_WALKABLE_NORMAL_Y: f32 = 0.34202015;
const CONTACT_EPSILON: f32 = 0.0001;
const MAX_SLIDE_ITERATIONS: usize = 4;
const MAX_SUBSTEP_DISTANCE: f32 = 0.2;

#[derive(Clone, Debug)]
pub struct CapsuleMoveResult {
    pub position: Vector3,
    pub ground_normal: Option<Vector3>,
}

pub fn castle_collision() -> &'static CastleCollisionData {
    CASTLE_COLLISION.get_or_init(|| {
        parse_castle_collision_bin(CASTLE_COLLISION_BIN).expect("valid embedded castle_collision.bin")
    })
}

fn parse_castle_collision_bin(bytes: &[u8]) -> Result<CastleCollisionData, String> {
    if bytes.len() < HEADER_BYTES {
        return Err("castle_collision.bin too short".into());
    }
    if &bytes[0..4] != MAGIC {
        return Err("bad castle collision magic".into());
    }
    if read_u32(bytes, 4)? != VERSION {
        return Err("unsupported castle collision version".into());
    }
    if read_u32(bytes, 8)? as usize != HEADER_BYTES {
        return Err("unexpected castle collision header size".into());
    }
    let vertex_count = read_u32(bytes, 12)? as usize;
    let triangle_count = read_u32(bytes, 16)? as usize;
    let grid_x = read_u32(bytes, 20)? as usize;
    let grid_y = read_u32(bytes, 24)? as usize;
    let grid_z = read_u32(bytes, 28)? as usize;
    if vertex_count == 0 || triangle_count == 0 || grid_x == 0 || grid_y == 0 || grid_z == 0 {
        return Err("castle collision has an empty mesh or grid".into());
    }
    let min = [read_f32(bytes, 32)?, read_f32(bytes, 36)?, read_f32(bytes, 40)?];
    let max = [read_f32(bytes, 44)?, read_f32(bytes, 48)?, read_f32(bytes, 52)?];
    let cell_count = grid_x
        .checked_mul(grid_y)
        .and_then(|value| value.checked_mul(grid_z))
        .ok_or("castle collision grid dimensions overflow")?;
    let vertices_offset = HEADER_BYTES;
    let indices_offset = vertices_offset
        .checked_add(vertex_count.checked_mul(12).ok_or("castle collision vertices overflow")?)
        .ok_or("castle collision indices offset overflow")?;
    let offsets_offset = indices_offset
        .checked_add(triangle_count.checked_mul(12).ok_or("castle collision indices overflow")?)
        .ok_or("castle collision offsets overflow")?;
    let triangle_ids_offset = offsets_offset
        .checked_add((cell_count + 1).checked_mul(4).ok_or("castle collision offsets overflow")?)
        .ok_or("castle collision triangle ids offset overflow")?;
    if bytes.len() < triangle_ids_offset {
        return Err("castle_collision.bin truncated before grid offsets".into());
    }
    let triangle_id_count = read_u32(bytes, offsets_offset + cell_count * 4)? as usize;
    let required_bytes = triangle_ids_offset
        .checked_add(triangle_id_count.checked_mul(4).ok_or("castle collision triangle ids overflow")?)
        .ok_or("castle collision binary length overflow")?;
    if bytes.len() < required_bytes {
        return Err("castle_collision.bin truncated".into());
    }

    let vertices = read_u32_values(bytes, vertices_offset, vertex_count * 3)?
        .into_iter()
        .map(f32::from_bits)
        .collect();
    let indices = read_u32_values(bytes, indices_offset, triangle_count * 3)?;
    let offsets = read_u32_values(bytes, offsets_offset, cell_count + 1)?;
    let triangle_ids = read_u32_values(bytes, triangle_ids_offset, triangle_id_count)?;
    if offsets.last().copied() != Some(triangle_ids.len() as u32) {
        return Err("castle collision final grid offset does not match triangle ids".into());
    }
    if offsets.windows(2).any(|pair| pair[0] > pair[1]) {
        return Err("castle collision grid offsets are not monotonic".into());
    }
    if indices.iter().any(|&index| index as usize >= vertex_count) {
        return Err("castle collision index outside vertex array".into());
    }
    if triangle_ids.iter().any(|&id| id as usize >= triangle_count) {
        return Err("castle collision grid references a missing triangle".into());
    }

    Ok(CastleCollisionData { min, max, vertices, indices, grid_x, grid_y, grid_z, offsets, triangle_ids })
}

impl CastleCollisionData {
    /// Candidate triangle ids are ascending after deduplication, ensuring a stable narrow-phase order.
    pub fn triangle_candidates(&self, min: [f32; 3], max: [f32; 3]) -> Vec<u32> {
        if max[0] < self.min[0] || min[0] > self.max[0]
            || max[1] < self.min[1] || min[1] > self.max[1]
            || max[2] < self.min[2] || min[2] > self.max[2]
        {
            return Vec::new();
        }
        let start = [
            self.grid_coordinate(min[0], self.min[0], self.max[0], self.grid_x),
            self.grid_coordinate(min[1], self.min[1], self.max[1], self.grid_y),
            self.grid_coordinate(min[2], self.min[2], self.max[2], self.grid_z),
        ];
        let end = [
            self.grid_coordinate(max[0], self.min[0], self.max[0], self.grid_x),
            self.grid_coordinate(max[1], self.min[1], self.max[1], self.grid_y),
            self.grid_coordinate(max[2], self.min[2], self.max[2], self.grid_z),
        ];
        let mut candidates = Vec::new();
        for z in start[2]..=end[2] {
            for y in start[1]..=end[1] {
                for x in start[0]..=end[0] {
                    let cell = (z * self.grid_y + y) * self.grid_x + x;
                    candidates.extend_from_slice(&self.triangle_ids[self.offsets[cell] as usize..self.offsets[cell + 1] as usize]);
                }
            }
        }
        candidates.sort_unstable();
        candidates.dedup();
        candidates
    }

    fn grid_coordinate(&self, value: f32, min: f32, max: f32, dimension: usize) -> usize {
        if value <= min { return 0; }
        if value >= max { return dimension - 1; }
        ((((value - min) / (max - min)) * dimension as f32).floor() as usize)
            .min(dimension - 1)
    }
}

/// Fixed-order capsule sweep-and-slide against the baked castle triangles.
/// Broad-phase candidates are grid selected; every contact below is triangle narrow phase.
pub fn resolve_capsule_sweep(
    current: &Vector3,
    desired: &Vector3,
    radius: f32,
    height: f32,
) -> CapsuleMoveResult {
    let mut position = Point::from(current);
    let target = Point::from(desired);
    let mut remaining = target - position;
    let mut ground_normal = None;

    for _ in 0..MAX_SLIDE_ITERATIONS {
        let distance = remaining.length();
        if distance <= CONTACT_EPSILON {
            break;
        }
        let steps = (distance / MAX_SUBSTEP_DISTANCE).ceil().clamp(1.0, 32.0) as usize;
        let start = position;
        let mut previous = position;
        let mut hit = None;
        for step in 1..=steps {
            let candidate = start + remaining * (step as f32 / steps as f32);
            if let Some(contact) = capsule_contact(candidate, radius, height, remaining) {
                hit = Some((previous, candidate, contact));
                break;
            }
            previous = candidate;
        }
        let Some((safe, blocked, contact)) = hit else {
            position = target;
            break;
        };

        let mut low = safe;
        let mut high = blocked;
        for _ in 0..8 {
            let middle = (low + high) * 0.5;
            if capsule_contact(middle, radius, height, remaining).is_some() {
                high = middle;
            } else {
                low = middle;
            }
        }
        position = low + contact.normal * CAPSULE_SKIN;
        if contact.normal.y >= MIN_WALKABLE_NORMAL_Y {
            ground_normal = Some(contact.normal.into());
        }
        remaining = target - position;
        let into_surface = remaining.dot(contact.normal);
        if into_surface < 0.0 {
            remaining = remaining - contact.normal * into_surface;
        }
    }

    CapsuleMoveResult { position: position.into(), ground_normal }
}

pub fn snap_capsule_down(position: &Vector3, max_distance: f32, radius: f32, height: f32) -> CapsuleMoveResult {
    let desired = Vector3 { x: position.x, y: position.y - max_distance, z: position.z };
    resolve_capsule_sweep(position, &desired, radius, height)
}

#[derive(Clone, Copy)]
struct Contact {
    normal: Point,
    penetration: f32,
}

fn capsule_contact(position: Point, radius: f32, height: f32, motion: Point) -> Option<Contact> {
    let asset = castle_collision();
    let segment_start = position + Point::new(0.0, radius, 0.0);
    let segment_end = position + Point::new(0.0, height - radius, 0.0);
    let query_min = Point::min(segment_start, segment_end) - Point::splat(radius);
    let query_max = Point::max(segment_start, segment_end) + Point::splat(radius);
    let mut deepest: Option<Contact> = None;
    for triangle_id in asset.triangle_candidates(
        [query_min.x, query_min.y, query_min.z],
        [query_max.x, query_max.y, query_max.z],
    ) {
        let base = triangle_id as usize * 3;
        let a = vertex(asset, asset.indices[base]);
        let b = vertex(asset, asset.indices[base + 1]);
        let c = vertex(asset, asset.indices[base + 2]);
        let (segment_point, triangle_point) = closest_segment_triangle(segment_start, segment_end, a, b, c);
        let delta = segment_point - triangle_point;
        let distance = delta.length();
        let penetration = radius - distance;
        if penetration <= CONTACT_EPSILON {
            continue;
        }
        let mut normal = if distance > CONTACT_EPSILON { delta * (1.0 / distance) } else { (b - a).cross(c - a).normalized() };
        if normal.dot((segment_start + segment_end) * 0.5 - (a + b + c) * (1.0 / 3.0)) < 0.0 {
            normal = normal * -1.0;
        }
        if normal.length() <= CONTACT_EPSILON {
            normal = motion.normalized() * -1.0;
        }
        let contact = Contact { normal, penetration };
        if deepest.map(|existing| contact.penetration > existing.penetration).unwrap_or(true) {
            deepest = Some(contact);
        }
    }
    deepest
}

fn vertex(asset: &CastleCollisionData, index: u32) -> Point {
    let base = index as usize * 3;
    Point::new(asset.vertices[base], asset.vertices[base + 1], asset.vertices[base + 2])
}

/// Exact closest feature search for a segment against a triangle: endpoints/face and all edges.
/// A non-intersecting segment's nearest feature is one of these; plane intersection is handled first.
fn closest_segment_triangle(start: Point, end: Point, a: Point, b: Point, c: Point) -> (Point, Point) {
    if let Some(hit) = segment_triangle_intersection(start, end, a, b, c) {
        return (hit, hit);
    }
    let mut best = (start, closest_point_triangle(start, a, b, c));
    let mut best_distance = (best.0 - best.1).length_squared();
    for point in [end] {
        let candidate = (point, closest_point_triangle(point, a, b, c));
        let distance = (candidate.0 - candidate.1).length_squared();
        if distance < best_distance { best = candidate; best_distance = distance; }
    }
    for (edge_start, edge_end) in [(a, b), (b, c), (c, a)] {
        let candidate = closest_segment_segment(start, end, edge_start, edge_end);
        let distance = (candidate.0 - candidate.1).length_squared();
        if distance < best_distance { best = candidate; best_distance = distance; }
    }
    best
}

fn segment_triangle_intersection(start: Point, end: Point, a: Point, b: Point, c: Point) -> Option<Point> {
    let normal = (b - a).cross(c - a);
    let denominator = normal.dot(end - start);
    if denominator.abs() <= CONTACT_EPSILON { return None; }
    let t = normal.dot(a - start) / denominator;
    if !(0.0..=1.0).contains(&t) { return None; }
    let point = start + (end - start) * t;
    point_in_triangle(point, a, b, c).then_some(point)
}

fn point_in_triangle(point: Point, a: Point, b: Point, c: Point) -> bool {
    let ab = (b - a).cross(point - a);
    let bc = (c - b).cross(point - b);
    let ca = (a - c).cross(point - c);
    let normal = (b - a).cross(c - a);
    ab.dot(normal) >= -CONTACT_EPSILON && bc.dot(normal) >= -CONTACT_EPSILON && ca.dot(normal) >= -CONTACT_EPSILON
}

fn closest_point_triangle(point: Point, a: Point, b: Point, c: Point) -> Point {
    let ab = b - a; let ac = c - a; let ap = point - a;
    let d1 = ab.dot(ap); let d2 = ac.dot(ap);
    if d1 <= 0.0 && d2 <= 0.0 { return a; }
    let bp = point - b; let d3 = ab.dot(bp); let d4 = ac.dot(bp);
    if d3 >= 0.0 && d4 <= d3 { return b; }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 { return a + ab * (d1 / (d1 - d3)); }
    let cp = point - c; let d5 = ab.dot(cp); let d6 = ac.dot(cp);
    if d6 >= 0.0 && d5 <= d6 { return c; }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 { return a + ac * (d2 / (d2 - d6)); }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 { return b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6))); }
    let denominator = 1.0 / (va + vb + vc);
    a + ab * (vb * denominator) + ac * (vc * denominator)
}

fn closest_segment_segment(a0: Point, a1: Point, b0: Point, b1: Point) -> (Point, Point) {
    let d1 = a1 - a0; let d2 = b1 - b0; let r = a0 - b0;
    let a = d1.dot(d1); let e = d2.dot(d2); let f = d2.dot(r);
    let (mut s, mut t);
    if a <= CONTACT_EPSILON && e <= CONTACT_EPSILON { return (a0, b0); }
    if a <= CONTACT_EPSILON { s = 0.0; t = (f / e).clamp(0.0, 1.0); }
    else {
        let c = d1.dot(r);
        if e <= CONTACT_EPSILON { t = 0.0; s = (-c / a).clamp(0.0, 1.0); }
        else {
            let b = d1.dot(d2); let denominator = a * e - b * b;
            s = if denominator.abs() > CONTACT_EPSILON { ((b * f - c * e) / denominator).clamp(0.0, 1.0) } else { 0.0 };
            t = (b * s + f) / e;
            if t < 0.0 { t = 0.0; s = (-c / a).clamp(0.0, 1.0); }
            else if t > 1.0 { t = 1.0; s = ((b - c) / a).clamp(0.0, 1.0); }
        }
    }
    (a0 + d1 * s, b0 + d2 * t)
}

#[derive(Clone, Copy)]
struct Point { x: f32, y: f32, z: f32 }
impl Point {
    const fn new(x: f32, y: f32, z: f32) -> Self { Self { x, y, z } }
    const fn splat(value: f32) -> Self { Self::new(value, value, value) }
    fn min(a: Self, b: Self) -> Self { Self::new(a.x.min(b.x), a.y.min(b.y), a.z.min(b.z)) }
    fn max(a: Self, b: Self) -> Self { Self::new(a.x.max(b.x), a.y.max(b.y), a.z.max(b.z)) }
    fn dot(self, other: Self) -> f32 { self.x * other.x + self.y * other.y + self.z * other.z }
    fn cross(self, other: Self) -> Self { Self::new(self.y * other.z - self.z * other.y, self.z * other.x - self.x * other.z, self.x * other.y - self.y * other.x) }
    fn length_squared(self) -> f32 { self.dot(self) }
    fn length(self) -> f32 { self.length_squared().sqrt() }
    fn normalized(self) -> Self { let length = self.length(); if length > CONTACT_EPSILON { self * (1.0 / length) } else { Self::new(0.0, 1.0, 0.0) } }
}
impl From<&Vector3> for Point { fn from(value: &Vector3) -> Self { Self::new(value.x, value.y, value.z) } }
impl From<Point> for Vector3 { fn from(value: Point) -> Self { Self { x: value.x, y: value.y, z: value.z } } }
impl std::ops::Add for Point { type Output = Self; fn add(self, rhs: Self) -> Self { Self::new(self.x + rhs.x, self.y + rhs.y, self.z + rhs.z) } }
impl std::ops::Sub for Point { type Output = Self; fn sub(self, rhs: Self) -> Self { Self::new(self.x - rhs.x, self.y - rhs.y, self.z - rhs.z) } }
impl std::ops::Mul<f32> for Point { type Output = Self; fn mul(self, rhs: f32) -> Self { Self::new(self.x * rhs, self.y * rhs, self.z * rhs) } }

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let end = offset.checked_add(4).ok_or("castle collision offset overflow")?;
    let slice: [u8; 4] = bytes.get(offset..end).ok_or("castle collision read out of bounds")?.try_into().map_err(|_| "invalid castle collision u32")?;
    Ok(u32::from_le_bytes(slice))
}

fn read_f32(bytes: &[u8], offset: usize) -> Result<f32, String> {
    Ok(f32::from_bits(read_u32(bytes, offset)?))
}

fn read_u32_values(bytes: &[u8], offset: usize, count: usize) -> Result<Vec<u32>, String> {
    (0..count).map(|index| read_u32(bytes, offset + index * 4)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_asset_has_exact_triangle_data_and_a_nonempty_grid() {
        let data = castle_collision();
        assert!(data.vertices.len() > 100_000);
        assert!(data.indices.len() > 100_000);
        assert!(data.max[0] > data.min[0]);
        assert!(data.max[1] > data.min[1]);
        assert!(data.max[2] > data.min[2]);
    }

    #[test]
    fn broad_phase_returns_stably_sorted_ids_inside_castle_bounds() {
        let data = castle_collision();
        let candidates = data.triangle_candidates(data.min, data.max);
        assert!(!candidates.is_empty());
        assert!(candidates.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn narrow_phase_uses_triangle_face_not_a_bounding_box() {
        let a = Point::new(-1.0, 0.0, -1.0);
        let b = Point::new(1.0, 0.0, -1.0);
        let c = Point::new(0.0, 0.0, 1.0);
        let (on_capsule, on_triangle) = closest_segment_triangle(
            Point::new(0.0, 2.0, 0.0),
            Point::new(0.0, 1.0, 0.0),
            a,
            b,
            c,
        );
        assert!(((on_capsule - on_triangle).length() - 1.0).abs() < 0.0001);

        let (outside_capsule, outside_triangle) = closest_segment_triangle(
            Point::new(1.0, 2.0, 1.0),
            Point::new(1.0, 1.0, 1.0),
            a,
            b,
            c,
        );
        assert!((outside_capsule - outside_triangle).length() > 1.0);
    }

    #[test]
    fn walkable_normal_matches_the_seventy_degree_slope_limit() {
        assert!((MIN_WALKABLE_NORMAL_Y - 0.34202015).abs() < 0.000001);
    }
}
