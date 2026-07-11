# Deployment And Security Checklist

This checklist is for deploying a SpacetimeDB + Vite web game on a single Google VM.

## Production Shape

Recommended production topology:

```text
Internet
  |
  v
Nginx :443
  |-- static Vite client
  `-- selected SpacetimeDB routes
        |
        v
      SpacetimeDB 127.0.0.1:3000
```

Do not expose SpacetimeDB directly to the public internet unless you deeply understand the consequences.
## VM Firewall (Implemented)

Allow:

```text
[x] 22/tcp   SSH
[x] 80/tcp   HTTP for redirect and Let's Encrypt
[x] 443/tcp  HTTPS and secure WebSocket
```

Usually do not allow:

```text
[x] 3000/tcp SpacetimeDB direct access
```

## SpacetimeDB Service (Implemented)

Prefer a dedicated system user:

```bash
[x] sudo mkdir /stdb
[x] sudo useradd --system spacetimedb
[x] sudo chown -R spacetimedb:spacetimedb /stdb
```

The service should bind to loopback:

```ini
[x] [Service]
[x] ExecStart=/stdb/spacetime --root-dir=/stdb start --listen-addr='127.0.0.1:3000'
```

Restart=always
User=spacetimedb
WorkingDirectory=/stdb
```

Avoid binding production SpacetimeDB to:

```text
0.0.0.0:3000
```

That makes the database server reachable from outside the VM.

## Nginx Responsibilities

Nginx should:

- serve the built client from `/var/www/<game-name>`
- terminate HTTPS
- proxy WebSocket subscription traffic
- proxy identity/token creation if needed by the TypeScript SDK
- avoid exposing publish/admin routes publicly

The public app can live at:

```text
https://example.com/
```

SpacetimeDB stays behind Nginx:

```text
http://127.0.0.1:3000
```

## Public Routes

For a browser client, expect to proxy at least:

```text
/v1/identity
/v1/database/<database-name>/subscribe
```

Only expose reducer-call HTTP routes if the client actually needs them. The TypeScript SDK usually calls reducers over its connection path, so verify the exact behavior for the SDK version in use.

Avoid a broad production proxy like:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
}
```

That can expose more SpacetimeDB surface than intended, especially if the same domain also serves the frontend.

## HTTPS And WebSockets

Use Let's Encrypt through Certbot:

```bash
sudo certbot --nginx -d example.com
```

Browser production clients should connect using secure WebSocket:

```text
wss://example.com
```

Local development usually uses:

```text
ws://localhost:3000
```

## Frontend Secrets

Do not put secrets in Vite environment variables unless they are meant to be public.

Anything bundled into the frontend can be viewed by players.

Safe frontend config:

```text
VITE_STDB_URI=wss://example.com
VITE_STDB_MODULE=my-game-db
```

Unsafe frontend config:

```text
DATABASE_ADMIN_TOKEN=...
PRIVATE_API_KEY=...
```

## Reducer Security

Reducers must assume all arguments are hostile.

Validate:

- player identity
- ownership of the player row
- movement speed
- action cooldowns
- attack range
- inventory ownership
- match membership
- rate-sensitive actions

Do not let clients directly provide authoritative results like damage, final position, or rewards.

Prefer:

```text
set_input(move_x, move_z, aim_yaw, primary_fire)
```

Avoid:

```text
set_position(x, y, z)
deal_damage(target_id, amount)
grant_item(item_id)
```

## Scheduled Reducers

Scheduled reducers are still reducers. If a tick reducer should only be run by the scheduler, check that the sender is internal.

Conceptually:

```rust
if ctx.sender != ctx.identity() {
    return Err("Only the scheduler can run this reducer".into());
}
```

Use this pattern for reducers like:

```text
game_tick
expire_projectile
resolve_match_timeout
```

## Deployment Flow

A simple deployment loop:

```text
build Rust module
publish module to local SpacetimeDB on the VM
generate TypeScript bindings
build Vite client
copy dist files to /var/www/<game-name>
restart/reload Nginx if config changed
```

For early development, it is fine to do this manually. Later, wrap it in a script.

## Operational Checks

Useful checks on the VM:

```bash
sudo systemctl status spacetimedb
sudo journalctl -u spacetimedb --no-pager | tail -50
sudo nginx -t
sudo systemctl status nginx
sudo certbot renew --dry-run
```

From a browser:

- site loads over HTTPS
- no mixed-content warnings
- WebSocket connects
- reconnect after refresh keeps identity/token
- multiple browser windows show multiple players

## Early Scaling Notes

One VM is a good place to start. Before worrying about multiple servers, make sure you have:

- efficient table rows
- scoped subscriptions
- low reducer cost
- no giant per-tick payloads
- basic monitoring
- a backup story for persistent data

Most early performance problems come from sending too much data too often, not from the VM being too small.

