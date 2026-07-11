# Asset Storage Design

## Goal

Keep the game simple to develop today while giving large runtime assets a path out of Git and off the VM boot disk as the project grows.

This project currently serves client assets from the same Vite bundle as the app. That is fine for a small template, but models, animations, textures, audio, and generated terrain data can grow faster than source code. The storage plan should make beta/prod deployments coherent without making every contributor clone, build, and deploy hundreds of megabytes of binary files.

## Current State

- Runtime assets live under `client/public/`.
- Vite copies those assets into `client/dist/` during `npm run build`.
- GitHub Actions no longer checks out Git LFS objects during deployment. If a
  built `dist/` contains a Git LFS pointer for a runtime asset, the VM apply
  script preserves the already-deployed real asset and fails if none exists.
- Deploy workflows build on GitHub-hosted runners, copy `client/dist` and the server WASM to `/tmp/deploy-<sha>` on the VM, then apply them to the beta or prod web root.
- Prod currently serves from `/`; beta serves from `/beta/`.
- The VM boot disk is small enough that generated outputs such as `client/dist`, `server/spacetimedb/target`, and stale `/tmp/deploy-*` directories matter.

This is a good first implementation because the app and assets are deployed as one coherent artifact. The main risk is that the artifact gets too large for routine development and deployment.

## Constraints

- Public client assets cannot rely on secrets. Anything the browser downloads is public.
- Beta and prod must not accidentally share mutable asset paths that can change underneath an already deployed client bundle.
- Local development should stay ergonomic. A fresh checkout should be able to run the app without a custom asset server for the common case.
- CI is the authoritative full-build environment. Local full builds are useful when needed, but should not be required for every docs or small code change.
- Nginx remains the public entry point. SpacetimeDB stays private on `127.0.0.1:3000`.
- Large generated outputs should not live permanently on the VM boot disk.

## Options

### Keep Git LFS

Git LFS is the simplest option. Assets stay near the code, CI already knows how to fetch them, and local development can work with ordinary repo paths.

Tradeoffs:

- Clone and checkout cost grows with every binary asset.
- CI and deploy bandwidth grow with every build.
- The VM still receives a full copied `dist` artifact.
- LFS is awkward for generated or frequently replaced binary assets.

This remains acceptable for small, hand-curated assets.

### Google Cloud Storage Bucket

Move large public runtime assets to a GCS bucket and load them by URL or by a configured public asset base.

Tradeoffs:

- Keeps large binaries out of Git history and routine clones.
- Fits the existing GCP hosting model.
- Allows CI to upload assets directly instead of copying all of them through the VM.
- Requires explicit cache, CORS, and naming rules.
- Local development needs either checked-in small fallback assets or a documented way to use the bucket.

This is the best medium-term default for large public assets.

### GCS Plus Cloud CDN

Put Cloud CDN in front of the GCS bucket once assets are large enough or public traffic warrants it.

Tradeoffs:

- Better global caching and lower load on the origin bucket.
- More infrastructure to configure and document.
- Cache invalidation becomes a real operational concern unless asset paths are immutable.

This is a later optimization, not the first migration step.

### Versioned Asset Prefixes

Use immutable release prefixes such as:

```text
gs://mog-assets/releases/<git-sha>/
https://assets.example.com/releases/<git-sha>/
```

The deployed client bundle points at the prefix it was built with. Beta and prod can then use different asset versions without racing each other.

Tradeoffs:

- Avoids stale browser caches and beta/prod skew.
- Makes rollbacks straightforward because old prefixes can remain available.
- Requires cleanup policy for old release prefixes.

This should be part of any move to external asset storage.

## Recommendation

Short term, keep the current Git LFS paths for existing source history, but do
not make deploy checkout depend on LFS bandwidth. Existing large runtime assets
are seeded on the VM and preserved by `scripts/apply-artifacts.sh` when GitHub
Actions builds from pointer files. Add cleanup tooling for generated outputs so
the VM can keep functioning while the asset pipeline is still simple.

Medium term, move large public runtime assets to GCS under immutable, versioned prefixes. Keep small source assets, icons, tiny fixtures, and asset metadata in the repo. The client should load runtime assets through a single base-aware helper so `/`, `/beta/`, and future CDN URLs use the same call sites.

Long term, put Cloud CDN in front of the bucket if public traffic or asset size justifies it. The CDN should cache immutable release paths aggressively, while any mutable manifest path should have a short TTL or be avoided for deployed builds.

## Proposed Shape

Use two categories of assets:

| Category | Examples | Storage |
|---|---|---|
| Source and tiny public assets | favicon, icons, small test fixtures, metadata manifests | Git |
| Large runtime assets | FBX/GLB models, animation packs, terrain meshes, skyboxes, music, large textures | GCS release prefixes |

The build should produce or consume an asset manifest that records logical asset names and resolved URLs:

```json
{
  "wizardModel": "https://assets.example.com/releases/abc123/models/wizard/wizard.fbx",
  "skyboxFront": "https://assets.example.com/releases/abc123/skybox/corona_ft.png"
}
```

The app should not scatter raw bucket URLs through rendering code. Rendering code should ask a local asset helper for a URL, and the helper should apply the current app base or configured asset base.

## Migration Plan

1. Inventory current assets under `client/public/` and classify which ones are source-like versus large runtime payloads.
2. Keep existing deployed LFS-backed runtime assets available on the VM while
   deploys are built without LFS hydration.
3. Add an asset manifest format and load all runtime assets through one helper.
4. Create a GCS bucket for public runtime assets with explicit CORS and cache policy.
5. Teach CI to upload large assets to an immutable prefix for each deployable commit.
6. Build the client with the asset base for that prefix.
7. Keep old prefixes long enough for rollback, then delete them through a scheduled retention policy.
8. Add Cloud CDN only after bucket-backed assets are stable.

## Cache Policy

- Immutable release assets: long cache TTL, content never changes at the same URL.
- Deployed client HTML: short or no cache, because it selects the current JavaScript bundle.
- JavaScript/CSS bundles: content-hashed filenames with long TTL.
- Manifests, if any are mutable: short TTL. Prefer immutable manifests in release prefixes.

## Open Questions

- Which domain should serve public assets once HTTPS and the static IP are settled?
- Should artist/source files stay in Git LFS while optimized runtime exports move to GCS?
- Do we need per-branch or per-PR asset prefixes, or is per-commit enough?
- What retention window is enough for rollback: 7 days, 30 days, or the last N deployed SHAs?
- Which asset licenses require attribution or restrict public redistribution?

## Non-Goals

- Moving assets out of Git in this PR.
- Introducing private client assets. Browser-loaded assets are public by design.
- Creating a per-PR bucket or a new VM.
- Replacing the current Vite build pipeline.
