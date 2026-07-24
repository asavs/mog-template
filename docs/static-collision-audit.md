# Static Triangle Character Controller Audit

**Status:** architecture and implementation audit for PR #91. This document is
the durable reference for the castle collision controller; it is not a request
to add a browser-only physics dependency.

## Scope and architectural decision

The game needs the same collision semantics in two places:

- TypeScript provides client-side prediction.
- Rust in SpacetimeDB is authoritative.

Therefore, Three.js `Octree`, `three-mesh-bvh`, and Rapier are **differential
references**, not runtime dependencies. `three-mesh-bvh` and the Three.js
octree would only solve browser collision. Rapier would require a separate
architecture decision because matching its results in TypeScript and the
authoritative Rust module is not automatic.

The retained architecture is correct:

- outdoor terrain uses `heightmap.bin`;
- `Castle Collision.002` is baked into a versioned, canonical `CC01` triangle
  asset;
- a serialized uniform grid selects candidate triangle IDs only;
- narrow phase uses the baked original triangles;
- client and server use deliberately matched capsule sweep-and-slide solvers.

No upstream source code has been copied or translated into this repository as
part of this audit.

## Upstream references inspected

The following shallow, read-only checkouts were inspected under
`C:\tmp\collision-references` on 2026-07-24:

| Project | Pinned revision | Relevant material | License |
| --- | --- | --- | --- |
| [Three.js](https://github.com/mrdoob/three.js) | `302c62fd8888481c7a989a1697e3c47ad2353864` | [`Octree.triangleCapsuleIntersect`](https://github.com/mrdoob/three.js/blob/302c62fd8888481c7a989a1697e3c47ad2353864/examples/jsm/math/Octree.js), `Capsule`, FPS example | MIT |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | `d2262689a35ee849bcac3e0acf659769a6d2445b` | [`characterMovement.js`](https://github.com/gkjohnson/three-mesh-bvh/blob/d2262689a35ee849bcac3e0acf659769a6d2445b/example/characterMovement.js) | MIT |
| [Rapier](https://github.com/dimforge/rapier) | `c13133ad293ee70c7f9cec9e498eac016c362169` | [`character_controller.rs`](https://github.com/dimforge/rapier/blob/c13133ad293ee70c7f9cec9e498eac016c362169/src/control/character_controller.rs), [official guide](https://rapier.rs/docs/user_guides/javascript/character_controller/) | Apache-2.0 |

If a later change substantially copies or translates upstream code, preserve
the applicable attribution and license notice in that change.

## Current end-to-end movement flow

### Client prediction

`client/src/movement.ts` currently performs:

```text
input and locomotion state
-> existing horizontal intent / terrain eligibility / world bounds
-> existing jump and gravity integration
-> one complete desired XYZ position
-> resolveCastleCapsuleSweep (when CC01 is ready)
-> velocity response from collision flags
-> reachable support query / existing ground state handling
-> prediction and reconciliation
```

The castle sweep occurs once at the end of `simulateMovementTick`. It must not
also run inside `resolvePlayerMovement`; that prior double-sweep discrepancy
was removed in commit `19456f3`.

### Authoritative server

`server/spacetimedb/src/player_logic.rs` currently performs:

```text
input and locomotion state
-> calculate_next_position (existing horizontal intent, jump, gravity)
-> collision::resolve_player_movement
-> terrain eligibility / world bounds
-> one complete resolve_capsule_sweep
-> velocity response from collision flags
-> reachable support query / existing ground state handling
-> authoritative transform
```

## Findings

### Verified correct or intentionally aligned

| Area | Current result |
| --- | --- |
| Capsule convention | Both runtimes use feet/origin positions, radius `0.45`, height `1.8`, with segment centers at `feet + radius` and `feet + height - radius`. |
| Shared collision data | Client and server consume the same baked `CC01` bytes, canonical transformed triangle data, bounds, and grid. |
| Broad phase | Candidate IDs are sorted and deduplicated after grid gathering. The grid is broad phase only. |
| Narrow phase coverage | The controller checks segment/triangle face intersection, endpoints against faces, and segment-to-edge closest points. It is more complete than a bounding-box collider. |
| Degenerate fallback | The baker rejects near-zero-area geometry, and the runtime fallback normal is aligned between Rust and TypeScript. |
| Fixed collision margin | Both solvers use a small `0.002` skin/offset, consistent with the stability margin recommended by Rapier. |
| Contact classification | Ground, ceiling, and wall flags now consider both normal and entering movement direction on both runtimes. |
| Full movement | Jumping and falling are included in the one final castle sweep; they cannot bypass roofs, ramp undersides, or walls through a horizontal-only query. |
| Ground support | Castle support is elevation-aware, has a short `0.35` reach, and rejects lateral displacement. It does not select the highest triangle at X/Z. |
| Initial overlap | Both solvers perform bounded initial and final recovery passes. Incidental recovery contacts do not set landing or ceiling flags. |
| Visual QA | `?qa` renders the actual baked collision mesh, not a proxy. |

### Implemented hardening after the initial audit

These items were promoted from audit findings into the controller implementation
after the initial document was written:

- **Deterministic contact set:** client and server now collect a small bounded
  contact set, order contacts by penetration descending then triangle ID
  ascending, skip duplicate same-direction normals, and use the set for
  depenetration, collision flags, and slide projection.
- **Conservative long-sweep policy:** when a movement query is longer than the
  validated 32 samples at 0.2m each and the swept capsule bounds may touch the
  castle asset, both runtimes cap that single query to the validated sweep
  distance instead of increasing sample spacing and pretending it is still
  tunnel-safe. Long movement that cannot touch the castle remains unchanged.
- **Input/capsule validation:** both solvers now safely return without geometry
  work for non-finite positions or invalid capsule dimensions, and runtime
  contacts reject non-finite penetrations and normals.
- **Castle/terrain snap separation:** the legacy 6m terrain downhill snap no
  longer receives castle support heights. Castle support remains the short
  direct capsule sweep aid, while terrain keeps the old terrain-only behavior.

### Definite hardening work still needed

These are implementation gaps, not reasons to replace the architecture.

1. **Ground-snap fixtures and traceability:** the code now separates castle and
   terrain snap behavior, but the final contract still needs small fixtures that
   prove no sideways snap, no jump-start snap, direct vertical reachability, and
   clearance at the snapped position across both runtimes.

2. **Debug trace and metrics:** current wireframe QA is useful, but it does not
   expose candidate cells, triangle IDs, selected contacts, normals,
   penetrations, slide iterations, or client/server divergence. Add a
   QA-only comparable trace before diagnosing hard ramp bugs. Also instrument
   candidate-count percentiles so the uniform grid can be tuned from evidence.

3. **Focused behavioral fixtures:** current tests cover asset parsing, sorted
   candidates, an unobstructed client path, and basic geometry. Before declaring
   this controller production-ready, add small fixtures for wall, floor,
   ceiling, initial overlap, no-sideways ground snap, and one shared Rust/TS
   parity fixture with tolerances. Do not use exact float equality for resolved
   positions.

4. **Hot-loop allocations:** the current TypeScript controller creates many
   `Vector3` instances per query. The upstream browser examples reuse scratch
   vectors. Refactor only after correctness fixtures exist, while preserving the
   exact candidate/contact order and output contract.

### Deliberately deferred

- **Autostep is disabled.** Rapier requires grounded-before-obstacle, upward
  clearance, minimum landing width, forward progress, a walkable landing, and a
  final downward check. A naive raise-and-retry would let players climb thin
  walls or decoration. The authored spiral ramps do not require autostep.
- **No exact time-of-impact claim.** The current implementation is a sampled
  sweep plus binary refinement, not an analytic continuous capsule cast.
- **No browser-only BVH or physics engine dependency.** Both would undermine
  the matched authoritative-server architecture.

## Reference-derived rules retained for future changes

Three.js and three-mesh-bvh both resolve capsule penetration against actual
triangles and use a small collision margin. Rapier formalizes the higher-level
rules relevant here: compute corrected movement from one desired translation,
keep a stable non-zero offset, process movement contacts in order, and limit
snap-to-ground to an already-grounded character moving slightly downward within
a small distance. Rapier also keeps autostep disabled by default because it is
expensive and requires several clearance/progress checks.

Every future controller change must preserve:

- the exact shared `CC01` asset and ascending candidate ID order;
- same capsule dimensions, skin, epsilon, slope threshold, iteration cap, and
  collision-flag semantics in Rust and TypeScript;
- collision as the final reachability stage, without redesigning locomotion;
- no highest-surface X/Z lookup for overlapping spiral ramps;
- tolerance-based parity tests rather than bit-identical float assumptions.

## Minimal pre-QA checklist

Before broad manual castle testing, complete the definite hardening items above
in small reviewable commits. Then manually test every tower ramp in both
directions, ramp seams, inner/outer walls, ceilings below higher ramp levels,
edges, corners, terrain/castle boundaries, reconciliation, and low/high client
frame rates. Each reproducible failure should become one small fixture using the
real start position and input sequence.
