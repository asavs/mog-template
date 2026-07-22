import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Identity } from 'spacetimedb';
import * as THREE from 'three';
import type { DbConnection, EventContext } from '../generated';
import type {
  CombatEvent,
  FireballProjectile,
  InputState,
  PlayerActionState,
  PlayerAnimation,
  PlayerCharacter,
  PlayerData,
  PlayerHealth,
  PlayerInputAck,
  PlayerTransform,
  SpellEvent,
} from '../generated/types';
import { COMBAT_FEEDBACK_MS, type ActiveCombatFeedback } from '../components/CombatFeedbackEffect';
import {
  pushSnapshot,
  toSnapshot,
  type NetMetrics,
  type RenderTickClock,
  type TransformSnapshot,
} from '../netcode';
import {
  removePlayerActionState,
  removePlayerAnimation,
  removePlayerHealth,
  upsertPlayerActionState,
  upsertPlayerAnimation,
  upsertPlayerHealth,
  type PlayerRuntimeState,
} from '../playerRuntime';
import { playWorldSound } from '../audio/AudioManager';
import type { SoundId } from '../audio/soundRegistry';
import { logFireballDebug, vectorDebug as fireballVectorDebug } from '../fireballDebug';

export const LIGHTNING_EFFECT_MS = 900;
const LIGHTNING_SOUND_DELAY_MS = 260;
const FIREBALL_CAST_SOUND_IDS: readonly SoundId[] = [
  'fireball_cast_1',
  'fireball_cast_2',
  'fireball_cast_3',
] as const;

export type ActiveSpellEffect = {
  key: string;
  spell: SpellEvent;
  startedAt: number;
};

type UseGameTableSyncOptions = {
  combatSubscriptionReadyRef: MutableRefObject<boolean>;
  identityRef: MutableRefObject<Identity | null>;
  inputRef: MutableRefObject<InputState>;
  latestTransformsRef: MutableRefObject<Map<string, PlayerTransform>>;
  latestInputAcksRef: MutableRefObject<Map<string, PlayerInputAck>>;
  metricsRef: MutableRefObject<NetMetrics>;
  playerRuntimeRef: MutableRefObject<PlayerRuntimeState>;
  resetInputForDeath: () => InputState;
  setCombatFeedback: Dispatch<SetStateAction<ActiveCombatFeedback[]>>;
  fireballProjectilesRef: MutableRefObject<Map<string, FireballProjectile>>;
  setFireballProjectileIds: Dispatch<SetStateAction<string[]>>;
  setHudHealth: Dispatch<SetStateAction<PlayerHealth | undefined>>;
  setIsJoined: Dispatch<SetStateAction<boolean>>;
  setPlayerClasses: Dispatch<SetStateAction<ReadonlyMap<string, string>>>;
  setPlayers: Dispatch<SetStateAction<ReadonlyMap<string, PlayerData>>>;
  setSpellEffects: Dispatch<SetStateAction<ActiveSpellEffect[]>>;
  snapshotBuffersRef: MutableRefObject<Map<string, TransformSnapshot[]>>;
  renderTickClockRef: MutableRefObject<RenderTickClock>;
  spellSubscriptionReadyRef: MutableRefObject<boolean>;
};

type TableSubscription<Row> = {
  onInsert: (callback: (ctx: EventContext, row: Row) => void) => void;
  removeOnInsert: (callback: (ctx: EventContext, row: Row) => void) => void;
  onUpdate: (callback: (ctx: EventContext, oldRow: Row, newRow: Row) => void) => void;
  removeOnUpdate: (callback: (ctx: EventContext, oldRow: Row, newRow: Row) => void) => void;
  onDelete: (callback: (ctx: EventContext, row: Row) => void) => void;
  removeOnDelete: (callback: (ctx: EventContext, row: Row) => void) => void;
  iter: () => Iterable<Row>;
};

