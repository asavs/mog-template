import type { CSSProperties } from 'react';
import type { Identity } from 'spacetimedb';
import type { PlayerHealth } from '../generated/types';
import type { NetMetrics } from '../netcode';
import { useNetwork } from '../network/useNetwork';
import { useGameState } from '../state/useGameState';
import { useHudState } from '../state/useHudState';
import { JoinGameDialog, type CharacterClass } from './JoinGameDialog';
import { EquipDebugPanel } from './EquipDebugPanel';
import './GameOverlays.css';

type GameOverlaysProps = {
  audioMuted: boolean;
  onClearSavedCharacter: () => void;
  onJoin: (username: string, characterClass: CharacterClass) => void;
  onLeave: () => void;
  onToggleAudio: () => void;
};

export function GameOverlays({
  audioMuted,
  onClearSavedCharacter,
  onJoin,
  onLeave,
  onToggleAudio,
}: GameOverlaysProps) {
  const {
    connected,
    databaseName,
    hasSavedCharacter,
    identity,
  } = useNetwork();
  const {
    hudHealth,
    hudMetrics,
    isJoined,
    joinPreferences,
  } = useHudState();
  const {
    players,
  } = useGameState();

  return (
    <>
      {databaseName !== 'mog-game-v1' && (
        <DatabaseBadge databaseName={databaseName} />
      )}

      {!isJoined && connected && (
        <JoinGameDialog
          onJoin={onJoin}
          initialUsername={joinPreferences.username}
          initialCharacterClass={joinPreferences.characterClass}
          hasSavedCharacter={hasSavedCharacter}
          onClearSavedCharacter={onClearSavedCharacter}
        />
      )}

      <DevHud
        connected={connected}
        identity={identity}
        isJoined={isJoined}
        playerCount={players.size}
        metrics={hudMetrics}
        health={hudHealth}
        audioMuted={audioMuted}
        onToggleAudio={onToggleAudio}
        onLeave={onLeave}
      />

      <EquipDebugPanel />
    </>
  );
}

function DatabaseBadge({ databaseName }: { databaseName: string }) {
  return (
    <div style={databaseBadgeStyle}>
      {databaseName.toUpperCase()}
    </div>
  );
}

function DevHud({
  connected,
  identity,
  isJoined,
  playerCount,
  metrics,
  health,
  audioMuted,
  onToggleAudio,
  onLeave,
}: {
  connected: boolean;
  identity: Identity | null;
  isJoined: boolean;
  playerCount: number;
  metrics: NetMetrics;
  health?: PlayerHealth;
  audioMuted: boolean;
  onToggleAudio: () => void;
  onLeave: () => void;
}) {
  return (
    <div style={hudStyle}>
      <div style={{ pointerEvents: 'none' }}>
        {connected ? `Connected as: ${identity?.toHexString().slice(0, 8)}...` : 'Connecting...'}<br />
        Players online: {playerCount}<br />
        {isJoined ? 'WASD to move, SHIFT to sprint' : 'Enter a name to join'}<br />
        FPS: {metrics.fps.toFixed(0)}<br />
        Input: {metrics.inputSendHz.toFixed(1)} Hz<br />
        Transforms: {metrics.transformReceiveHz.toFixed(1)} Hz<br />
        Snapshot age: {metrics.latestSnapshotAgeMs.toFixed(0)} ms<br />
        Buffer: {metrics.avgBufferLength.toFixed(1)}<br />
        Correction: {metrics.localCorrectionError.toFixed(3)} m<br />
        Server/predicted: {metrics.serverPredictedPositionDelta.toFixed(3)} m<br />
        Visual offset: {metrics.visualCorrectionOffset.toFixed(3)} m<br />
        Predicted/local: {metrics.predictedTickCount}/{metrics.localClientTick}<br />
        Ack/sent: {metrics.acknowledgedClientTick}/{metrics.lastSentClientTick}<br />
        Server tick: {metrics.latestServerTick}<br />
        Health: {health ? `${health.currentHealth}/${health.maxHealth}${health.isDead ? ' DEAD' : ''}` : '--'}
      </div>
      {isJoined && (
        <div className="hud-button-row">
          <button
            onClick={onToggleAudio}
            className="hud-mute-button"
          >
            {audioMuted ? 'Unmute Audio' : 'Mute Audio'}
          </button>
          <button
            onClick={onLeave}
            style={buttonStyle}
          >
            Leave Game
          </button>
        </div>
      )}
    </div>
  );
}

const databaseBadgeStyle: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  padding: '4px 12px',
  background: '#ff6b00',
  color: '#fff',
  fontFamily: 'monospace',
  fontSize: '12px',
  textAlign: 'center',
  zIndex: 9999,
  pointerEvents: 'none',
};

const hudStyle: CSSProperties = {
  position: 'fixed',
  top: '20px',
  left: '20px',
  color: 'white',
  fontFamily: 'monospace',
  pointerEvents: 'auto',
  textShadow: '1px 1px 2px black',
  zIndex: 10,
};

const buttonStyle: CSSProperties = {
  padding: '5px 10px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  backgroundColor: '#ff4444',
  color: 'white',
  border: 'none',
  borderRadius: '4px',
};
