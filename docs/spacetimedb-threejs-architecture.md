# SpacetimeDB + Three.js Multiplayer Architecture

This document explains how the whole game stack fits together. It is written for someone who knows what a computer is, but is still building their mental model for web games, realtime networking, and authoritative multiplayer servers.

## The Big Picture

Your production game can run on one Google Compute Engine VM:

```text
Player browser
  |
  | HTTPS / WSS
  v
Nginx on Google VM
  |-- serves built Vite client files
  |
  `-- proxies selected SpacetimeDB routes
        |
        v
      SpacetimeDB on 127.0.0.1:3000
        |
        |-- Rust module reducers
        |-- scheduled game tick
        |-- game tables
        `-- realtime subscriptions
```

The browser draws the game. SpacetimeDB owns the truth. Nginx is the safe public doorway.

## Roles In The Stack

### Google VM

The VM is just a Linux computer in Google's datacenter. It runs:

- Nginx
- SpacetimeDB
- your built frontend files
- deployment scripts and system services

The nice part of using one VM is that SpacetimeDB and its database live on the same machine. There is no extra network hop between a separate game server and database.

### Nginx

Nginx is the public web server.

It should:

- listen on ports `80` and `443`
- redirect HTTP to HTTPS
- serve the Vite build output, usually from `/var/www/<game-name>`
- proxy WebSocket/API requests to SpacetimeDB
- keep SpacetimeDB's admin/publish surface away from the public internet

SpacetimeDB should usually listen only on `127.0.0.1:3000`, not `0.0.0.0:3000`.

### Vite

Vite is the frontend dev server and production bundler.

During development, it gives you fast reloads:

```bash
npm run dev
```

For production, it builds static files:

```bash
npm run build
```

Those static files are copied to the VM and served by Nginx. Vite is not the multiplayer server.

### React

React is best for UI and application state:

- menus
- HUD
- inventory
- settings
- connection status
- game overlays

React is not the authoritative game simulation. It should not decide who hit whom, where players really are, or whether a player is allowed to perform an action.

### TypeScript

TypeScript is JavaScript with types. The browser ultimately runs JavaScript, but TypeScript helps catch mistakes before the game ships.

In this stack, TypeScript is especially useful because SpacetimeDB can generate client bindings. Your Rust tables and reducers become typed frontend APIs.

Instead of guessing what a reducer accepts, the generated bindings tell the client:

- reducer names
- reducer argument types
- table names
- table row shapes

### Three.js And React Three Fiber

Three.js is the 3D rendering library. React Three Fiber is a React renderer for Three.js.

Use them for:

- scene graph
- cameras
- meshes
- lights
- materials
- animation
- visual interpolation
- asset loading

The client render loop usually runs at 60+ frames per second. The authoritative server tick might only run at 20-30 times per second. That is normal.

### Rust

Rust is used for the SpacetimeDB module.

The Rust module defines:

- tables
- reducers
- scheduled tick logic
- validation rules
- authoritative gameplay state

The module is compiled to WebAssembly and published into SpacetimeDB.

### SpacetimeDB

SpacetimeDB is a database plus server runtime plus realtime sync layer.

Instead of this traditional shape:

```text
Game server -> Database -> WebSocket server
```

SpacetimeDB gives you:

```text
SpacetimeDB = database + server logic + realtime subscriptions
```

The important concepts are:

- Tables store structured state.
- Reducers are the only way to modify state.
- Clients call reducers.
- Clients subscribe to table queries.
- SpacetimeDB streams matching table changes to clients.
- Scheduled tables can trigger reducers in the future, which is useful for a game tick.

## Authoritative Server Model

For multiplayer games, the server should be authoritative.

That means:

- the client sends intent
- the server validates intent
- the server simulates the real result
- the server publishes the result
- the client renders that result

Bad pattern:

```text
Client: I am now at x=500 and dealt 999 damage.
Server: OK.
```

Better pattern:

