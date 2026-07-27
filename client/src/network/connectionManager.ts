/**
 * The reconnect state machine, with the SDK held at arm's length.
 *
 * `spacetimedb@2.1.0` does not retry: its socket handlers emit `disconnect` /
 * `connectError`, set `isActive = false`, and stop (see issue #121). Every
 * recovery policy therefore has to live on our side of the builder, and this
 * module is where it lives — deliberately *not* inside the React hook, because
 * a policy that only exists inside `useEffect` can only be tested by rendering
 * a component, and the client has no DOM test environment. Everything here is
 * plain functions over injected dependencies, so `connectionManager.test.ts`
 * drives a whole reconnect sequence with a fake connection and a fake clock.
 *
 * `network/useSpacetimeConnection.ts` is the adapter: it supplies the real
 * `openConnection` (the `DbConnection.builder()` chain), the real token
 * storage, and real timers, then republishes the manager's state as React
 * state. Nothing in this file imports the SDK at runtime — only types.
 *
 * ## What a reconnect means to the server
 *
 * Answered against the server rather than assumed (`server/spacetimedb/src/lib.rs`,
 * `player.rs`, and the pre-existing live test `client/test-reconnect.ts`):
 *
 *  - `identity_disconnected` deletes the `client_session` row and, once no
 *    session for that identity remains, calls `player::cleanup_player` — the
 *    live `player` / `player_transform` / `player_health` rows are deleted and
 *    folded into `logged_out_player`.
 *  - `identity_connected` only re-inserts a `client_session`. It does **not**
 *    bring the player back.
 *  - Reconnecting with the same saved auth token restores the same *identity*,
 *    and `join_game` then restores the archived row (original username,
 *    health, and position — it ignores the username passed on the restoring
 *    call).
 *
 * So the answer to "is `join_game` needed again after a reconnect?" is **yes**,
 * and calling it is safe unconditionally: `join_game` is a documented no-op
 * when a live `player` row already exists (`player.rs:11`), which covers the
 * race where cleanup has not run yet or another tab still holds a session.
 * The rejoin itself is the host's job — see `game/App.tsx` — because the
 * username lives in the UI layer; this module only reports *that* a reconnect
 * happened, via `onConnected`'s `reconnected` flag.
 */

/**
 * `connecting`        — the first attempt, before we have ever been connected.
 * `connected`         — live socket, subscriptions applied by the host.
 * `reconnecting`      — dropped, retrying, still within `OFFLINE_AFTER_ATTEMPTS`.
 * `offline-retrying`  — retries have run past that threshold, so this is more
 *                       likely "the network is gone" than "one bad socket". The
 *                       distinction is purely for what the UI says; the retry
 *                       loop itself never gives up.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline-retrying';

/** First retry lands ~0.5s after the drop — fast enough to be invisible on a blip. */
export const RECONNECT_BASE_DELAY_MS = 500;
/** The exponential ceiling. A game client keeps trying forever, but never faster than this. */
export const RECONNECT_MAX_DELAY_MS = 10_000;
/** Attempt count at which `reconnecting` becomes `offline-retrying`. 5 attempts ≈ 15s of trying. */
export const OFFLINE_AFTER_ATTEMPTS = 5;
/**
 * How much of each delay is randomised. The delay is drawn from
 * `[(1 - JITTER_FRACTION) * target, target]`, so jitter only ever pulls a retry
 * *earlier* than the nominal schedule — the ceiling stays exactly
 * `RECONNECT_MAX_DELAY_MS`, which keeps the documented schedule an upper bound
 * rather than an average.
 */
export const RECONNECT_JITTER_FRACTION = 0.3;

/**
 * The nominal (pre-jitter) delay before retry number `attempt` (1-based):
 * 500, 1000, 2000, 4000, 8000, then 10000 forever.
 */
export function backoffTargetMs(attempt: number): number {
  const exponential = RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, RECONNECT_MAX_DELAY_MS);
}

/** Pulls `target` down by up to `RECONNECT_JITTER_FRACTION`, so a fleet of clients does not retry in lockstep. */
export function applyJitter(target: number, random: number): number {
  return Math.round(target * (1 - RECONNECT_JITTER_FRACTION * random));
}

/** The full policy: what to wait before retry `attempt`, jitter included. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  return applyJitter(backoffTargetMs(attempt), random());
}

/** The status a given retry-attempt count should present as. */
export function statusForAttempt(attempt: number): ConnectionStatus {
  return attempt >= OFFLINE_AFTER_ATTEMPTS ? 'offline-retrying' : 'reconnecting';
}

/**
 * The slice of `DbConnection` this module touches. Structural, so the test's
 * fake connection satisfies it without constructing a real SDK object.
 */
export interface ClosableConnection {
  disconnect(): void;
}

/** The callbacks one connection attempt reports through — mirrors the builder's own shape. */
export interface ConnectionAttemptHandlers<TConn, TIdentity> {
  /** The saved auth token to present, if any. Absent means "give me a fresh anonymous identity". */
  token?: string;
  onConnect(connection: TConn, identity: TIdentity, token: string): void;
  onConnectError(error: unknown): void;
  onDisconnect(): void;
}

