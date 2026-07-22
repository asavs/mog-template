import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Identity } from 'spacetimedb';
import { DbConnection } from '../generated';
import {
  clearSavedAuthToken,
  loadSavedAuthToken,
  saveAuthToken,
} from '../authStorage';
import { getStdbDatabaseName, getStdbUrl } from '../environment';

const STDB_URL = getStdbUrl();
const STDB_DB_NAME = getStdbDatabaseName();

const GAME_SUBSCRIPTIONS = [
  'SELECT * FROM fireball_projectile',
  'SELECT * FROM combat_event',
  'SELECT * FROM player',
  'SELECT * FROM player_action_state',
  'SELECT * FROM player_animation',
  'SELECT * FROM player_character',
  'SELECT * FROM player_health',
  'SELECT * FROM player_input_ack',
  'SELECT * FROM player_transform',
  'SELECT * FROM spell_event',
];

type UseSpacetimeConnectionOptions = {
  onConnected?: (connection: DbConnection, identity: Identity) => void;
  onDisconnected?: () => void;
  onSubscriptionApplied: (connection: DbConnection, identity: Identity) => void;
  registerTableCallbacks: (connection: DbConnection) => (() => void) | void;
};

type UseSpacetimeConnectionResult = {
  connected: boolean;
  connRef: MutableRefObject<DbConnection | null>;
  databaseName: string;
  forgetSavedConnection: () => void;
  hasSavedCharacter: boolean;
  identity: Identity | null;
};

export function useSpacetimeConnection({
  onConnected,
  onDisconnected,
  onSubscriptionApplied,
  registerTableCallbacks,
}: UseSpacetimeConnectionOptions): UseSpacetimeConnectionResult {
  const [connected, setConnected] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [hasSavedCharacter, setHasSavedCharacter] = useState(() => !!loadSavedAuthToken());

  const connRef = useRef<DbConnection | null>(null);
  const connectingRef = useRef(false);
  const onConnectedRef = useRef(onConnected);
  const onDisconnectedRef = useRef(onDisconnected);
  const onSubscriptionAppliedRef = useRef(onSubscriptionApplied);
  const registerTableCallbacksRef = useRef(registerTableCallbacks);
  const tableCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onConnectedRef.current = onConnected;
    onDisconnectedRef.current = onDisconnected;
    onSubscriptionAppliedRef.current = onSubscriptionApplied;
    registerTableCallbacksRef.current = registerTableCallbacks;
  });

  useEffect(() => {
    let active = true;

    if (connRef.current || connectingRef.current) return;
    connectingRef.current = true;

    const cleanupTableCallbacks = () => {
      tableCleanupRef.current?.();
      tableCleanupRef.current = null;
    };

    const markDisconnected = (notify = true) => {
      cleanupTableCallbacks();
      connRef.current = null;
      connectingRef.current = false;
      setConnected(false);
      setIdentity(null);
      if (notify) {
        onDisconnectedRef.current?.();
      }
    };

    const connect = (savedToken?: string, retryWithoutSavedToken = true) => {
      const onConnect = (connection: DbConnection, id: Identity, token: string) => {
        if (!active) {
          connection.disconnect();
          return;
        }

        connRef.current = connection;
        connectingRef.current = false;
        saveAuthToken(token);
        setHasSavedCharacter(true);
        setIdentity(id);
        setConnected(true);
        onConnectedRef.current?.(connection, id);

        cleanupTableCallbacks();
        tableCleanupRef.current = registerTableCallbacksRef.current(connection) ?? null;

        connection.subscriptionBuilder()
          .onApplied(() => {
            if (!active) return;
            onSubscriptionAppliedRef.current(connection, id);
          })
          .subscribe(GAME_SUBSCRIPTIONS);
      };

      const builder = DbConnection.builder()
        .withUri(STDB_URL)
        .withDatabaseName(STDB_DB_NAME)
        .onConnect(onConnect)
        .onConnectError((_ctx, err) => {
          if (!active) return;

          if (savedToken && retryWithoutSavedToken) {
            clearSavedAuthToken();
            setHasSavedCharacter(false);
            connect(undefined, false);
            return;
          }

          markDisconnected();
          console.error('SpacetimeDB connection failed:', err);
        })
        .onDisconnect(() => {
          if (!active) return;
          markDisconnected();
        });

      if (savedToken) {
        builder.withToken(savedToken);
      }

      builder.build();
    };

    connect(loadSavedAuthToken());

    return () => {
      active = false;
      if (connRef.current) {
        connRef.current.disconnect();
      }
      markDisconnected(false);
    };
  }, []);

  const forgetSavedConnection = useCallback(() => {
    clearSavedAuthToken();
    setHasSavedCharacter(false);
    tableCleanupRef.current?.();
    tableCleanupRef.current = null;
    if (connRef.current) {
      connRef.current.disconnect();
      connRef.current = null;
    }
    setConnected(false);
    setIdentity(null);
  }, []);

  return {
    connected,
    connRef,
    databaseName: STDB_DB_NAME,
    forgetSavedConnection,
    hasSavedCharacter,
    identity,
  };
}
