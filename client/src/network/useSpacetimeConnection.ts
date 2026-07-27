/**
 * React adapter over `connectionManager.ts`.
 *
 * The reconnect policy itself is deliberately not here — see that module's
 * doc for why (it is untestable inside a `useEffect`, and this client has no
 * DOM test environment). What lives here is only the part that genuinely needs
 * React or the SDK: building a real `DbConnection`, re-registering the table
 * callbacks and re-issuing the subscription set on every (re)connect, and
 * republishing the manager's state as React state.
 *
 * Two things the host needs to know about a reconnect, both surfaced here:
 *
 *  - `status` / `reconnectAttempt` drive the UI banner and let the host stop
 *    sending input while the socket is down. Inputs are dropped, never queued:
 *    a movement intent from before the drop is stale by the time the socket is
 *    back, and replaying it would fight the server's authoritative position.
 *  - `onSubscriptionApplied`'s `reconnected` flag tells the host that this is a
 *    recovery, not a first join — the server's `cleanup_player` has archived the
 *    player row, so the host must re-issue `join_game` to restore it. See
 *    `connectionManager.ts`'s doc for the full server-side reasoning.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Identity } from 'spacetimedb';
import { DbConnection } from '../generated';
import {
  clearSavedAuthToken,
  loadSavedAuthToken,
  saveAuthToken,
} from '../authStorage';
import { getStdbDatabaseName, getStdbUrl } from '../environment';
import {
  createConnectionManager,
  type ConnectionStatus,
  type ConnectionManagerState,
} from './connectionManager';

export type { ConnectionStatus } from './connectionManager';

const STDB_URL = getStdbUrl();
const STDB_DB_NAME = getStdbDatabaseName();

const GAME_SUBSCRIPTIONS = [
  'SELECT * FROM action_event',
  'SELECT * FROM config',
  'SELECT * FROM game_tick_schedule',
  'SELECT * FROM player',
  'SELECT * FROM player_action_state',
  'SELECT * FROM player_cooldown',
  'SELECT * FROM player_health',
  'SELECT * FROM player_input_ack',
  'SELECT * FROM player_resource',
  'SELECT * FROM player_slot_binding',
  'SELECT * FROM player_transform',
  'SELECT * FROM projectile',
];

/** Extra context the host gets on every subscription-applied, so a recovery is distinguishable from a first join. */
export interface SubscriptionAppliedInfo {
  /** False on the first connect of the page's life, true for every reconnect after a drop. */
  reconnected: boolean;
}

type UseSpacetimeConnectionOptions = {
  onConnected?: (connection: DbConnection, identity: Identity) => void;
  onDisconnected?: () => void;
  onSubscriptionApplied: (
    connection: DbConnection,
    identity: Identity,
    info: SubscriptionAppliedInfo,
  ) => void;
  registerTableCallbacks: (connection: DbConnection) => (() => void) | void;
};

type UseSpacetimeConnectionResult = {
  connected: boolean;
  connRef: MutableRefObject<DbConnection | null>;
  databaseName: string;
  forgetSavedConnection: () => void;
  hasSavedCharacter: boolean;
  identity: Identity | null;
  /** See `ConnectionStatus`. `connected` is kept as the boolean shorthand callers already use. */
  status: ConnectionStatus;
  /** Retries scheduled since the last success; 0 while connected. Shown in the reconnect banner. */
  reconnectAttempt: number;
  /**
   * Increments on every successful (re)connect. A stable identity for "which
   * session are we on" — the host keys client-side prediction state off it so
   * a reconnect starts from a clean buffer instead of replaying pre-drop ticks.
   */
  connectionEpoch: number;
};

