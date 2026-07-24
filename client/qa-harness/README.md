# BasePlayer QA harness

Drives a real, headed Chromium browser through a registry of input phases
(join, walk every direction, sprint, jump, jump-while-moving, a network lag
spike, attack/block or spell casts — see `scenarios.ts`) against a real
SpacetimeDB session, and records two synchronized streams on the page's own
`performance.now()` clock:

- one record per rendered frame of `window.__playerDebug` (simPosition,
  renderPosition, visualOffset, cameraPosition, localServerTick,
  localCorrectionError), and
- every input event the page received (keydown/keyup, mouse buttons,
  pointer-lock changes, phase transitions) — so a metric anomaly can be read
  against the exact input that preceded it, and
- whatever game-state channels the client publishes via
  `window.__gameDebug` (`src/hooks/useQaGameDebug.ts`) — HP, projectile
  counts, effect counts, etc. The harness never hardcodes channel names:
  the client can add/rename/remove channels freely and they flow into the
  trace, the per-phase summaries, the CSV (`ch_*` columns), and the report
  (a chart per channel that varied, a compact list of constant ones). This
  is what makes combat phases measurable — "casting fireball" shows up as
  the `fireballProjectiles` channel rising, not just as a stationary
  player. Channel stats are informational; the baseline gate doesn't check
  them yet.

Each run produces these artifacts in `runs/`:

- `<run>.ndjson` — the raw trace, one JSON record per line (`meta`, then
  `frame`/`event` records merged chronologically). Greppable and streamable;
  this is the format `qa:report` and future tooling read.
- `<run>.csv` — the frame stream flattened for spreadsheets.
- `<run>.html` — a self-contained report (no scripts, no network): pass/fail
  verdict, per-phase summary table, correction-error and visual-offset
  time-series with phase bands and input markers, and a top-down path plot.
  **Open this first when debugging** — the raw trace is for tooling.
- `<run>.webm` — Playwright video for that bot session, recorded by default
  and linked from the report. Set `QA_VIDEO=0` to skip video capture.
- `<run>-<phase>.trace.json` — Chromium trace for a failed perf-budget phase
  (perf mode), or a failed baseline/structural phase when phase-mode tracing
  is explicitly enabled with `QA_AUTOTRACE=1`. Passing phases are discarded.

