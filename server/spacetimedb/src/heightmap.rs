use crate::common::Vector3;
use std::sync::OnceLock;

/// Expected grid size written by `scripts/bake-terrain-collision.mjs`.
pub const HEIGHTMAP_SIZE: usize = 513;
pub const TERRAIN_MAX_WALKABLE_SLOPE_DEGREES: f32 = 70.0;

const TERRAIN_MAX_WALKABLE_SLOPE: f32 = 2.74747742; // tan(70 degrees)

/// Baked collision surface (HM01). Produced by `scripts/bake-terrain-collision.mjs`.
/// World bounds are read from the binary header so re-bakes cannot desync constants.
static HEIGHTMAP_BIN: &[u8] = include_bytes!("heightmap.bin");

struct HeightmapData {
    min_x: f32,
    max_x: f32,
    min_z: f32,
    max_z: f32,
    heights: Vec<f32>,
    walkable: Vec<u8>,
}

static HEIGHTMAP: OnceLock<HeightmapData> = OnceLock::new();

fn heightmap() -> &'static HeightmapData {
    HEIGHTMAP.get_or_init(|| parse_heightmap_bin(HEIGHTMAP_BIN).expect("valid embedded heightmap.bin"))
}

fn parse_heightmap_bin(bytes: &[u8]) -> Result<HeightmapData, String> {
    if bytes.len() < 32 {
        return Err("heightmap.bin too short".into());
    }
    if &bytes[0..4] != b"HM01" {
        return Err("bad heightmap magic".into());
    }
    let size = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    if size != HEIGHTMAP_SIZE {
        return Err(format!("heightmap size {size} != {HEIGHTMAP_SIZE}"));
    }

    let min_x = f32::from_le_bytes(bytes[8..12].try_into().unwrap());
    let max_x = f32::from_le_bytes(bytes[12..16].try_into().unwrap());
    let min_z = f32::from_le_bytes(bytes[16..20].try_into().unwrap());
    let max_z = f32::from_le_bytes(bytes[20..24].try_into().unwrap());
    // bytes 24..32 are minH/maxH — unused for sampling UV

    let count = size * size;
    let heights_offset = 8 + 24;
    let walk_offset = heights_offset + count * 4;
    let walk_bytes = count.div_ceil(8);
    if bytes.len() < walk_offset + walk_bytes {
        return Err("heightmap.bin truncated".into());
    }

    let mut heights = Vec::with_capacity(count);
    for i in 0..count {
        let start = heights_offset + i * 4;
        heights.push(f32::from_le_bytes(bytes[start..start + 4].try_into().unwrap()));
    }

    Ok(HeightmapData {
        min_x,
        max_x,
        min_z,
        max_z,
        heights,
        walkable: bytes[walk_offset..walk_offset + walk_bytes].to_vec(),
    })
}

pub fn terrain_height_at(position: &Vector3) -> f32 {
    sample_height(position.x, position.z)
}

pub fn sample_height(x: f32, z: f32) -> f32 {
    let hm = heightmap();
    let u = ((x - hm.min_x) / (hm.max_x - hm.min_x)).clamp(0.0, 1.0);
    let v = ((z - hm.min_z) / (hm.max_z - hm.min_z)).clamp(0.0, 1.0);
    let gx = u * (HEIGHTMAP_SIZE as f32 - 1.0);
    let gz = v * (HEIGHTMAP_SIZE as f32 - 1.0);
    let x0 = gx.floor() as usize;
    let z0 = gz.floor() as usize;
    let x1 = (x0 + 1).min(HEIGHTMAP_SIZE - 1);
    let z1 = (z0 + 1).min(HEIGHTMAP_SIZE - 1);
    let tx = gx - x0 as f32;
    let tz = gz - z0 as f32;
    let h00 = height_at_index(x0, z0);
    let h10 = height_at_index(x1, z0);
    let h01 = height_at_index(x0, z1);
    let h11 = height_at_index(x1, z1);
    let h0 = h00 + (h10 - h00) * tx;
    let h1 = h01 + (h11 - h01) * tx;
    h0 + (h1 - h0) * tz
}

pub fn is_terrain_walkable_at(x: f32, z: f32) -> bool {
    let hm = heightmap();
    let u = ((x - hm.min_x) / (hm.max_x - hm.min_x)).clamp(0.0, 1.0);
    let v = ((z - hm.min_z) / (hm.max_z - hm.min_z)).clamp(0.0, 1.0);
    let grid_x = (u * (HEIGHTMAP_SIZE as f32 - 1.0)).round() as usize;
    let grid_z = (v * (HEIGHTMAP_SIZE as f32 - 1.0)).round() as usize;
    let index = grid_z * HEIGHTMAP_SIZE + grid_x;
    is_walkable_index(index) && terrain_slope_at(x, z) <= TERRAIN_MAX_WALKABLE_SLOPE
}

pub fn terrain_slope_at(x: f32, z: f32) -> f32 {
    let hm = heightmap();
    let cell_x = (hm.max_x - hm.min_x) / (HEIGHTMAP_SIZE as f32 - 1.0);
    let cell_z = (hm.max_z - hm.min_z) / (HEIGHTMAP_SIZE as f32 - 1.0);
    let left = sample_height(x - cell_x, z);
    let right = sample_height(x + cell_x, z);
    let down = sample_height(x, z - cell_z);
    let up = sample_height(x, z + cell_z);
    let dhdx = (right - left) / (cell_x * 2.0);
    let dhdz = (up - down) / (cell_z * 2.0);
    (dhdx * dhdx + dhdz * dhdz).sqrt()
}

fn height_at_index(x: usize, z: usize) -> f32 {
    heightmap().heights[z * HEIGHTMAP_SIZE + x]
}

fn is_walkable_index(index: usize) -> bool {
    let byte = heightmap().walkable[index >> 3];
    (byte & (0x80 >> (index & 7))) != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_inside_generated_range() {
        let h = sample_height(0.0, 0.0);
        assert!(h >= 0.0);
    }

    #[test]
    fn embedded_bin_parses_bounds_from_header() {
        let data = parse_heightmap_bin(HEIGHTMAP_BIN).expect("parse");
        assert_eq!(data.heights.len(), HEIGHTMAP_SIZE * HEIGHTMAP_SIZE);
        assert!(data.max_x > data.min_x);
        assert!(data.max_z > data.min_z);
        // Matches client heightmapMeta for the current bake (approx; f32 binary).
        assert!((data.min_x - (-1574.03)).abs() < 0.05);
        assert!((data.min_z - (-1218.91)).abs() < 0.05);
    }
}
