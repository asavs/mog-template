/**
 * The HUD: hp bar, hotbar, charge indicator — all read live from rows, never
 * from a hardcoded ability list. A slot's icon is its bound action id as
 * text; cooldown sweep and resource counts come from `ACTION_DEFS` /
 * `RESOURCE_DEFS` looked up BY the id the row names, not authored per-slot.
 * Adding a new ability is a `shared/actions.json` row plus a `keymap.ts`
 * binding — this file needs no change either way.
 *
 * Re-renders on its own 10Hz timer rather than reacting to individual table
 * events: `GameStore`'s maps are mutated in place by `sync.ts`'s listeners
 * (which fire outside React's render cycle), so a lightweight poll is the
 * simplest correct way to notice "something changed" without wiring a
 * second observation channel through every table.
 */

import { useEffect, useState } from 'react';
import { ACTION_DEFS, RESOURCE_DEFS, type ActionDef } from '../actions/defs.generated';
import { Phase } from '../actions/gates';
import type { GameStore } from './sync';

const POLL_INTERVAL_MS = 100;
const ACTION_DEFS_BY_ID: ReadonlyMap<string, ActionDef> = new Map(ACTION_DEFS.map(def => [def.id, def]));

export interface HudProps {
  store: GameStore;
  identityHex: string | null;
}

export function Hud({ store, identityHex }: HudProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick(value => value + 1), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  if (!identityHex) return null;

  const health = store.playerHealth.get(identityHex);
  const actionState = store.playerActionState.get(identityHex);
  const currentTick = actionState?.serverTick ?? 0n;

  const slots = [...store.playerSlotBinding.values()]
    .filter(row => row.identity.toHexString() === identityHex)
    .sort((a, b) => a.slot.localeCompare(b.slot));

  const cooldowns = new Map<string, bigint>(); // actionId -> readyTick
  for (const row of store.playerCooldown.values()) {
    if (row.identity.toHexString() !== identityHex) continue;
    cooldowns.set(row.actionId, row.readyTick);
  }

  const resources = new Map<string, number>(); // kind -> amount
  for (const row of store.playerResource.values()) {
    if (row.identity.toHexString() !== identityHex) continue;
    resources.set(row.kind, row.amount);
  }

  const chargingDef = actionState?.phase === Phase.Charging ? ACTION_DEFS_BY_ID.get(actionState.actionId) : undefined;
  const chargeSpec = chargingDef?.hold?.mode === 'charge' ? chargingDef.hold : undefined;

  return (
    <div className="hud">
      {health && (
        <div className="hud__health" role="meter" aria-valuemin={0} aria-valuemax={health.maxHealth} aria-valuenow={health.currentHealth}>
          <div
            className="hud__health-fill"
            style={{ width: `${health.maxHealth > 0 ? (100 * health.currentHealth) / health.maxHealth : 0}%` }}
          />
          <span className="hud__health-label">
            {health.currentHealth} / {health.maxHealth}
            {health.isDead ? ' — dead' : ''}
          </span>
        </div>
      )}

      {chargeSpec && actionState && (
        <div className="hud__charge" role="meter" aria-valuemin={0} aria-valuemax={100}>
          <div
            className="hud__charge-fill"
            style={{ width: `${chargeFraction(actionState.chargeTicks, chargeSpec.minTicks, chargeSpec.maxTicks) * 100}%` }}
          />
        </div>
      )}

      <div className="hud__hotbar">
        {slots.map(slot => {
          const boundActionId = slot.holdAction ?? slot.tapAction;
          const def = boundActionId ? ACTION_DEFS_BY_ID.get(boundActionId) : undefined;
          const readyTick = boundActionId ? cooldowns.get(boundActionId) : undefined;
          const sweep = def && readyTick !== undefined ? cooldownSweepFraction(readyTick, def.cooldownTicks, currentTick) : 0;
          const resourceAmount = def?.resource ? resources.get(def.resource.kind) : undefined;
          const resourceMax = def?.resource
            ? RESOURCE_DEFS.find(resourceDef => resourceDef.kind === def.resource!.kind)?.max
            : undefined;

          return (
            <div className="hud__slot" key={slot.slot}>
              <span className="hud__slot-name">{slot.slot}</span>
              <span className="hud__slot-action">{boundActionId ?? '—'}</span>
              {sweep > 0 && <div className="hud__slot-cooldown" style={{ height: `${sweep * 100}%` }} />}
              {resourceAmount !== undefined && (
                <span className="hud__slot-resource">
                  {resourceAmount}
                  {resourceMax !== undefined ? `/${resourceMax}` : ''}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function chargeFraction(chargeTicks: bigint, minTicks: number, maxTicks: number): number {
  const span = maxTicks - minTicks;
  if (span <= 0) return 1;
  const ticks = Number(chargeTicks);
  return Math.max(0, Math.min(1, (ticks - minTicks) / span));
}

/** 1 = just started cooling down, 0 = ready. */
function cooldownSweepFraction(readyTick: bigint, cooldownTicks: number, currentTick: bigint): number {
  if (cooldownTicks <= 0 || readyTick <= currentTick) return 0;
  const remaining = Number(readyTick - currentTick);
  return Math.max(0, Math.min(1, remaining / cooldownTicks));
}
