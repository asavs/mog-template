/**
 * Single source of truth for the active playable terrain mesh.
 * Bake script (`scripts/bake-terrain-collision.mjs`) must use the same relative path
 * and target size — keep them in lockstep when swapping maps.
 */
export const TERRAIN_GLB_RELATIVE_PATH = 'models/terrain/castle-terrain-zone.glb';

/**
 * Longest XZ extent after fit (meters). Bake uses the same constant.
 *
 * Not a fixed “world always 3km” knob: it must preserve absolute scale when the
 * source GLB’s raw footprint changes. The previous full map used
 * TERRAIN_TARGET_SIZE 3148.07 over ~3949 raw units (scale ≈ 0.797). This zone
 * mesh is only ~1229 raw units on the long axis; fitting it to 3148 inflated
 * the castle ~3.2×. 979.43 keeps the same absolute scale so Castle 1.002 stays
 * ~31 m tall as before.
 */
export const TERRAIN_TARGET_SIZE = 979.43;

export const TERRAIN_Y_OFFSET = 0;