export function useSpacetimeConnection({
  onConnected,
  onDisconnected,
  onSubscriptionApplied,
  registerTableCallbacks,
}: UseSpacetimeConnectionOptions): UseSpacetimeConnectionResult {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [hasSavedCharacter, setHasSavedCharacter] = useState(() => !!loadSavedAuthToken());

  const connRef = useRef<DbConnection | null>(null);
  const onConnectedRef = useRef(onConnected);
  const onDisconnectedRef = useRef(onDisconnected);
  const onSubscriptionAppliedRef = useRef(onSubscriptionApplied);
  const registerTableCallbacksRef = useRef(registerTableCallbacks);
  const tableCleanupRef = useRef<(() => void) | null>(null);
  const managerRef = useRef<ReturnType<typeof createConnectionManager<DbConnection, Identity>> | null>(null);

  useEffect(() => {
    onConnectedRef.current = onConnected;
    onDisconnectedRef.current = onDisconnected;
    onSubscriptionAppliedRef.current = onSubscriptionApplied;
    registerTableCallbacksRef.current = registerTableCallbacks;
  });

  useEffect(() => {
    const cleanupTableCallbacks = () => {
      tableCleanupRef.current?.();
      tableCleanupRef.current = null;
    };

    const manager = createConnectionManager<DbConnection, Identity>({
      /**
       * One `DbConnection.builder()` chain per attempt. The SDK has no reopen —
       * a dead connection stays dead (issue #121) — so every retry builds a
       * genuinely new connection rather than reviving the old object.
       */
      openConnection: ({ token, onConnect, onConnectError, onDisconnect }) => {
        const builder = DbConnection.builder()
          .withUri(STDB_URL)
          .withDatabaseName(STDB_DB_NAME)
          .onConnect(onConnect)
          .onConnectError((_ctx, err) => onConnectError(err))
          .onDisconnect(() => onDisconnect());

        if (token) builder.withToken(token);
        builder.build();
      },

      loadToken: () => loadSavedAuthToken(),
      saveToken: (token) => {
        saveAuthToken(token);
        setHasSavedCharacter(true);
      },
      clearToken: () => {
        clearSavedAuthToken();
        setHasSavedCharacter(false);
      },

      onConnected: (connection, id, { reconnected }) => {
        connRef.current = connection;
        setIdentity(id);
        setConnectionEpoch((epoch) => epoch + 1);
        onConnectedRef.current?.(connection, id);

        // A reconnect gets a brand-new store (`attachGameStore` allocates one
        // per call), so rows from the dead connection are dropped wholesale
        // rather than lingering alongside the fresh initial sync.
        cleanupTableCallbacks();
        tableCleanupRef.current = registerTableCallbacksRef.current(connection) ?? null;

        connection.subscriptionBuilder()
          .onApplied(() => {
            // A late `onApplied` from a connection we have already replaced must not
            // report itself as the current session's initial sync.
            if (connRef.current !== connection) return;
            onSubscriptionAppliedRef.current(connection, id, { reconnected });
          })
          .subscribe(GAME_SUBSCRIPTIONS);
      },

      onDisconnected: () => {
        cleanupTableCallbacks();
        connRef.current = null;
        setIdentity(null);
        onDisconnectedRef.current?.();
      },

      onStateChange: ({ status: nextStatus, attempt }: ConnectionManagerState) => {
        setStatus(nextStatus);
        setReconnectAttempt(attempt);
      },

      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      random: Math.random,
    });

    managerRef.current = manager;
    manager.start();

    return () => {
      managerRef.current = null;
      // User-initiated: unmount must not kick off a reconnect loop against a
      // page that is going away.
      manager.stop();
      cleanupTableCallbacks();
      connRef.current = null;
    };
  }, []);

  const forgetSavedConnection = useCallback(() => {
    clearSavedAuthToken();
    setHasSavedCharacter(false);
    // Deliberately NOT `manager.stop()`: dropping the socket once the token is
    // already gone lets the ordinary reconnect loop bring us straight back as a
    // fresh anonymous identity, which is what "forget my character" means. A
    // stop would leave the page connectionless until a reload.
    managerRef.current?.getConnection()?.disconnect();
  }, []);

  return {
    connected: status === 'connected',
    connRef,
    databaseName: STDB_DB_NAME,
    forgetSavedConnection,
    hasSavedCharacter,
    identity,
    status,
    reconnectAttempt,
    connectionEpoch,
  };
}
