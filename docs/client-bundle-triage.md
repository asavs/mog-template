# Client Bundle Triage

Relates to issue #18: client bundle code-splitting.

## Build Measurements

Measured with `cd client && npm run build`.

| Output | Before | After |
| --- | ---: | ---: |
| `dist/index.html` | 0.45 kB | 0.62 kB (gzip 0.34 kB) |
| `dist/assets/index-*.css` | 2.13 kB | 2.13 kB (gzip 0.94 kB) |
| `dist/assets/index-*.js` entry | 3,511.43 kB (gzip 879.89 kB) | 614.44 kB (gzip 188.19 kB) |
| `dist/assets/rolldown-runtime-*.js` | n/a | 0.69 kB (gzip 0.42 kB) |
| `dist/assets/RemotePlayer-*.js` | n/a | 2.02 kB (gzip 0.87 kB) |
| `dist/assets/LocalPlayer-*.js` | n/a | 6.38 kB (gzip 2.21 kB) |
| `dist/assets/playerModelLoader-*.js` | n/a | 51.84 kB (gzip 16.02 kB) |
| `dist/assets/GroundTerrain-*.js` | n/a | 71.90 kB (gzip 21.24 kB) |
| `dist/assets/publicAssets-*.js` | n/a | 723.66 kB (gzip 184.71 kB) |
| `dist/assets/BasePlayer-*.js` | n/a | 2,045.52 kB (gzip 472.06 kB) |

After-build chunk listing:

```text
dist/index.html                                0.62 kB | gzip:   0.34 kB
dist/assets/index-DeeahWtu.css                 2.13 kB | gzip:   0.94 kB
dist/assets/rolldown-runtime-S-ySWqyJ.js       0.69 kB | gzip:   0.42 kB
dist/assets/RemotePlayer-CNIX7GB2.js           2.02 kB | gzip:   0.87 kB
dist/assets/LocalPlayer-e9tY17No.js            6.38 kB | gzip:   2.21 kB
dist/assets/playerModelLoader-BQ29nkhY.js     51.84 kB | gzip:  16.02 kB
dist/assets/GroundTerrain-CgSmAJKE.js         71.90 kB | gzip:  21.24 kB
dist/assets/index-Cgog552Y.js                614.44 kB | gzip: 188.19 kB
dist/assets/publicAssets-Bg_GO-Ak.js         723.66 kB | gzip: 184.71 kB
dist/assets/BasePlayer-CNGIc2s9.js         2,045.52 kB | gzip: 472.06 kB
```

Vite still warns that some chunks exceed 500 kB, but the entry chunk is materially smaller: 3,511.43 kB to 614.44 kB, and gzip 879.89 kB to 188.19 kB.

## What Changed

`client/src/components/playerModelAssets.ts` mixed lightweight character metadata with heavyweight Three.js example loaders. The lightweight pieces now live in `client/src/components/characterConfig.ts`: animation keys, class config accessors, class capability types, normalization, and potion attachment config. This module has no `three/examples/jsm/...` imports.

The heavyweight loader/cache/model code now lives in `client/src/components/playerModelLoader.ts`: `FBXLoader`, `GLTFLoader`, `SkeletonUtils.clone`, model and animation caches, preload helpers, model loading, cloning, animation trimming, mesh disposal, and equipment attachment helpers. `App.tsx` dynamically imports this module for asset preloading instead of pulling it into the entry chunk at startup.

`GameWorld.tsx` now lazy-loads `GroundTerrain`, `LocalPlayer`, and `RemotePlayer` with separate `Suspense` boundaries. Terrain loading and player loading are isolated from each other, and neither boundary wraps the base scene lighting, skybox, metrics ticker, audio listener bridge, environment, grid, or contact shadows.

This supersedes PR #98's original approach, which targeted a `Player.tsx` component that no longer exists after the client decomposition into `BasePlayer`/`LocalPlayer`/`RemotePlayer`; this adapts the idea to the current file layout and adds the root-cause fix for the eager loader import through `playerModelAssets.ts` that #98 did not address.
