import { useCallback, useMemo, type CSSProperties } from 'react';
import { useNetwork } from '../network/useNetwork';
import { useGameState } from '../state/useGameState';
import { useHudState } from '../state/useHudState';
import {
  formatCatalogIdLabel,
  listEquippableCatalogItems,
} from './characterConfig';

/**
 * Minimal inventory / equipment panel for joined players (#52).
 *
 * Available items come from loadout authority (`ITEM_IDS` / catalog), not a
 * hardcoded staff/sword list — wand and future items appear when Auth regenerates.
 *
 * True inventory bag persistence is future work; this uses the catalog as the
 * set of equippable loadout items.
 */
export function InventoryPanel() {
  const { connRef, identity } = useNetwork();
  const { isJoined } = useHudState();
  const { playerEquipment } = useGameState();

  const equippedRows = useMemo(() => {
    if (!identity) return [];
    const rows = playerEquipment.get(identity.toHexString()) ?? [];
    return [...rows].sort((a, b) => a.slot.localeCompare(b.slot) || a.itemId.localeCompare(b.itemId));
  }, [identity, playerEquipment]);

  const equippedBySlot = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of equippedRows) {
      map.set(row.slot, row.itemId);
    }
    return map;
  }, [equippedRows]);

  const catalogItems = useMemo(() => listEquippableCatalogItems(), []);
  const equipmentItems = useMemo(
    () => catalogItems.filter(item => item.group === 'equipment'),
    [catalogItems],
  );
  const utilityItems = useMemo(
    () => catalogItems.filter(item => item.group === 'utility'),
    [catalogItems],
  );

  const callEquip = useCallback((itemId: string) => {
    const conn = connRef.current;
    if (!conn) return;
    try {
      conn.reducers.equipItem({ itemId });
    } catch (error) {
      console.warn('[inventory] equip_item failed', itemId, error);
    }
  }, [connRef]);

  const callUnequip = useCallback((slot: string) => {
    const conn = connRef.current;
    if (!conn) return;
    try {
      conn.reducers.unequipSlot({ slot });
    } catch (error) {
      console.warn('[inventory] unequip_slot failed', slot, error);
    }
  }, [connRef]);

  if (!isJoined) return null;

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>Inventory / Equipment</div>

      <div style={sectionLabelStyle}>Equipped</div>
      {equippedRows.length === 0 ? (
        <div style={emptyStyle}>(empty)</div>
      ) : (
        <ul style={listStyle}>
          {equippedRows.map(row => (
            <li key={`${row.slot}:${row.itemId}`} style={listItemStyle}>
              <span style={slotLabelStyle}>
                {formatCatalogIdLabel(row.slot)} → {formatCatalogIdLabel(row.itemId)}
              </span>
              <button
                type="button"
                style={btnStyle}
                onClick={() => callUnequip(row.slot)}
              >
                Unequip
              </button>
            </li>
          ))}
        </ul>
      )}

      <div style={sectionLabelStyle}>Equipment</div>
      <div style={rowStyle}>
        {equipmentItems.map(item => {
          const occupiedBy = equippedBySlot.get(item.slot);
          const isEquipped = occupiedBy === item.itemId;
          return (
            <button
              key={item.itemId}
              type="button"
              style={{
                ...btnStyle,
                ...(isEquipped ? btnActiveStyle : {}),
              }}
              onClick={() => {
                if (!isEquipped) callEquip(item.itemId);
              }}
              title={`Equip ${item.label} (${item.slot})`}
            >
              {isEquipped ? `✓ ${item.label}` : `Equip ${item.label}`}
            </button>
          );
        })}
      </div>

      {utilityItems.length > 0 && (
        <>
          <div style={sectionLabelStyle}>Utility</div>
          <div style={rowStyle}>
            {utilityItems.map(item => {
              const occupiedBy = equippedBySlot.get(item.slot);
              const isEquipped = occupiedBy === item.itemId;
              return (
                <button
                  key={item.itemId}
                  type="button"
                  style={{
                    ...btnStyle,
                    ...(isEquipped ? btnActiveStyle : {}),
                  }}
                  onClick={() => {
                    if (!isEquipped) callEquip(item.itemId);
                  }}
                  title={`Equip ${item.label} (${item.slot})`}
                >
                  {isEquipped ? `✓ ${item.label}` : `Equip ${item.label}`}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const panelStyle: CSSProperties = {
  position: 'fixed',
  bottom: '20px',
  left: '20px',
  zIndex: 12,
  pointerEvents: 'auto',
  fontFamily: 'monospace',
  fontSize: '12px',
  color: '#fff',
  textShadow: '1px 1px 2px #000',
  background: 'rgba(0, 0, 0, 0.55)',
  border: '1px solid rgba(255, 255, 255, 0.25)',
  borderRadius: '6px',
  padding: '8px 10px',
  maxWidth: '420px',
};

const titleStyle: CSSProperties = {
  fontWeight: 700,
  marginBottom: '6px',
};

const sectionLabelStyle: CSSProperties = {
  opacity: 0.75,
  fontSize: '10px',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginTop: '6px',
  marginBottom: '4px',
};

const emptyStyle: CSSProperties = {
  opacity: 0.7,
  marginBottom: '4px',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: '0 0 4px',
  padding: 0,
};

const listItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  marginBottom: '4px',
};

const slotLabelStyle: CSSProperties = {
  wordBreak: 'break-word',
  flex: 1,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  marginBottom: '4px',
};

const btnStyle: CSSProperties = {
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: '11px',
  padding: '4px 8px',
  borderRadius: '4px',
  border: '1px solid rgba(255, 255, 255, 0.35)',
  background: 'rgba(40, 40, 50, 0.9)',
  color: '#fff',
  whiteSpace: 'nowrap',
};

const btnActiveStyle: CSSProperties = {
  borderColor: '#4ecca3',
  background: 'rgba(36, 59, 59, 0.95)',
  color: '#8ff5d2',
};
