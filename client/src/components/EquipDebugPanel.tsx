import { useCallback, useMemo, type CSSProperties } from 'react';
import { useNetwork } from '../network/useNetwork';
import { useGameState } from '../state/useGameState';
import { useHudState } from '../state/useHudState';

/**
 * Minimal mid-session equip controls for issue #49.
 * Not a real inventory UI (#52) — temporary debug surface to prove the loop.
 */
export function EquipDebugPanel() {
  const { connRef, identity } = useNetwork();
  const { isJoined } = useHudState();
  const { playerEquipment } = useGameState();

  const equippedSummary = useMemo(() => {
    if (!identity) return '(no identity)';
    const rows = playerEquipment.get(identity.toHexString()) ?? [];
    if (rows.length === 0) return '(empty)';
    return rows
      .map(row => `${row.slot}:${row.itemId}`)
      .sort()
      .join(', ');
  }, [identity, playerEquipment]);

  const callEquip = useCallback((itemId: string) => {
    const conn = connRef.current;
    if (!conn) return;
    try {
      conn.reducers.equipItem({ itemId });
    } catch (error) {
      console.warn('[equip] equip_item failed', itemId, error);
    }
  }, [connRef]);

  const callUnequip = useCallback((slot: string) => {
    const conn = connRef.current;
    if (!conn) return;
    try {
      conn.reducers.unequipSlot({ slot });
    } catch (error) {
      console.warn('[equip] unequip_slot failed', slot, error);
    }
  }, [connRef]);

  if (!isJoined) return null;

  return (
    <div style={panelStyle}>
      <div style={titleStyle}>Equip (debug)</div>
      <div style={summaryStyle}>{equippedSummary}</div>
      <div style={rowStyle}>
        <button type="button" style={btnStyle} onClick={() => callEquip('sword_1h')}>
          Equip sword
        </button>
        <button type="button" style={btnStyle} onClick={() => callEquip('wand')}>
          Equip wand
        </button>
        <button type="button" style={btnStyle} onClick={() => callEquip('dagger')}>
          Equip dagger
        </button>
        <button type="button" style={btnStyle} onClick={() => callEquip('shield')}>
          Equip shield
        </button>
        <button type="button" style={btnStyle} onClick={() => callEquip('potion')}>
          Equip potion
        </button>
      </div>
      <div style={rowStyle}>
        <button type="button" style={btnStyle} onClick={() => callUnequip('main_hand')}>
          Unequip main hand
        </button>
        <button type="button" style={btnStyle} onClick={() => callUnequip('off_hand')}>
          Unequip off hand
        </button>
        <button type="button" style={btnStyle} onClick={() => callUnequip('utility_potion')}>
          Unequip potion
        </button>
      </div>
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
  marginBottom: '4px',
};

const summaryStyle: CSSProperties = {
  opacity: 0.9,
  marginBottom: '8px',
  wordBreak: 'break-word',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  marginBottom: '6px',
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
};
