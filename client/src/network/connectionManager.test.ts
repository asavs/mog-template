import { describe, expect, it } from 'vitest';
import {
  applyJitter,
  backoffTargetMs,
  createConnectionManager,
  statusForAttempt,
  OFFLINE_AFTER_ATTEMPTS,
  RECONNECT_JITTER_FRACTION,
  RECONNECT_MAX_DELAY_MS,
  type ConnectionAttemptHandlers,
  type ConnectionManagerState,
} from './connectionManager';

/**
 * The manager takes its transport, clock and randomness as dependencies precisely
 * so this file can exist: every case below drives a full reconnect sequence with
 * no SDK, no timers and no DOM. Same spirit as `game/sync.test.ts`'s FakeTable —
 * a hand-written double with the real structural surface, driven by hand.
 */

interface FakeConn {
  id: number;
  disconnectCount: number;
  disconnect(): void;
}

type FakeIdentity = { hex: string };

function fakeConnection(id: number): FakeConn {
  const conn: FakeConn = {
    id,
    disconnectCount: 0,
    disconnect() {
      conn.disconnectCount += 1;
    },
  };
  return conn;
}

interface PendingTimer {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
  fired?: boolean;
}

/** A manager plus every observation point a test needs, all recorded in order. */
function harness(options: { savedToken?: string; random?: number } = {}) {
  const attempts: (ConnectionAttemptHandlers<FakeConn, FakeIdentity> & { token?: string })[] = [];
  const timers: PendingTimer[] = [];
  const states: ConnectionManagerState[] = [];
  const connectedEvents: { connection: FakeConn; reconnected: boolean }[] = [];
  const connections: FakeConn[] = [];
  let disconnectedCount = 0;
  let token: string | undefined = options.savedToken;
  let tokenCleared = 0;

  const manager = createConnectionManager<FakeConn, FakeIdentity>({
    openConnection: (handlers) => {
      attempts.push(handlers);
    },
    loadToken: () => token,
    saveToken: (next) => {
      token = next;
    },
    clearToken: () => {
      token = undefined;
      tokenCleared += 1;
    },
    onConnected: (connection, _identity, info) => {
      connectedEvents.push({ connection, reconnected: info.reconnected });
    },
    onDisconnected: () => {
      disconnectedCount += 1;
    },
    onStateChange: (state) => {
      states.push({ ...state });
    },
    setTimer: (callback, delayMs) => {
      const timer: PendingTimer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as PendingTimer).cancelled = true;
    },
    random: () => options.random ?? 0,
  });

  /** Resolves the most recent attempt successfully, handing back the connection it created. */
  const succeed = (issuedToken = 'token-from-server') => {
    const conn = fakeConnection(connections.length + 1);
    connections.push(conn);
    attempts[attempts.length - 1].onConnect(conn, { hex: 'identity-1' }, issuedToken);
    return conn;
  };

  /** Runs the one pending, uncancelled retry timer. */
  const runPendingTimer = () => {
    const pending = timers.filter((timer) => !timer.cancelled && !timer.fired);
    if (pending.length !== 1) {
      throw new Error(`expected exactly one pending timer, found ${pending.length}`);
    }
    pending[0].fired = true;
    pending[0].callback();
  };

  return {
    manager,
    attempts,
    timers,
    states,
    connectedEvents,
    succeed,
    runPendingTimer,
    get disconnectedCount() {
      return disconnectedCount;
    },
    get token() {
      return token;
    },
    get tokenCleared() {
      return tokenCleared;
    },
    /** Delays of every timer that was actually scheduled, in order. */
    get delays() {
      return timers.map((timer) => timer.delayMs);
    },
  };
}