type TableHandlers<Row> = {
  // Per-row initial-sync handler. Use for tables whose initial state is written
  // to refs/incremental collections one row at a time.
  onInitial?: (row: Row) => void;
  // Bulk initial-sync handler, given every row at once. Preferred for tables
  // backed by React state so the whole collection lands in a single setState
  // instead of O(N) incremental updates (which also copy the map each time).
  // When present it takes precedence over onInitial/onInsert/onUpsert on sync.
  onInitialAll?: (rows: Row[]) => void;
  onUpsert?: (row: Row) => void;
  onInsert?: (row: Row) => void;
  onUpdate?: (row: Row) => void;
  onDelete?: (row: Row) => void;
};

type TableSync<Row> = {
  table: TableSubscription<Row>;
  handlers: TableHandlers<Row>;
};

function subscribeTable<Row>(
  table: TableSubscription<Row>,
  handlers: TableHandlers<Row>,
  unsubs: Array<() => void>,
) {
  // `onInsert`/`onUpdate` override `onUpsert` for their respective live path,
  // so callers can react differently to inserts vs updates (e.g. play a sound
  // only when a row first appears, not on every subsequent field update).
  const handleInsert = handlers.onInsert ?? handlers.onUpsert;
  const handleUpdate = handlers.onUpdate ?? handlers.onUpsert;

  if (handleInsert) {
    const onInsert = (_ctx: EventContext, row: Row) => {
      handleInsert(row);
    };
    table.onInsert(onInsert);
    unsubs.push(() => table.removeOnInsert(onInsert));
  }

  if (handleUpdate) {
    const onUpdate = (_ctx: EventContext, _old: Row, updated: Row) => {
      handleUpdate(updated);
    };
    table.onUpdate(onUpdate);
    unsubs.push(() => table.removeOnUpdate(onUpdate));
  }

  if (handlers.onDelete) {
    const onDelete = (_ctx: EventContext, row: Row) => {
      handlers.onDelete?.(row);
    };
    table.onDelete(onDelete);
    unsubs.push(() => table.removeOnDelete(onDelete));
  }
}

