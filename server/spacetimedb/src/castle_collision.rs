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
        (((value - min) / (max - min)) * dimension as f32).floor() as usize
    }
}

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
}
