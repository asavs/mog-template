# MOG Template

This repo is a learning-first template for a self-hosted 3D multiplayer web game.

## Project Structure

```text
mog-template/
├── client/                  # Three.js / React / Vite app
├── server/                  # Rust SpacetimeDB module
├── deploy/                  # Production config (Nginx, systemd)
├── scripts/                 # Deployment and build scripts
├── docs/                    # Documentation and logs
└── README.md
```

## Docs

- [Contributor Guide](CONTRIBUTING.md)
- [Development Pipeline](docs/dev-pipeline.md)
- [PR Review Workflow](docs/pr-review-workflow.md)
- [Peer Reviewer Cron](docs/reviewer-cron.md)
- [GitHub Review App](docs/github-review-app.md)
- [Architecture Guide](docs/spacetimedb-threejs-architecture.md)
- [Asset Storage Design](docs/asset-storage.md)
- [Deployment and Security Checklist](docs/deployment-security-checklist.md)
- [Environment Requirements](tools/env-requirements/README.md) — what each tool needs and where it runs ([support matrix](docs/environment-matrix.md))

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch, draft PR, CI, review, beta deploy, and merge workflow.

### Local Setup
```bash
git clone <repo-url> ~/mog-template
cd ~/mog-template
```

### Server (SpacetimeDB)
The server logic is in `server/`. It's a Rust module that runs inside SpacetimeDB.
```bash
cd server
spacetime publish # Publish to local SpacetimeDB
```

### Client (Vite + React + Three.js)
The frontend is in `client/`.
```bash
cd client
npm install
npm run dev # Start development server
```

For beta-shaped local development, use `npm run dev:beta`. CI is the authoritative full-build signal; run local production builds when they are relevant to the change or when debugging CI.

## Deployment

Normal beta and prod deploys run through GitHub Actions after PR review and merge. For manual VM-local deployment work, the scripts are:

To build the client and publish the server module in one go:
```bash
./scripts/deploy.sh
```

Individual scripts:
- `./scripts/publish-server.sh`: Publishes the Rust module to SpacetimeDB.
- `./scripts/generate-bindings.sh`: Regenerates TypeScript bindings from the Rust module.
- `./scripts/build-client.sh`: Builds Vite app and copies to `/var/www/mog`.
- `bash ./scripts/fix-permissions.sh`: Applies shared workspace permissions if ownership gets messy.
- `./scripts/setup-shared-spacetime-config.sh`: Installs a shared VM-local SpacetimeDB CLI config at `/stdb/config/cli.toml`.
- `./scripts/reset-local-spacetimedb.sh`: Explicitly deletes and recreates local SpacetimeDB data.

The SpacetimeDB scripts use `spacetime` when available and otherwise fall back to `/stdb/bin/2.1.0/spacetimedb-cli`. They automatically use `/stdb/config/cli.toml` when it contains a token. To publish with a different database-owner identity, set `SPACETIME_CONFIG_PATH=/path/to/cli.toml`.

The `deploy/` folder contains the source-of-truth configurations for Nginx and systemd.

## Credits

Built on the [vibe-coding-starter-pack-3d-multiplayer](https://github.com/majidmanzarpour/vibe-coding-starter-pack-3d-multiplayer)
by [Majid Manzarpour](https://github.com/majidmanzarpour), licensed under the MIT License.
The Three.js / React / SpacetimeDB foundation of this project derives from that starter.
See [NOTICE](NOTICE) for the full attribution and original license text.

## First Milestone

Build the smallest complete multiplayer loop before adding complex gameplay:

1. A player opens the web client.
2. The client connects to SpacetimeDB.
3. The player calls a `join_game` reducer.
4. The client sends input with a reducer like `set_input`.
5. A scheduled server tick updates authoritative positions at 20-30 Hz.
6. Clients subscribe to player/transform tables and render smooth motion in Three.js.
