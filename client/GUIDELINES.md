# Client-Side Guidelines (React + Three.js + Networking)

## Tech Stack
- **Framework:** React 19 (Functional Components, Hooks)
- **3D Engine:** Three.js via `@react-three/fiber` (R3F)
- **Component Library:** `@react-three/drei`
- **Networking:** SpacetimeDB TypeScript SDK

---

## Core Networking Principles (CRITICAL)

### 1. Snapshot Interpolation
- Do NOT render a remote player directly at the latest server position.
- Remote players MUST be sampled from the snapshot buffer using `sampleBuffer` from
  `netcode.ts` (fed by `pushSnapshot`/`toSnapshot`).
- Use `INTERPOLATION_DELAY_MS` (default 150ms) to ensure smooth motion despite network jitter.

### 2. Client-Side Prediction (CSP)
- The local player moves immediately based on local input: `game/frame.ts`'s `predictTick` runs
  the authoritative movement sim (`sim/movement.ts`'s `simulateMovementTick`) against the same
  arena ground/collision (`sim/ground.ts`'s `createArenaGround`) the server checks against, at a
  fixed 20Hz tick matching the server's tick rate.
- Reconcile from `player_transform` + `player_input_ack`, keyed by the acked
  `lastProcessedClientTick` — see `game/frame.ts`'s module doc for the full shape.
- Because client and server run the *same* movement sim against the *same* arena data
  (`shared/arena.json`), a correction should only ever come from network jitter or an
  action-gated speed change the client hasn't heard about yet — never from disagreeing physics.

### 3. Coordinate Systems
- **Y-Axis:** Up
- **Z-Axis:** Forward/Backward (Forward is -Z in Three.js)
- **Rotation:** `rotation_y` in radians.

---

## React + R3F Best Practices

### 1. The `useFrame` Loop
- Perform physics, prediction, and interpolation inside `useFrame`, not `useEffect`.
- Access refs directly (`ref.current.position`) instead of using React state for high-frequency
  updates (60fps). High-frequency sim state lives in refs and is read fresh each frame — see
  `game/frame.ts`'s pattern.
- **Optimization:** Use `memo` for 3D components to prevent unnecessary re-renders of the scene
  graph.

### 2. Asset Management
- Always use `THREE.Cache.enabled = true`.
- Never load an asset (or resolve a content key) inside the render loop — resolve once in
  `useEffect`/`useMemo` and cache the result.
- **Content — bodies, motions, props:** everything renders through the content seam
  (`client/src/content/`), never a hardcoded asset path. `resolveBody` / `resolveMotion` /
  `resolveProp` return the same runtime shape whether the key is bound to a real GLB dropped
  into `content/dropin/` or a procedural placeholder — see
  [`client/src/content/ART_DROP_IN.md`](src/content/ART_DROP_IN.md) for the full contract, and
  `game/PlayerBody.tsx` for how one player's skinned rig + `AnimationController` gets built and
  driven from live server rows. Do not add per-class asset folders or preload every content key
  up front — resolve what's actually needed.
- **Actions/abilities:** driven entirely by `shared/actions.json` → generated defs
  (`actions/defs.generated.ts`) on both sides. Adding an ability is a JSON row, never a new
  client-side special case; see [`docs/action-pipeline.md`](../docs/action-pipeline.md).

### 3. Component Hierarchy
- Keep the 3D scene graph declarative inside `<Canvas>`.
- Use `<Html>` from `@react-three/drei` for 2D UI elements (like nameplates) that need to follow
  3D objects.

---

## Common Mistakes to Avoid
- **HALLUCINATION ALERT:** Do NOT use `setState` for player positions. It will kill performance
  (renders the whole React tree 60 times a second). Use **Refs** + `useFrame`.
- **HALLUCINATION ALERT:** Do NOT try to use standard browser `requestAnimationFrame`. Use
  R3F's `useFrame` hook so the logic stays synced with the renderer.
- **Interpolation:** If remote players are "teleporting," check if the `receivedAt` timestamp is
  being handled correctly in `netcode.ts`.
- **HALLUCINATION ALERT:** There is no `client/src/avatar/` package, no `Player.tsx`, and no
  `shared/avatar-loadout.json` — those belonged to a pre-rewrite class/loadout system that no
  longer exists. The current player rig/animation path is `game/PlayerBody.tsx` +
  `client/src/content/` + `client/src/anim/`.

---

## Commands
```bash
# Start local root/prod-shaped client.
# /v1 is proxied to local SpacetimeDB on 127.0.0.1:3000.
npm run dev

# Clip/prop browser — every content key, every source, bound or not.
npm run sandbox

# Routine room — a body wearing real stances/props running a fixed sequence.
npm run drill

# Run unit tests (Vitest)
npm run test

# Build root/prod bundle
npm run build

# Build beta bundle for /beta/ (local base-path testing only; no deploy
# workflow currently ships this build — see CONTRIBUTING.md)
npm run build:beta
```