```text
Client: I am holding W and aiming this direction.
Server: Based on your speed, cooldowns, collision, and current state, your new position is x=12.4.
```

The frontend is untrusted. A real player can modify browser code, intercept requests, or call reducers manually. Reducers must validate all important rules.

## A Minimal Game Schema

A simple starting schema might include:

```text
Player
  player_id
  identity
  display_name
  connected

InputState
  player_id
  move_x
  move_z
  aim_yaw
  primary_fire
  updated_at

Transform
  player_id
  x
  y
  z
  yaw
  updated_at

TickSchedule
  scheduled_id
  scheduled_at
```

Possible reducers:

```text
join_game(display_name)
leave_game()
set_input(move_x, move_z, aim_yaw, primary_fire)
game_tick(tick_schedule_row)
```

`join_game`, `leave_game`, and `set_input` are called by clients.

`game_tick` should be called by SpacetimeDB's scheduler, not by normal clients. Guard it so random users cannot manually advance the simulation.

## Server Tick

The server tick is the authoritative simulation loop.

At 20-30 Hz:

```text
read current inputs
calculate movement
check collisions/rules
update transforms
resolve combat/actions
write new state to tables
schedule next tick
```

Why 20-30 Hz instead of 60 Hz?

- Lower CPU cost
- Lower bandwidth
- Plenty for many multiplayer games
- Client interpolation can make it look smooth

Fast competitive shooters often need more specialized networking. For an early web game, 20-30 Hz is a good starting point.

## Client Render Loop

The client loop is visual.

At 60+ FPS:

```text
read keyboard/mouse
send input changes to server
render scene
animate camera
interpolate remote players
predict local player movement
smooth corrections from server
draw UI
```

The client is allowed to look smooth before the server response arrives. It is not allowed to become the source of truth.

## Prediction

Without prediction, the local player only moves after the server round trip. That feels sluggish.

With prediction:

1. Player presses W.
2. Client immediately moves the local visual character.
3. Client sends `set_input` to the server.
4. Server simulates the real position.
5. Server publishes the authoritative transform.
6. Client reconciles if its prediction drifted.

Start simple. Prediction can get complex, especially when collisions and combat matter.

## Interpolation

For other players, do not usually predict everything. Instead, interpolate between snapshots.

Example:

```text
Server snapshot A: Alice at x=10
Server snapshot B: Alice at x=12
Client renders smooth motion from 10 to 12
```

Clients often render remote players a tiny bit behind real time so they have two known snapshots to blend between.

## Physics

Client-side physics libraries like Rapier can be great for feel and visuals, but authoritative physics must happen on the server if the outcome matters.

Beginner-friendly approach:

- start with simple server-side collision
- use circles, capsules, or boxes
- avoid complex rigidbody interactions at first
- use client physics for visual polish only

If the server cannot reproduce a physics outcome, do not make that outcome important for fairness.

## Subscriptions And Bandwidth

Subscriptions are powerful, but they are not magic.

Avoid subscribing every player to every piece of world state forever.

Eventually, you want interest management:

- subscribe to nearby entities
- separate lobby state from match state
- keep large private/internal tables private
- avoid writing huge rows every tick
- avoid changing data that clients do not need

For the first prototype, subscribing to all players is fine. For a real game, scope it down.

## Recommended First Milestone

Build this before adding advanced gameplay:

1. One SpacetimeDB Rust module.
2. A `Player` table.
3. An `InputState` table.
4. A `Transform` table.
5. A scheduled `game_tick` reducer.
6. A Vite React client.
7. A simple R3F scene with one capsule/cube per player.
8. WASD input.
9. Server-authoritative movement.
10. Smooth remote-player interpolation.

That tiny game teaches the full stack.

## What To Avoid Early

Avoid these until the basic loop works:

- complex physics
- inventory systems
- procedural worlds
- advanced combat
- huge maps
- many entity types
- elaborate asset pipelines
- matchmaking
- accounts and payments

The basic realtime loop is the foundation. Everything else becomes easier once that loop is solid.