export interface ConnectionManagerDeps<TConn extends ClosableConnection, TIdentity> {
  /** Starts one attempt. Must report its outcome through exactly one of the handlers. */
  openConnection(handlers: ConnectionAttemptHandlers<TConn, TIdentity>): void;
  loadToken(): string | undefined;
  saveToken(token: string): void;
  clearToken(): void;
  /**
   * Fires on every successful connect. `reconnected` is false for the first
   * connect of this manager's life and true for every recovery after a drop —
   * the host uses it to decide whether to re-issue `join_game`.
   */
  onConnected(connection: TConn, identity: TIdentity, info: { reconnected: boolean }): void;
  /** Fires on an unexpected drop, before the retry is scheduled. Not fired for a user-initiated stop. */
  onDisconnected(): void;
  /** Fires whenever `status` or `attempt` changes. */
  onStateChange(state: ConnectionManagerState): void;
  /** Injected so tests can run a fake clock. */
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  /** Injected so tests can pin the jitter. */
  random(): number;
}

export interface ConnectionManagerState {
  status: ConnectionStatus;
  /** 0 while connected; otherwise how many retries have been scheduled since the last success. */
  attempt: number;
}

export interface ConnectionManager<TConn> {
  start(): void;
  /**
   * Tears the manager down for good — the unmount / "forget me" path. Marks
   * the close user-initiated so the resulting `onDisconnect` does not schedule
   * a retry, which is the whole distinction between "the network dropped us"
   * and "we left".
   */
  stop(options?: { notify?: boolean }): void;
  getState(): ConnectionManagerState;
  getConnection(): TConn | null;
}

export function createConnectionManager<TConn extends ClosableConnection, TIdentity>(
  deps: ConnectionManagerDeps<TConn, TIdentity>,
): ConnectionManager<TConn> {
  let status: ConnectionStatus = 'connecting';
  let attempt = 0;
  let connection: TConn | null = null;
  let timer: unknown = null;
  /** Set by `stop()`. Every callback checks it, because in-flight SDK attempts still land after unmount. */
  let stopped = false;
  let started = false;
  /** True once any attempt has succeeded — separates "bad saved token" from "we got dropped". */
  let everConnected = false;

  const setState = (nextStatus: ConnectionStatus, nextAttempt: number) => {
    if (status === nextStatus && attempt === nextAttempt) return;
    status = nextStatus;
    attempt = nextAttempt;
    deps.onStateChange({ status, attempt });
  };

  const clearPendingRetry = () => {
    if (timer === null) return;
    deps.clearTimer(timer);
    timer = null;
  };

  /**
   * One attempt. `allowTokenReset` reproduces the behaviour this replaces: a
   * saved token that the server rejects on the *initial* connect is discarded
   * once and the connect retried anonymously. That fallback is deliberately
   * scoped to the first connect — after a successful session, a rejected token
   * is far more likely a transient server state than a bad token, and throwing
   * the identity away would silently orphan the player's character.
   */
  const attemptConnect = (token: string | undefined, allowTokenReset: boolean) => {
    if (stopped) return;

    deps.openConnection({
      ...(token ? { token } : {}),
      onConnect: (nextConnection, identity, nextToken) => {
        if (stopped) {
          nextConnection.disconnect();
          return;
        }

        const reconnected = everConnected;
        connection = nextConnection;
        everConnected = true;
        deps.saveToken(nextToken);
        setState('connected', 0);
        deps.onConnected(nextConnection, identity, { reconnected });
      },

      onConnectError: (error) => {
        if (stopped) return;

        if (token && allowTokenReset && !everConnected) {
          deps.clearToken();
          attemptConnect(undefined, false);
          return;
        }

        console.warn('SpacetimeDB connect failed; will retry:', error);
        scheduleRetry();
      },

      onDisconnect: () => {
        if (stopped) return;
        // An SDK `disconnect` after a successful connect is the drop this whole
        // module exists for. Before a successful connect it is a redundant
        // signal alongside `connectError` — `scheduleRetry` is idempotent per
        // attempt because a pending timer short-circuits it.
        connection = null;
        deps.onDisconnected();
        scheduleRetry();
      },
    });
  };

  const scheduleRetry = () => {
    if (stopped || timer !== null) return;

    const nextAttempt = attempt + 1;
    setState(statusForAttempt(nextAttempt), nextAttempt);

    const delay = applyJitter(backoffTargetMs(nextAttempt), deps.random());
    timer = deps.setTimer(() => {
      timer = null;
      // The token is re-read (not captured) so a token saved by a later
      // successful connect, or cleared by the fallback above, is honoured.
      attemptConnect(deps.loadToken(), false);
    }, delay);
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      setState('connecting', 0);
      attemptConnect(deps.loadToken(), true);
    },

    stop({ notify = false } = {}) {
      if (stopped) return;
      stopped = true;
      clearPendingRetry();
      const live = connection;
      connection = null;
      live?.disconnect();
      if (notify) deps.onDisconnected();
    },

    getState() {
      return { status, attempt };
    },

    getConnection() {
      return connection;
    },
  };
}
