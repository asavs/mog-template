# Castle mesh collision contract

`Castle 1.002` is the visible map mesh. `Castle Collision.002` is hidden in the
client scene and is baked as the static collision source. Outdoor terrain remains
on `heightmap.bin`; it is not merged with the castle collision mesh.

`scripts/bake-terrain-collision.mjs` writes the versioned `CC01` binary to both
the browser public assets and the server module. It contains transformed indexed
vertices, triangle indices, the source-node matrix, terrain placement transform,
source GLB SHA-256, bounds, and a serialized uniform grid.

The serialized uniform grid determines candidate triangles and inspection order,
but all actual collision results come from capsule-versus-triangle narrow-phase
tests against the original baked triangles.

The authoritative Rust controller and TypeScript prediction controller must use
the same fixed-step constants, candidate ordering, contact tie-breaks, and
epsilon values. Stable candidate ordering improves reproducibility but does not
make Rust and JavaScript bit-identical floating-point environments. Shared golden
fixtures therefore use positional and normal tolerances unless the solver later
explicitly quantizes intermediate values.

The capsule's current elevation and reachable swept contacts choose support on
the spiral ramps. No system may select a castle surface by taking the highest
triangle at an X/Z coordinate, because ramp levels overlap.
