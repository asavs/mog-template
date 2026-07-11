import React, {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useRef,
} from 'react';
import { Html } from '@react-three/drei';
import type { PlayerHealth } from '../generated/types';

export type PlayerNameplateHandle = {
  updateHealth: (health?: PlayerHealth) => void;
};

type PlayerNameplateProps = {
  initialHealth?: PlayerHealth;
  isLocalPlayer: boolean;
  username: string;
};

export const PlayerNameplate = memo(forwardRef<PlayerNameplateHandle, PlayerNameplateProps>(({
  initialHealth,
  isLocalPlayer,
  username,
}, ref) => {
  const nameplateTextRef = useRef<HTMLDivElement>(null);
  const healthBarOuterRef = useRef<HTMLDivElement>(null);
  const healthBarFillRef = useRef<HTMLDivElement>(null);
  const latestHealthRef = useRef<PlayerHealth | undefined>(initialHealth);

  const updateHealth = useCallback((health?: PlayerHealth) => {
    latestHealthRef.current = health;

    if (nameplateTextRef.current) {
      const isDead = health?.isDead ?? false;
      nameplateTextRef.current.textContent = `${username} ${isLocalPlayer ? '(YOU)' : ''} ${isDead ? 'DEAD' : ''}`;
    }

    if (!healthBarOuterRef.current) return;

    healthBarOuterRef.current.style.display = health ? 'block' : 'none';
    if (!health || !healthBarFillRef.current) return;

    const healthPercent = health.maxHealth > 0
      ? Math.max(0, Math.min(100, (health.currentHealth / health.maxHealth) * 100))
      : 0;
    healthBarFillRef.current.style.width = `${healthPercent}%`;
    healthBarFillRef.current.style.background = health.isDead ? '#777' : '#46d369';
  }, [isLocalPlayer, username]);

  const setNameplateTextRef = useCallback((node: HTMLDivElement | null) => {
    nameplateTextRef.current = node;
    updateHealth(latestHealthRef.current);
  }, [updateHealth]);

  const setHealthBarOuterRef = useCallback((node: HTMLDivElement | null) => {
    healthBarOuterRef.current = node;
    updateHealth(latestHealthRef.current);
  }, [updateHealth]);

  const setHealthBarFillRef = useCallback((node: HTMLDivElement | null) => {
    healthBarFillRef.current = node;
    updateHealth(latestHealthRef.current);
  }, [updateHealth]);

  useImperativeHandle(ref, () => ({
    updateHealth,
  }), [updateHealth]);

  return (
    <Html position={[0, 2.5, 0]} center>
      <div style={tagStyle}>
        <div ref={setNameplateTextRef} />
        <div ref={setHealthBarOuterRef} style={healthBarOuterStyle}>
          <div ref={setHealthBarFillRef} style={healthBarInnerStyle} />
        </div>
      </div>
    </Html>
  );
}));

const tagStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.6)',
  color: 'white',
  padding: '3px 8px',
  borderRadius: '4px',
  fontSize: '12px',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  fontFamily: 'sans-serif',
  textAlign: 'center',
};

const healthBarOuterStyle: React.CSSProperties = {
  width: '72px',
  height: '5px',
  marginTop: '3px',
  background: 'rgba(255,255,255,0.25)',
};

const healthBarInnerStyle: React.CSSProperties = {
  height: '100%',
};
