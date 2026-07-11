# Client-Side Guidelines (React + Three.js + Networking)

## Tech Stack
- **Framework:** React 19 (Functional Components, Hooks)
- **3D Engine:** Three.js via `@react-three/fiber` (R3F)
- **Component Library:** `@react-three/drei`
- **Networking:** SpacetimeDB TypeScript SDK

---

## Core Networking Principles (CRITICAL)

### 1. Snapshot Interpolation
- Do NOT render the player directly at the latest server position.
- Remote players MUST be sampled from the `TransformSnapshot` buffer using `sampleBuffer` from `netcode.ts`.
- Use `INTERPOLATION_DELAY_MS` (default 150ms) to ensure smooth motion despite network jitter.

### 2. Client-Side Prediction (CSP)
- The local player should move immediately based on local input.
- Use `applyMovement` and `applyJumpPhysics` from `movement.ts` inside the `useFrame` loop.
- Periodically reconcile with the server state (see `Player.tsx`).

### 3. Coordinate Systems
- **Y-Axis:** Up
- **Z-Axis:** Forward/Backward (Forward is -Z in Three.js)
- **Rotation:** `rotation_y` in radians.

---

## React + R3F Best Practices

### 1. The `useFrame` Loop
- Perform physics and interpolation inside `useFrame`, not `useEffect`.
- Access refs directly (`ref.current.position`) instead of using React state for high-frequency updates (60fps).
- **Optimization:** Use `memo` for 3D components to prevent unnecessary re-renders of the scene graph.

### 2. Asset Management
- Always use `THREE.Cache.enabled = true`.
- Use loaders (`FBXLoader`, `GLTFLoader`) inside `useMemo` or `useEffect` to avoid reloading assets on every frame.
- Offload heavy models to `public/models/`.

### 3. Component Hierarchy
- Keep the 3D scene graph declarative inside `<Canvas>`.
- Use `<Html>` from `@react-three/drei` for 2D UI elements (like nameplates) that need to follow 3D objects.

---

## Common Mistakes to Avoid
- **HALLUCINATION ALERT:** Do NOT use `setState` for player positions. It will kill performance (renders the whole React tree 60 times a second). Use **Refs** + `useFrame`.
- **HALLUCINATION ALERT:** Do NOT try to use standard browser `requestAnimationFrame`. Use R3F's `useFrame` hook so the logic stays synced with the renderer.
- **Interpolation:** If remote players are "teleporting," check if the `receivedAt` timestamp is being handled correctly in `netcode.ts`.

---

## Commands
```bash
# Start local root/prod-shaped client.
# /v1 is proxied to local SpacetimeDB on 127.0.0.1:3000.
npm run dev

# Start local beta-shaped client under /beta/.
# Uses the same local SpacetimeDB proxy and selects mog-game-beta by base path.
npm run dev:beta

# Run unit tests (Vitest)
npm run test

# Build root/prod bundle
npm run build

# Build beta bundle for /beta/
npm run build:beta
```
