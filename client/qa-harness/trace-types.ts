export type Vec3 = { x: number; y: number; z: number };

/**
 * Wave 3F (v2 rewrite): the pre-rewrite client published a rich `window.__playerDebug`
 * (simPosition/renderPosition/visualOffset/localCorrectionError/cameraPosition) for
 * client-side-prediction visual-fidelity checks. The v2 client exposes only
 * `window.__mogGame` (`{localPosition, remoteCount, joined, identityHex, store}` — see
 * `client/src/game/App.tsx`) — a live row-level store, not a per-frame reconciliation trace.
 * There is no reconciliation/offset telemetry to capture anymore, so those fields are gone
 * (a real reduction in what this harness can prove about CSP smoothing — see
 * `docs/character-pipeline.md`'s wave notes if that fidelity is ever restored). `simPosition`
 * is kept (sourced from `__mogGame.localPosition`) since it is still the backbone of the
 * movement invariants (`invariants.ts` / `trace-stats.ts`). `channels` is repointed at
 * generic numeric snapshots read off `__mogGame.store` for the local identity each frame
 * (health, action phase, resource amounts) — same "harness never hardcodes channel names"
 * contract as before, new source table.
 */
export type TraceRecord = {
  t: number;
  phase: string;
  simPosition: Vec3 | null;
  joined: boolean;
  remoteCount: number;
  /**
   * Generic per-identity store snapshot, keyed by `<table>_<field>` (e.g. `health_current`,
   * `actionState_phase`, `resource_potion_charge`). Derived once per frame from
   * `window.__mogGame.store` for the local identity — the harness never hardcodes which keys
   * exist; see `installCollectors` in page-driver.ts. Booleans are recorded as 0/1; null means
   * the page wasn't joined yet that frame.
   */
  channels: Record<string, number> | null;
};

/**
 * One input the harness delivered (or one page-side transition), recorded
 * in-page on the same performance.now() clock as the frame trace — so a
 * metric anomaly can be read against the exact input that preceded it.
 */
export type InputEvent = {
  t: number;
  kind: 'keydown' | 'keyup' | 'mousedown' | 'mouseup' | 'pointerlockchange' | 'phase';
  detail: string;
};

/** Bot label used in filenames/logs. v2 has no character classes — every joined player has
 * every capability (shared/actions.json's SLOT_BINDINGS are universal), so this is now just
 * a run label, not a loadout selector. Kept as a named type (not inlined `string`) so the
 * many call sites that threaded a "class" through stay self-documenting about what they now
 * hold. */
export type BotLabel = string;

// ---------------------------------------------------------------------------
// Performance instrumentation (harness-injected; the game is not modified).
// All of this is captured page-side by perf-collectors.ts and correlated to
// the same __qaPhase windows and performance.now() clock as the frame trace.
// Perf budgets are evaluated after capture and enforced only with QA_PERF_ENFORCE=1.

/**
 * One main-thread stall >50ms reported by PerformanceObserver('longtask').
 * `attribution` is whatever the browser exposes (usually just "unknown" /
 * "self" — longtask attribution is deliberately coarse for privacy).
 */
export type LongTaskRecord = {
  startTime: number;
  duration: number;
  phase: string;
  attribution: string[];
};

/** One performance.memory sample (Chrome-only API), ~1/s. */
export type MemorySample = {
  t: number;
  phase: string;
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

/**
 * One SpacetimeDB WebSocket frame seen by the harness meter (perf-collectors.ts
 * wraps window.WebSocket before app scripts run). `dir` is 'in' for a frame the
 * page received, 'out' for one it sent; `bytes` is the payload size. Every frame
 * on the game socket is counted, not player_transform specifically — for #21 the
 * signal is the rate delta between phases (an AFK observer's inbound rate with a
 * mover idle vs walking, and a mover's outbound rate idle vs moving).
 */
export type WsMessageRecord = {
  t: number;
  phase: string;
  dir: 'in' | 'out';
  bytes: number;
};

/** One performance resource-timing entry, snapshotted at collection time. */
export type ResourceEntry = {
  name: string;
  initiatorType: string;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  duration: number;
  startTime: number;
};

/**
 * Cold-load lifecycle landmarks, measured harness-side (Node clock) around the
 * join flow. Only present on cold-load runs.
 */
export type LoadLandmarks = {
  /** page.goto issued → join dialog (name field) visible. */
  timeToJoinScreenMs: number;
  /** "join" clicked → window.__mogGame.joined is true. */
  timeToPlayableMs: number;
  /** "join" clicked → render loop demonstrably ticking (first frames). */
  timeToFirstFramesMs: number;
  /** page.goto issued → render loop ticking (end-to-end). */
  totalMs: number;
};

/**
 * Everything the perf collectors captured for one page. Frame deltas /
 * percentiles are NOT stored here — they are derived from RunData.frames
 * (each frame already carries t + phase), avoiding a second parallel trace.
 */
export type PerfData = {
  /** performance.now() at the moment the collectors were installed. */
  perfStartedAt: number;
  longTasks: LongTaskRecord[];
  memorySamples: MemorySample[];
  /** SpacetimeDB WebSocket frames in/out, phase-tagged (see WsMessageRecord). */
  wsMessages: WsMessageRecord[];
  resources: ResourceEntry[];
  landmarks?: LoadLandmarks;
};

export type TimeCorrelation = {
  /** Wall clock captured in-page at collector install time. */
  collectorWallTimeMs: number;
  /** performance.now() captured in-page with collectorWallTimeMs. */
  collectorPerformanceNowMs: number;
  /** Harness-side wall clock when the browser session was opened. */
  sessionStartedWallTimeMs: number;
  /** Harness-side wall clock immediately after the recorded page was created. */
  videoStartedWallTimeMs?: number;
};

export type VideoArtifact = {
  /** Sibling .webm filename relative to the report/trace artifact. */
  file: string;
  startedWallTimeMs: number;
};

export type RunMeta = {
  version: 2;
  /** Bot label (see BotLabel) — kept as `characterClass` field name across the harness's
   * existing report/trace-io/baseline machinery to avoid an unrelated rename sweep; v2 has no
   * character classes, this is just which bot produced the run. */
  characterClass: BotLabel;
  label: string;
  startedAt: string;
  clientUrl: string;
  time?: TimeCorrelation;
  video?: VideoArtifact;
  /** Kept Chromium traces by phase, as sibling filenames relative to the run report. */
  chromeTraces?: Record<string, string>;
};

/** Everything one harness run produces, before reduction to summaries. */
export type RunData = {
  meta: RunMeta;
  frames: TraceRecord[];
  events: InputEvent[];
  /** Injected performance instrumentation, when collected (see PerfData). */
  perf?: PerfData;
  /** Temporary local paths collected during session teardown; never written to NDJSON. */
  artifacts?: {
    videoTempPath?: string;
    autoTraceTempPaths?: Record<string, string>;
  };
};