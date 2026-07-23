/**
 * Single source of truth for the active playable terrain mesh.
 * Bake script (`scripts/bake-terrain-collision.mjs`) must use the same relative path
 * and target size — keep them in lockstep when swapping maps.
 */
export const TERRAIN_GLB_RELATIVE_PATH = 'models/terrain/dark-fantasy-map-lower-poly.glb';

/** Longest XZ extent after fit (meters). Bake uses the same constant. */
export const TERRAIN_TARGET_SIZE = 3148.07;

export const TERRAIN_Y_OFFSET = 0;