export function useGameTableSync({
  combatSubscriptionReadyRef,
  identityRef,
  inputRef,
  latestTransformsRef,
  latestInputAcksRef,
  metricsRef,
  playerRuntimeRef,
  resetInputForDeath,
  setCombatFeedback,
  fireballProjectilesRef,
  setFireballProjectileIds,
  setHudHealth,
  setIsJoined,
  setPlayerClasses,
  setPlayers,
  setSpellEffects,
  snapshotBuffersRef,
  renderTickClockRef,
  spellSubscriptionReadyRef,
}: UseGameTableSyncOptions) {
  const timeoutIdsRef = useRef<number[]>([]);
  const registeredConnectionsRef = useRef(new WeakSet<DbConnection>());
  const nextFireballCastSoundIndexRef = useRef(0);

  useEffect(() => {
    return () => {
      for (const timeoutId of timeoutIdsRef.current) {
        window.clearTimeout(timeoutId);
      }
      timeoutIdsRef.current = [];
    };
  }, []);

  const scheduleEffectRemoval = useCallback((removeEffect: () => void, delayMs: number) => {
    const timeoutId = window.setTimeout(() => {
      timeoutIdsRef.current = timeoutIdsRef.current.filter(id => id !== timeoutId);
      removeEffect();
    }, delayMs);
    timeoutIdsRef.current.push(timeoutId);
  }, []);

  const handleTransform = useCallback((transform: PlayerTransform) => {
    const key = transform.identity.toHexString();
    latestTransformsRef.current.set(key, transform);
    // Pose-only channel: remotes rebuild snapshots here, never on pure-ack rows.
    pushSnapshot(snapshotBuffersRef.current, key, toSnapshot(transform), renderTickClockRef.current);
    metricsRef.current.transformReceiveCount += 1;
  }, [latestTransformsRef, metricsRef, renderTickClockRef, snapshotBuffersRef]);

  const handleInputAck = useCallback((ack: PlayerInputAck) => {
    latestInputAcksRef.current.set(ack.identity.toHexString(), ack);
  }, [latestInputAcksRef]);

  const handlePlayerHealth = useCallback((health: PlayerHealth) => {
    upsertPlayerHealth(playerRuntimeRef.current, health);

    if (!identityRef.current?.isEqual(health.identity)) return;
    setHudHealth(health);
    if (!health.isDead) return;
    inputRef.current = resetInputForDeath();
  }, [identityRef, inputRef, playerRuntimeRef, resetInputForDeath, setHudHealth]);

  const createTableSyncs = useCallback((connection: DbConnection): TableSync<unknown>[] => [
    {
      table: connection.db.player,
      handlers: {
        onInitialAll: (players: PlayerData[]) => {
          setPlayers(new Map(players.map(player => [player.identity.toHexString(), player])));
        },
        onUpsert: (player: PlayerData) => {
          setPlayers(prev => new Map(prev).set(player.identity.toHexString(), player));
        },
        onDelete: (player: PlayerData) => {
          const key = player.identity.toHexString();
          setPlayers(prev => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
          latestTransformsRef.current.delete(key);
          latestInputAcksRef.current.delete(key);
          snapshotBuffersRef.current.delete(key);
          removePlayerActionState(playerRuntimeRef.current, key);
          removePlayerAnimation(playerRuntimeRef.current, key);
          removePlayerHealth(playerRuntimeRef.current, key);
          if (identityRef.current?.isEqual(player.identity)) {
            setHudHealth(undefined);
          }
        },
      },
    } as TableSync<PlayerData>,
    {
      table: connection.db.player_character,
      handlers: {
        onInitialAll: (playerClasses: PlayerCharacter[]) => {
          setPlayerClasses(new Map(playerClasses.map(playerClass => [
            playerClass.identity.toHexString(),
            playerClass.characterClass,
          ])));
        },
        onUpsert: (playerClass: PlayerCharacter) => {
          setPlayerClasses(prev => new Map(prev).set(
            playerClass.identity.toHexString(),
            playerClass.characterClass,
          ));
        },
        onDelete: (playerClass: PlayerCharacter) => {
          const key = playerClass.identity.toHexString();
          setPlayerClasses(prev => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
        },
      },
    } as TableSync<PlayerCharacter>,
    {
      table: connection.db.player_action_state,
      handlers: {
        onUpsert: (actionState: PlayerActionState) => {
          upsertPlayerActionState(playerRuntimeRef.current, actionState);
        },
        onDelete: (actionState: PlayerActionState) => {
          removePlayerActionState(playerRuntimeRef.current, actionState.identity.toHexString());
        },
      },
    } as TableSync<PlayerActionState>,
    {
      table: connection.db.player_animation,
      handlers: {
        onUpsert: (playerAnimation: PlayerAnimation) => {
          upsertPlayerAnimation(playerRuntimeRef.current, playerAnimation);
        },
        onDelete: (playerAnimation: PlayerAnimation) => {
          removePlayerAnimation(playerRuntimeRef.current, playerAnimation.identity.toHexString());
        },
      },
    } as TableSync<PlayerAnimation>,
    {
      table: connection.db.player_health,
      handlers: {
        onUpsert: handlePlayerHealth,
        onDelete: (health: PlayerHealth) => {
          removePlayerHealth(playerRuntimeRef.current, health.identity.toHexString());
          if (identityRef.current?.isEqual(health.identity)) {
            setHudHealth(undefined);
          }
        },
      },
    } as TableSync<PlayerHealth>,
    {
      table: connection.db.spell_event,
      handlers: {
        onInitial: () => {},
        onUpsert: (spell: SpellEvent) => {
          if (!spellSubscriptionReadyRef.current || spell.spellType !== 'lightning_strike') return;

          const key = spell.id.toString();
          setSpellEffects(prev => [...prev, { key, spell, startedAt: performance.now() }]);
          scheduleEffectRemoval(() => {
            playWorldSound(
              'lightning_strike',
              new THREE.Vector3(spell.position.x, spell.position.y, spell.position.z),
            ).catch(() => {});
          }, LIGHTNING_SOUND_DELAY_MS);
          scheduleEffectRemoval(() => {
            setSpellEffects(prev => prev.filter(effect => effect.key !== key));
          }, LIGHTNING_EFFECT_MS);
        },
      },
    } as TableSync<SpellEvent>,
    {
      table: connection.db.combat_event,
      handlers: {
        onInitial: () => {},
        onUpsert: (event: CombatEvent) => {
          if (!combatSubscriptionReadyRef.current) return;
          if (
            event.eventType !== 'slash_hit' &&
            event.eventType !== 'slash_blocked' &&
            event.eventType !== 'slash_miss'
          ) {
            return;
          }

          const sourceTransform = event.eventType === 'slash_miss'
            ? latestTransformsRef.current.get(event.attacker.toHexString())
            : latestTransformsRef.current.get(event.target.toHexString());
          if (!sourceTransform) return;

          const key = event.id.toString();
          setCombatFeedback(prev => [...prev, {
            key,
            event,
            position: new THREE.Vector3(
              sourceTransform.position.x,
              sourceTransform.position.y,
              sourceTransform.position.z,
            ),
            startedAt: performance.now(),
          }]);
          scheduleEffectRemoval(() => {
            setCombatFeedback(prev => prev.filter(effect => effect.key !== key));
          }, COMBAT_FEEDBACK_MS);
        },
      },
    } as TableSync<CombatEvent>,
    {
      table: connection.db.fireball_projectile,
      handlers: {
        onInitialAll: (projectiles: FireballProjectile[]) => {
          const ids: string[] = [];
          for (const projectile of projectiles) {
            const projectileId = projectile.id.toString();
            fireballProjectilesRef.current.set(projectileId, projectile);
            ids.push(projectileId);
          }
          setFireballProjectileIds(ids);
        },
        // A freshly cast projectile enters the render list and plays the cast
        // sound.
        onInsert: (projectile: FireballProjectile) => {
          const projectileId = projectile.id.toString();
          fireballProjectilesRef.current.set(projectileId, projectile);
          const localCaster = identityRef.current?.toHexString() === projectile.caster.toHexString();
          const aimDebug = localCaster ? window.__fireballAimDebug : undefined;
          logFireballDebug('projectile-insert', {
            aimDirectionAtCast: aimDebug?.aimDirection,
            caster: projectile.caster.toHexString(),
            direction: fireballVectorDebug(projectile.direction),
            distanceTraveled: Number(projectile.distanceTraveled.toFixed(3)),
            localCaster,
            projectileId,
            renderPositionAtCast: aimDebug?.renderPosition,
            serverPosition: fireballVectorDebug(projectile.position),
            spawnedAtTick: projectile.spawnedAtTick.toString(),
            targetPositionAtCast: aimDebug?.targetPosition,
          });
          setFireballProjectileIds(prev => (
            prev.includes(projectileId) ? prev : [...prev, projectileId]
          ));
          if (spellSubscriptionReadyRef.current) {
            const soundIndex = nextFireballCastSoundIndexRef.current % FIREBALL_CAST_SOUND_IDS.length;
            nextFireballCastSoundIndexRef.current =
              (nextFireballCastSoundIndexRef.current + 1) % FIREBALL_CAST_SOUND_IDS.length;
            playWorldSound(
              FIREBALL_CAST_SOUND_IDS[soundIndex],
              new THREE.Vector3(projectile.position.x, projectile.position.y, projectile.position.z),
            ).catch(() => {});
          }
        },
        // Per-tick position updates only refresh the ref; the id is already in
        // the render list, so no React state update is queued.
        onUpdate: (projectile: FireballProjectile) => {
          fireballProjectilesRef.current.set(projectile.id.toString(), projectile);
        },
        onDelete: (projectile: FireballProjectile) => {
          const projectileId = projectile.id.toString();
          fireballProjectilesRef.current.delete(projectileId);
          setFireballProjectileIds(prev => prev.filter(id => id !== projectileId));
        },
      },
    } as TableSync<FireballProjectile>,
    {
      table: connection.db.player_transform,
      handlers: {
        onUpsert: handleTransform,
        onDelete: (transform: PlayerTransform) => {
          const key = transform.identity.toHexString();
          latestTransformsRef.current.delete(key);
          snapshotBuffersRef.current.delete(key);
        },
      },
    } as TableSync<PlayerTransform>,
    {
      table: connection.db.player_input_ack,
      handlers: {
        onUpsert: handleInputAck,
        onDelete: (ack: PlayerInputAck) => {
          latestInputAcksRef.current.delete(ack.identity.toHexString());
        },
      },
    } as TableSync<PlayerInputAck>,
  ] as TableSync<unknown>[], [
    combatSubscriptionReadyRef,
    fireballProjectilesRef,
    handleInputAck,
    handlePlayerHealth,
    handleTransform,
    identityRef,
    latestInputAcksRef,
    latestTransformsRef,
    playerRuntimeRef,
    scheduleEffectRemoval,
    setCombatFeedback,
    setFireballProjectileIds,
    setHudHealth,
    setPlayerClasses,
    setPlayers,
    setSpellEffects,
    snapshotBuffersRef,
    spellSubscriptionReadyRef,
  ]);

  const registerTableCallbacks = useCallback((connection: DbConnection) => {
    spellSubscriptionReadyRef.current = false;
    combatSubscriptionReadyRef.current = false;

    if (registeredConnectionsRef.current.has(connection)) {
      return () => {};
    }
    registeredConnectionsRef.current.add(connection);

    const unsubs: Array<() => void> = [];
    for (const { table, handlers } of createTableSyncs(connection)) {
      subscribeTable(table, handlers, unsubs);
    }

    return () => {
      for (const unsub of unsubs) {
        unsub();
      }
      registeredConnectionsRef.current.delete(connection);
    };
  }, [
    combatSubscriptionReadyRef,
    createTableSyncs,
    spellSubscriptionReadyRef,
  ]);

  const handleSubscriptionApplied = useCallback((connection: DbConnection, id: Identity) => {
    spellSubscriptionReadyRef.current = true;
    const currentPlayers = new Map<string, PlayerData>();
    for (const player of connection.db.player.iter()) {
      currentPlayers.set(player.identity.toHexString(), player);
    }

    const runtime = playerRuntimeRef.current;
    runtime.actionStates.clear();
    runtime.animations.clear();
    runtime.health.clear();
    latestTransformsRef.current.clear();
    latestInputAcksRef.current.clear();
    snapshotBuffersRef.current.clear();
    renderTickClockRef.current.renderTick = 0;
    renderTickClockRef.current.latestKnownServerTick = null;
    fireballProjectilesRef.current.clear();
    setHudHealth(undefined);
    setSpellEffects([]);
    setCombatFeedback([]);

    // Tables backed by React state expose an `onInitialAll` handler so the full
    // collection is applied in a single setState; the rest fold their initial
    // rows into refs/incremental state one at a time.
    for (const { table, handlers } of createTableSyncs(connection)) {
      const rows = Array.from(table.iter());
      if (handlers.onInitialAll) {
        handlers.onInitialAll(rows);
      } else {
        for (const row of rows) {
          (handlers.onInitial ?? handlers.onInsert ?? handlers.onUpsert)?.(row);
        }
      }
    }
    combatSubscriptionReadyRef.current = true;

    if (id && currentPlayers.has(id.toHexString())) {
      setIsJoined(true);
    }
  }, [
    combatSubscriptionReadyRef,
    createTableSyncs,
    fireballProjectilesRef,
    latestInputAcksRef,
    latestTransformsRef,
    playerRuntimeRef,
    setCombatFeedback,
    setHudHealth,
    setIsJoined,
    setSpellEffects,
    snapshotBuffersRef,
    renderTickClockRef,
    spellSubscriptionReadyRef,
  ]);

  return {
    handleSubscriptionApplied,
    registerTableCallbacks,
  };
}
