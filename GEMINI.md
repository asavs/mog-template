# Project Mandates & Rebuild Guide

## Rebuild Workflow

To rebuild both the server and client, follow these steps:

1.  **Environment Setup:** Ensure the Rust toolchain is in your PATH.
    ```bash
    export PATH="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$PATH"
    ```

2.  **Server Publish:** The publish script resolves the SpacetimeDB CLI explicitly, falling back to `/stdb/bin/2.1.0/spacetimedb-cli` when `spacetime` is not on `PATH`.
    ```bash
    cd /srv/mog-template/server
    /srv/mog-template/scripts/publish-server.sh
    ```

3.  **Binding Regeneration:**
    ```bash
    cd /srv/mog-template
    ./scripts/generate-bindings.sh
    ```

4.  **Client Build & Deploy:**
    ```bash
    cd /srv/mog-template
    ./scripts/build-client.sh
    ```

For the normal all-in-one path, run:

```bash
cd /srv/mog-template
./scripts/deploy.sh
```

## Infrastructure Notes
- **SpacetimeDB CLI Binary:** `/stdb/bin/2.1.0/spacetimedb-cli`
- **Rust Toolchain Path:** `$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin`
- **Database Name:** `mog-game-v1`
- **Publish Auth:** The CLI identity must own or have update permission on `mog-game-v1`. A successful module build can still fail at publish time with `403 Forbidden` if the local CLI token is not the database owner.
- **Shared Publish Identity:** Scripts automatically use `/stdb/config/cli.toml` when it contains a token, and also honor `SPACETIME_CONFIG_PATH=/path/to/cli.toml`. For this collaborative VM, install the shared owner config with `./scripts/setup-shared-spacetime-config.sh`.
- **Local DB Reset:** If the local database is owned by the wrong identity and there is no player data to preserve, run `RESET_LOCAL_STDB_CONFIRM=yes ./scripts/reset-local-spacetimedb.sh`.