A run is also checked against a checked-in baseline (see "Baseline
regression checks" below) for a real pass/fail outcome.

## Targeting a PR's preview VM (`--pr`)

After a PR is approved by a trusted reviewer with green CI, the Preview VM
Factory (see `docs/preview-vm-factory-plan-v1.md`) spins up an ephemeral
`mog-pr-<N>` VM, deploys the client + SpacetimeDB, and posts a single
announce comment on the PR. Instead of hunting for the VM's IP in gcloud,
point the harness straight at it:

```powershell
cd client
npm run qa:harness -- --pr 20
```

This resolves the PR's announce comment to the remote URL and drives the
harness against it, **skipping the local WSL SpacetimeDB / Vite bootstrap**
— the VM already serves the client at `/` and its own SpacetimeDB via the
same-origin `/v1` proxy. Requires the `gh` CLI authenticated for the repo.

How resolution works: it reads the PR's comments (`gh api
repos/<owner>/<repo>/issues/<N>/comments`), finds the one comment carrying
the `<!-- mog-preview-announce -->` marker (taking the most recent if more
than one), and parses the ```json fence for `url`. Clear errors surface
when nothing is announced yet ("no preview VM announced on PR N — has it
been approved?"), when the fence is malformed, or when it lacks a `url`.

The repo is inferred from the `public` git remote; override with
`QA_PREVIEW_REPO=owner/name`. `QA_PR=20` is equivalent to `--pr 20`.

Before it shells out to `gh`, a `--pr` run preflights the `qa-harness-pr` tool
(`tools/env-requirements/`). It prints one line naming your environment, then
the per-requirement results. If a fail-severity requirement is unmet it leads
with a derived banner — e.g. from WSL, where `gh` isn't installed:

```
[run-harness] 'qa-harness-pr' is not supported in wsl (missing: gh-cli, gh-auth); supported environments: ci-runner, windows-native
```

That's the environment-requirements system telling you `--pr` runs from the
Windows host or CI, not WSL — see the derived
[`docs/environment-matrix.md`](../../docs/environment-matrix.md). Re-run the
same check standalone with `node tools/env-requirements/preflight.mjs --tool
qa-harness-pr`. (`windows-node-modules` is declared win32-only, so it SKIPs off
Windows rather than giving confusing "reinstall from PowerShell" advice.)

> Local baselines were captured against loopback, not real network RTT, so
> baseline drift on a `--pr` run is expected signal about network/feel, not
> an automatic "client is broken." Prefer structural + invariant checks for
> remote gates.

## Why WSL2, and why headed (not headless)

- The SpacetimeDB CLI is Linux-only, so the harness runs its own SpacetimeDB
  instance inside WSL2 Ubuntu, fully isolated from the shared production VM
  (which also hosts `mog-game-v1` and isn't meant for ad hoc dev/test load).
  `client/vite.config.ts` hardcodes its `/v1` proxy target to
  `127.0.0.1:3000`, so the Vite dev server and SpacetimeDB instance must be
  reachable on the same loopback — WSL2 forwards its loopback ports to
  Windows by default, so this works with the Vite dev server running
  normally on Windows.
- Playwright's CDP-dispatched mouse clicks **do** trigger a real, trusted
  `requestPointerLock()` in Chromium (confirmed empirically) — but in
  **headless** Chromium, acquiring pointer lock leaves the CDP session
  hanging on the next command (a known headless Chromium limitation, not a
  Playwright bug). Headed Chromium does not have this problem. Since
  camera-look and spell-aim raycasting depend on pointer lock being real,
  the harness launches headed by default. Movement/jump (keyboard-only, not
  gated on pointer lock) would work headless, but combat/camera coverage
  would silently be skipped, so headed is the default for full coverage.
  Override with `QA_HEADLESS=1` if you only care about movement and don't
  mind the camera/spell-aim phases being unreliable.

## One-time setup (already done on this machine)

```powershell
wsl --install -d Ubuntu --no-launch
wsl -d Ubuntu -u root -- bash -c "curl -sSf https://install.spacetimedb.com | sh -s -- --yes"
wsl -d Ubuntu -u root -- bash -c "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
wsl -d Ubuntu -u root -- /root/.cargo/bin/rustup target add wasm32-unknown-unknown
wsl -d Ubuntu -u root -- apt-get install -y build-essential pkg-config
```

Then publish the server module into the WSL instance once:

```powershell
npm run qa:env:up -- --publish   # from client/, equivalent to: wsl ... start-local-stdb.sh --publish
```

(`npm run qa:harness -- --publish` also accepts the flag, for re-publishing
after a server module change.)

If you're setting this up on a different machine, repeat the install steps
above first — `npm run qa:env:up` only starts/publishes, it doesn't install
the CLI or Rust toolchain.

## Running the harness

```powershell
cd client
npm run qa:harness                  # local (WSL SpacetimeDB + Vite)
npm run qa:harness -- --pr 20       # a PR's live preview VM (see "Targeting a PR's preview VM")
```

Local mode will, idempotently:
1. Ensure SpacetimeDB is running in WSL2 (starts it if not; does **not**
   auto-publish — pass `--publish` after the script name if you changed
   `server/spacetimedb`).
2. Ensure the Vite dev server is running on `http://localhost:5173` (starts
   it detached if not).
3. Launch headed Chromium, join once as `wizard` and once as `paladin`,
   drive the full input sequence for each, and write one JSON + CSV trace
   per class to `client/qa-harness/runs/<timestamp>-<label>-<class>.{json,csv}`.

To regenerate a report from a stored run, or visually diff two runs (the
second run overlays every chart as a dashed reference line and appears as
gray `(ref …)` values in the summary table):

```powershell
npm run qa:report -- qa-harness/runs/<run>.ndjson
npm run qa:report -- qa-harness/runs/<after>.ndjson --against qa-harness/runs/<before>.ndjson --out compare.html
```

(Legacy pretty-printed `.json` traces from before the NDJSON format are
still accepted by `--against` and as the input.)

Useful env vars:
- `QA_PHASES=jump_idle` — run only the named phases and/or groups
  (`movement`, `network`, `combat`, `matrix`), comma-separated, always in registry
  order (default: everything applicable to the class). This is the fast
  path while debugging one action: `QA_CLASSES=wizard QA_PHASES=walk_forward`
  is a ~10s run. Baseline comparison then only checks the phases actually
  run.
- `QA_TIER=smoke|full` — controls generated movement coverage (default
  `smoke`). Smoke runs seven representative cardinal/diagonal, walk/sprint,
  jump/turn cases; full runs all 48 combinations. Handwritten phases and
  generated capability phases run in both tiers. An explicitly named phase in
  `QA_PHASES` always runs regardless of tier.
- `QA_CLASSES=wizard` — run only named loadout presets (default: **every
  catalog preset**, e.g. `wizard,paladin` and `acolyte` when that preset
  exists). Join UI clicks the catalog **label** button (not a hardcoded
  wizard/paladin branch).
- `QA_RUN_LABEL=before-refactor` — tag output filenames, e.g. for diffing
  `before-refactor` vs `after-refactor` runs.
- `QA_HEADLESS=1` — run headless (movement only is reliable; see caveat above).
- `QA_VIDEO=0` — disable per-session Playwright `.webm` capture. Video is on
  by default; reports omit the video player and video offsets when no video is
  present.
- `QA_AUTOTRACE=1` — in default phase mode, stage Chromium traces per phase
  and keep only traces for phases that fail the existing baseline/structural
  checks. Perf mode stages traces by default and keeps only budget failures.
- `QA_CLIENT_URL=http://localhost:5173` — point at a different dev server. A
  non-loopback URL is treated as remote and skips the local SpacetimeDB/Vite
  bootstrap (same as `--pr`).
- `--pr 20` / `QA_PR=20` — resolve a PR's preview-VM announce comment and
  target that remote URL, skipping local bootstrap (see "Targeting a PR's
  preview VM").
- `QA_PREVIEW_REPO=owner/name` — override the repo used for `--pr` announce
  lookup (default: inferred from the `public` git remote).
- `QA_WEB_MODE=preview` — serve the built bundle (`vite preview`) instead of
  the dev server; requires `client/dist/` to exist (`npm run build`, or the
  downloaded build artifact in CI). CI uses this so the playtest exercises
  the production artifact that actually deploys.
- `QA_JOIN_TIMEOUT_MS=90000` — budget for the structural waits (join dialog
  visible, first player frame). CI raises this because SwiftShader + full
  asset parsing stall the page much longer than a local GPU; it does not
  affect any regression tolerance. On failure the harness writes a
  screenshot + console tail to `runs/` (uploaded as the CI trace artifact).
- `QA_VIEWPORT=640x360` — shrink the browser viewport (default: Playwright's
  1280×720). Software-rendered CI (SwiftShader) pays per pixel, so the CI
  smoke job runs quarter-size; local GPU runs leave this unset.
- `QA_RENDER_READY_FRAMES=10` — how many new rAF frames `waitForRenderLoop`
  requires before driving input (default 30). CI lowers it: at SwiftShader
  frame rates 30 frames can outlast any sane timeout, and the wait only needs
  to prove the loop is alive.
- `QA_BASELINE_DIR=qa-harness/baselines/ci` — compare against (or update) a
  different baseline directory. Baselines are environment-specific: CI runs
  on SwiftShader software rendering at a much lower frame rate than a local
  GPU, so frame-scale metrics have a different shape there, not just more
  noise. CI compares only against runner-captured baselines in
  `baselines/ci/` (captured via the manual `qa-baseline.yml` workflow, then
  reviewed and committed like any baseline change); local runs default to
  `baselines/`. Until `baselines/ci/` is committed, CI skips the baseline
  comparison and still enforces the structural checks.

To diff two runs, prefer `qa:report --against` (above); raw CSVs still diff
fine for tooling. Traces are reproducible in structure but not in exact
floats — expect minor float noise frame-to-frame even on identical code,
since real wall-clock frame timing/render timing isn't deterministic. The
point is to compare shapes/magnitudes across phases, not exact equality.


## Latency proxy and grid mode

The harness can route SpacetimeDB WebSocket traffic through an in-process TCP
relay (`qa-harness/net-proxy.ts`) instead of relying on Chrome DevTools
Protocol network emulation. CDP `Network.emulateNetworkConditions` does not
reliably delay WebSocket traffic after the connection is already established,
which is why this proxy exists. For reproducing issue #216, prefer this proxy
over the older `lag_spike_walk_forward` phase. That phase intentionally stays
in `scenarios.ts` until the new mechanism is verified live; live verification
is deferred to another agent/session and has not happened yet as of this PR.

The proxy can shape both directions of the TCP byte stream with delay, jitter,
and an approximate throughput budget. It can also simulate a hard disconnect by
destroying both ends after `dropAfterMs`. It cannot simulate true packet loss:
TCP guarantees ordered delivery at the transport layer, so packet loss is not
representable from a TCP relay without becoming either delayed delivery or a
connection failure.

To add one latency lane to any normal harness mode:

```powershell
$env:QA_NET_PROFILE='150/20'; npm run qa:harness
```

The value is `<delayMs>/<jitterMs>`. The harness starts one loopback proxy in
front of local SpacetimeDB (`127.0.0.1:3000`) and loads every bot with
`?qa&stdb=ws://127.0.0.1:<proxyPort>` so the client connects through that
lane.

Grid mode sweeps latency cells and writes a combined report:

```powershell
$env:QA_MODE='grid'; npm run qa:harness
$env:QA_GRID_LATENCIES='0,60,150,300'; $env:QA_MODE='grid'; npm run qa:harness
```

By default, grid mode runs the `movement` phase group for each configured
class at `0,60,150,300` ms. `QA_PHASES` can narrow or replace that subset, and
`QA_GRID_LATENCIES` controls the cell list. Jitter defaults to 10% of each
cell's delay.

`QA_GRID_BURST=<delayMs>x<durationMs>@<periodMs>` layers a periodic latency
burst on top of every cell — e.g. `300x500@3000` spikes each connection to
300 ms for the first 500 ms of every 3 s window, then returns to the cell's
base latency. Steady latency did not reproduce #216's reconciliation
teleport; the burst exists to test the *transition* into and out of elevated
latency, which is the leading hypothesis:

```powershell
$env:QA_GRID_LATENCIES='60'; $env:QA_GRID_BURST='300x500@3000'; $env:QA_MODE='grid'; npm run qa:harness
``` Grid mode is diagnostic: it does not compare against baselines,
and the combined HTML report plus console table show `netDisplacement`,
`maxFrameDelta`, `meanCorrErr`, and `meanOffset` per class, phase, and latency
cell so degradation trends are visible at a glance.

For asymmetric per-bot latency, start two proxy lanes in the same Node process
with different profiles and load each page with its own gated override, for
example:

```text
http://localhost:5173/?qa&stdb=ws://127.0.0.1:34001
http://localhost:5173/?qa&stdb=ws://127.0.0.1:34002
```

The `stdb` URL parameter is ignored unless the normal QA gate is active
(`?qa` or truthy `VITE_QA_MODE`), so production pages keep their computed
SpacetimeDB URL.

## Two-bot duel mode

```powershell
$env:QA_MODE='duel'; npm run qa:harness
```

Runs two concurrent bots in the same world: the paladin walks out of the
shared spawn, the wizard aims (closed-loop — mouse sensitivity is probed
live and camera yaw corrected from telemetry) and fires until the paladin's
`hp` channel drops. The pass/fail signal is server-authoritative damage
read from the *victim's* page, so a pass proves input → reducer → damage →
table update → subscription round-trips between two clients. Both bots'
traces and reports are written; the paladin's report shows the attack
arriving (`fireballProjectiles` pulsing, `hp` stepping down). Duel runs
skip phase baselines — structural checks plus the interaction assertion
decide the verdict.

## Performance profiling (observation mode)

```powershell
$env:QA_MODE='perf'; npm run qa:harness   # or: npm run qa:perf
```

Runs a suite of profiling scenarios and reports the numbers. Perf budgets are
printed by default and enforced only with `QA_PERF_ENFORCE=1`; baseline
gating still does not apply to these metrics. What it captures:

- **Long tasks** — a `PerformanceObserver('longtask')` buffers every
  main-thread stall >50ms (`{startTime, duration, phase, attribution}`).
  Long-task attribution from the browser is deliberately coarse (usually just
  `unknown`/`self`), so it rarely points at a specific script.
- **Frame deltas** — derived from the frame trace (each frame already carries
  `t` + `phase`), reduced per phase to p50/p95/p99, worst delta, and a count
  of frames slower than 50ms. A stall that straddles a phase boundary is
  attributed to the phase where the frame loop *resumes* (the giant delta is
  recorded on the first frame after the block).
- **Resource timeline** — `performance.getEntriesByType('resource')`
  snapshotted at collection; the report lists the top offenders by duration
  and by transfer size. The resource-timing buffer is raised to 5000 entries.
- **Memory** — `performance.memory.usedJSHeapSize` sampled ~1/s (Chrome-only).
  **Caveat:** without cross-origin isolation (COOP/COEP) Chrome quantizes and
  effectively freezes this value, so heap growth reads as ~0 in the dev-server
  setup; the samples are recorded but heap deltas are not resolvable here
  without `--enable-precise-memory-info` or COOP/COEP headers.

All of it is injected harness-side (`page.addInitScript`, `perf-collectors.ts`)
— the game is never modified — and correlated to the same `__qaPhase` windows
and `performance.now()` clock as the frame trace. Perf records ride in the
same NDJSON (`longtask`/`memory`/`resource`/`perfmeta` line types) and the run
report grows a perf section (per-phase table with video offsets for worst
frame gaps, budget rows with links to kept Chrome traces, long-task list,
resource offenders, cold-load landmarks). A compact per-phase table is also
printed to the console at the end of the run.

Scenarios:
- **cold-load** (both classes) — fresh context → `goto` → join, landmarking
  time-to-join-screen, time-to-playable, and time-to-first-frames; captures the
  full resource timeline and all load-time long tasks (under the `startup`
  phase).
- **first-cast** (wizard) — 5s idle baseline, then fireball ×2 and lightning
  ×2, each cast in its own 3s phase window (`fireball_1`/`fireball_2`/
  `lightning_1`/`lightning_2`). The first-vs-second delta per spell is the
  headline number.
- **player-join** — bot A idles (5s baseline), bot B (other class) joins the
  same world; A's stall in the `after_b_join` window is compared to its
  `pre_join_baseline`. `playersOnline` on A confirms the join round-tripped.
- **remote-motion** — bot B walks continuously ~10s while bot A observes.
  **Gap:** the master client publishes only the *local* player's `__playerDebug`
  and local `__gameDebug` channels — no remote-player render position — so B's
  rendered position on A's page is not measurable without a game change. The
  run records A's own frame cost while a remote player moves and logs the gap.

Type-check the harness (it isn't covered by `tsc -b`, which only builds `src`
and `vite.config.ts`) with `npm run qa:typecheck`.

The `matrix` group is generated from eight movement directions, sprint state,
and jump/camera-turn modifiers, plus combat actions derived from each
character's configured capabilities. Every generated phase carries a
config-derived invariant expectation. Straight movement checks expected speed
and straightness, camera turns enforce the configured maximum speed, and
capability actions enforce stationary behavior. Generated phases are therefore
excluded from recorded baselines; adding a class capability or matrix axis does
not require baseline capture.

## Baseline regression checks

Every run is also reduced to one summary per `phase` (net displacement, path
length, mean/stddev correction error, max frame-to-frame jump — see
`trace-stats.ts`) and, if `client/qa-harness/baselines/<class>.json` exists,
checked against it (`compare-baseline.ts`). `run-harness.ts` exits non-zero
if any phase drifts outside tolerance, or if structural checks (NaN values,
dropped positions) fail — that's what makes CI's `browser-playtest` job a
real regression gate rather than just "did the browser crash."

**Tolerances are computed from the baseline's own measured noise, not
hardcoded expected values.** Two runs of identical code still differ
frame-to-frame (real wall-clock timing isn't deterministic — see above), so
the allowed drift for e.g. correction error is `baseline mean + N × baseline
stddev`, and position drift is a percentage of the distance actually
traveled in that phase — both derived from whatever baseline is currently
checked in. Only the sensitivity knobs themselves (`N`, the percentage, the
floors) are fixed constants in `compare-baseline.ts`.

**Updating the baseline** (a deliberate act, not automatic — the baseline is
"current accepted reality," and moving it should be a reviewed decision, not
silent drift):

```powershell
npm run qa:baseline:update
```

This re-runs the full sequence and overwrites `baselines/<class>.json` with
the new summary. The resulting diff is small and readable (it's a handful of
numbers per phase, not the raw trace) — review it like any other change
before merging, since it's redefining what "correct" means for this test
going forward.

**Known gap:** the current `baselines/paladin.json` was bootstrapped from an
existing capture, and its `walk_forward` phase (first movement after join)
shows ~6x the mean/stddev correction error of wizard's identical phase — a
real, pre-existing issue, not a fluke. Because the baseline captures
behavior as-is rather than a correctness spec, this gate won't flag that
issue — only a *worsening* of it. Fixing it and then running
`qa:baseline:update` is how it'd eventually get locked in as a regression
target instead of quietly-tolerated noise.

## What the trace records

One record per `requestAnimationFrame` tick, tagged with the current `phase`
(`walk_forward`, `sprint_forward`, `jump_while_moving`,
`lag_spike_walk_forward`, `cast_fireball`, `attack_slash`, etc. — see
`run-harness.ts` for the full phase list):

| field | source |
|---|---|
| `t` | `performance.now()` at collection time |
| `phase` | label set by the harness before each input action |
| `simPosition` | `window.__playerDebug.simPosition` |
| `renderPosition` | `window.__playerDebug.renderPosition` |
| `visualOffset` / `offsetLength` | `window.__playerDebug.visualOffset` / `.offsetLength` |
| `cameraPosition` | `window.__playerDebug.cameraPosition` |
| `localServerTick` | `window.__playerDebug.localServerTick` (stringified, it's a u64) |
| `localCorrectionError` | `window.__playerDebug.localCorrectionError` (added to the debug object specifically for this harness — mirrors `metricsRef.current.localCorrectionError`) |

## Known limitations

- The lag spike phase still uses CDP `Network.emulateNetworkConditions`, which
  does not reliably delay already-established WebSocket connections. Treat
  `lag_spike_*` phase data as legacy/indicative and use the TCP latency proxy
  when the question depends on real SpacetimeDB WebSocket delay.
- The harness opens a visible Chromium window (headed mode) — don't use a
  remote/headless-only box to run it as-is.
- Each run joins as a fresh bot identity (no saved auth token reused), so
  player state always starts clean.