describe('backoff schedule', () => {
  it('walks 0.5s → 1s → 2s → 4s → 8s and then clamps at the 10s ceiling', () => {
    expect([1, 2, 3, 4, 5].map(backoffTargetMs)).toEqual([500, 1000, 2000, 4000, 8000]);
    // A game client keeps retrying forever, so every later attempt sits at the cap
    // rather than growing without bound.
    expect(backoffTargetMs(6)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(backoffTargetMs(7)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(backoffTargetMs(20)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it('jitters strictly downward, so the documented schedule stays an upper bound', () => {
    expect(applyJitter(4000, 0)).toBe(4000);
    expect(applyJitter(4000, 1)).toBe(4000 * (1 - RECONNECT_JITTER_FRACTION));

    for (const random of [0, 0.13, 0.5, 0.77, 1]) {
      const delay = applyJitter(RECONNECT_MAX_DELAY_MS, random);
      expect(delay).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS);
      expect(delay).toBeGreaterThanOrEqual(RECONNECT_MAX_DELAY_MS * (1 - RECONNECT_JITTER_FRACTION));
    }
  });

  it('reports offline-retrying only once retries have run past the threshold', () => {
    expect(statusForAttempt(1)).toBe('reconnecting');
    expect(statusForAttempt(OFFLINE_AFTER_ATTEMPTS - 1)).toBe('reconnecting');
    expect(statusForAttempt(OFFLINE_AFTER_ATTEMPTS)).toBe('offline-retrying');
    expect(statusForAttempt(OFFLINE_AFTER_ATTEMPTS + 30)).toBe('offline-retrying');
  });
});

describe('first connect', () => {
  it('presents the saved token when there is one', () => {
    const h = harness({ savedToken: 'saved-abc' });
    h.manager.start();
    expect(h.attempts).toHaveLength(1);
    expect(h.attempts[0].token).toBe('saved-abc');
  });

  it('presents no token when storage is empty, asking for a fresh identity', () => {
    const h = harness();
    h.manager.start();
    expect(h.attempts[0].token).toBeUndefined();
  });

  it('saves the server-issued token and reports a first connect, not a reconnect', () => {
    const h = harness();
    h.manager.start();
    const conn = h.succeed('issued-xyz');

    expect(h.token).toBe('issued-xyz');
    expect(h.manager.getState()).toEqual({ status: 'connected', attempt: 0 });
    expect(h.manager.getConnection()).toBe(conn);
    expect(h.connectedEvents).toEqual([{ connection: conn, reconnected: false }]);
  });
});

describe('unexpected drop', () => {
  it('notifies, drops the connection handle, and schedules the first retry', () => {
    const h = harness({ savedToken: 'saved-abc' });
    h.manager.start();
    h.succeed('issued-xyz');

    h.attempts[0].onDisconnect();

    expect(h.disconnectedCount).toBe(1);
    expect(h.manager.getConnection()).toBeNull();
    expect(h.manager.getState()).toEqual({ status: 'reconnecting', attempt: 1 });
    expect(h.delays).toEqual([backoffTargetMs(1)]);
  });

  it('reuses the saved token on the retry, so the identity survives the drop', () => {
    const h = harness();
    h.manager.start();
    h.succeed('issued-xyz');
    h.attempts[0].onDisconnect();

    h.runPendingTimer();

    expect(h.attempts).toHaveLength(2);
    // The whole point of the token round-trip: the same identity comes back, which
    // is what lets `join_game` restore the archived character server-side.
    expect(h.attempts[1].token).toBe('issued-xyz');
  });

  it('reports the recovery as a reconnect and resets the attempt counter', () => {
    const h = harness();
    h.manager.start();
    h.succeed();
    h.attempts[0].onDisconnect();
    h.runPendingTimer();
    const revived = h.succeed();

    expect(h.connectedEvents.map((event) => event.reconnected)).toEqual([false, true]);
    expect(h.manager.getState()).toEqual({ status: 'connected', attempt: 0 });
    expect(h.manager.getConnection()).toBe(revived);
  });

  it('never gives up: repeated failures walk the schedule, cap out, and keep retrying', () => {
    const h = harness();
    h.manager.start();
    h.succeed();
    h.attempts[0].onDisconnect();

    // Fail every scheduled retry, well past the cap.
    for (let i = 1; i <= 6; i += 1) {
      h.runPendingTimer();
      h.attempts[h.attempts.length - 1].onConnectError(new Error('still down'));
    }

    expect(h.delays).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
    expect(h.manager.getState()).toEqual({ status: 'offline-retrying', attempt: 7 });

    // And it is still armed, not stalled.
    expect(h.timers.filter((timer) => !timer.cancelled && !timer.fired)).toHaveLength(1);
  });

  it('flips to offline-retrying exactly at the threshold attempt', () => {
    const h = harness();
    h.manager.start();
    h.succeed();
    h.attempts[0].onDisconnect();

    for (let i = 1; i < OFFLINE_AFTER_ATTEMPTS; i += 1) {
      expect(h.manager.getState().status).toBe('reconnecting');
      h.runPendingTimer();
      h.attempts[h.attempts.length - 1].onConnectError(new Error('still down'));
    }

    expect(h.manager.getState()).toEqual({
      status: 'offline-retrying',
      attempt: OFFLINE_AFTER_ATTEMPTS,
    });
  });

  it('resets the schedule after a success, so the next drop retries fast again', () => {
    const h = harness();
    h.manager.start();
    h.succeed();
    h.attempts[0].onDisconnect();

    for (let i = 0; i < 4; i += 1) {
      h.runPendingTimer();
      h.attempts[h.attempts.length - 1].onConnectError(new Error('still down'));
    }
    h.runPendingTimer();
    h.succeed();

    const delaysBefore = h.delays.length;
    h.attempts[h.attempts.length - 1].onDisconnect();

    // Back to the bottom of the ladder — a later blip must not inherit the last
    // outage's capped delay and leave the player staring at a frozen world for 10s.
    expect(h.delays.slice(delaysBefore)).toEqual([backoffTargetMs(1)]);
    expect(h.manager.getState()).toEqual({ status: 'reconnecting', attempt: 1 });
  });
});

describe('user-initiated close', () => {
  it('disconnects the live connection and schedules nothing', () => {
    const h = harness();
    h.manager.start();
    const conn = h.succeed();

    h.manager.stop();
    expect(conn.disconnectCount).toBe(1);

    // The SDK really does emit `disconnect` after an explicit `disconnect()` —
    // this is the exact signal that must NOT be mistaken for a network drop.
    h.attempts[0].onDisconnect();

    expect(h.timers).toHaveLength(0);
    expect(h.attempts).toHaveLength(1);
    expect(h.disconnectedCount).toBe(0);
  });

  it('cancels a retry already in flight', () => {
    const h = harness();
    h.manager.start();
    h.succeed();
    h.attempts[0].onDisconnect();
    expect(h.timers).toHaveLength(1);

    h.manager.stop();

    expect(h.timers[0].cancelled).toBe(true);
  });

  it('disconnects a connection that lands after the stop instead of adopting it', () => {
    const h = harness();
    h.manager.start();
    h.manager.stop();

    const late = fakeConnection(99);
    h.attempts[0].onConnect(late, { hex: 'identity-1' }, 'issued-late');

    expect(late.disconnectCount).toBe(1);
    expect(h.manager.getConnection()).toBeNull();
    expect(h.connectedEvents).toHaveLength(0);
  });
});

describe('stale saved token', () => {
  it('is discarded once on the first connect and retried anonymously, with no wait', () => {
    const h = harness({ savedToken: 'stale-abc' });
    h.manager.start();

    h.attempts[0].onConnectError(new Error('bad token'));

    expect(h.tokenCleared).toBe(1);
    expect(h.attempts).toHaveLength(2);
    expect(h.attempts[1].token).toBeUndefined();
    // Immediate, not scheduled: a rejected token is not a network problem.
    expect(h.timers).toHaveLength(0);
  });

  it('falls back only once — a second failure backs off rather than looping', () => {
    const h = harness({ savedToken: 'stale-abc' });
    h.manager.start();
    h.attempts[0].onConnectError(new Error('bad token'));
    h.attempts[1].onConnectError(new Error('server down'));

    expect(h.attempts).toHaveLength(2);
    expect(h.delays).toEqual([backoffTargetMs(1)]);
  });

  it('keeps the token after a session has succeeded, so a blip cannot orphan the character', () => {
    const h = harness({ savedToken: 'saved-abc' });
    h.manager.start();
    h.succeed('issued-xyz');
    h.attempts[0].onDisconnect();
    h.runPendingTimer();

    h.attempts[1].onConnectError(new Error('server restarting'));

    // The regression this guards: treating a transient post-session error as a bad
    // token would throw away the identity and silently strand the player's character.
    expect(h.tokenCleared).toBe(0);
    expect(h.token).toBe('issued-xyz');
    expect(h.delays).toEqual([backoffTargetMs(1), backoffTargetMs(2)]);
  });
});

describe('state change notifications', () => {
  it('emits only on real transitions, never the same pair twice in a row', () => {
    const h = harness();
    h.manager.start();
    h.succeed();
    h.attempts[0].onDisconnect();
    h.runPendingTimer();
    h.attempts[1].onConnectError(new Error('still down'));
    h.runPendingTimer();
    h.succeed();

    // No leading `connecting` event: that is already the manager's initial state
    // (and the hook's initial React state), so `start()` emitting it would be the
    // duplicate this dedupe exists to prevent.
    expect(h.states).toEqual([
      { status: 'connected', attempt: 0 },
      { status: 'reconnecting', attempt: 1 },
      { status: 'reconnecting', attempt: 2 },
      { status: 'connected', attempt: 0 },
    ]);
    expect(h.manager.getState()).toEqual({ status: 'connected', attempt: 0 });
  });

  it('starts in connecting so a host that never gets an event still renders the right thing', () => {
    const h = harness();
    expect(h.manager.getState()).toEqual({ status: 'connecting', attempt: 0 });
    h.manager.start();
    expect(h.manager.getState()).toEqual({ status: 'connecting', attempt: 0 });
  });
});
