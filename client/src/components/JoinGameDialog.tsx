/**
 * JoinGameDialog.tsx
 * 
 * Adapted from vibe-coding-starter-pack-3d-multiplayer by Majid Manzarpour (MIT).
 * https://github.com/majidmanzarpour/vibe-coding-starter-pack-3d-multiplayer
 */

import React, { useState } from 'react';
import { buildInfo } from '../buildInfo';

export type CharacterClass = 'wizard' | 'paladin';

interface JoinGameDialogProps {
  onJoin: (username: string, characterClass: CharacterClass) => void;
  initialUsername: string;
  initialCharacterClass: CharacterClass;
  hasSavedCharacter: boolean;
  onClearSavedCharacter: () => void;
}

export const JoinGameDialog: React.FC<JoinGameDialogProps> = ({
  onJoin,
  initialUsername,
  initialCharacterClass,
  hasSavedCharacter,
  onClearSavedCharacter,
}) => {
  const [username, setUsername] = useState(initialUsername);
  const [characterClass, setCharacterClass] = useState<CharacterClass>(initialCharacterClass);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const finalUsername = username.trim() || `Player${Math.floor(Math.random() * 1000)}`;
    onJoin(finalUsername, characterClass);
  };

  return (
    <div style={styles.overlay}>
      <form style={styles.dialog} onSubmit={handleSubmit}>
        <h2 style={{ marginTop: 0 }}>Join MOG</h2>
        <div style={styles.inputGroup}>
          <label htmlFor="username" style={styles.label}>Character Name:</label>
          <input
            type="text"
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={16}
            style={styles.input}
            autoFocus
          />
        </div>
        <div style={styles.inputGroup}>
          <label style={styles.label}>Class:</label>
          <div style={styles.classGrid}>
            <button
              type="button"
              style={{
                ...styles.classButton,
                ...(characterClass === 'wizard' ? styles.classButtonActive : {}),
              }}
              onClick={() => setCharacterClass('wizard')}
            >
              Wizard
            </button>
            <button
              type="button"
              style={{
                ...styles.classButton,
                ...(characterClass === 'paladin' ? styles.classButtonActive : {}),
              }}
              onClick={() => setCharacterClass('paladin')}
            >
              Paladin
            </button>
          </div>
        </div>
        <button type="submit" style={styles.button}>Join Game</button>
        {hasSavedCharacter && (
          <button type="button" style={styles.secondaryButton} onClick={onClearSavedCharacter}>
            New Character
          </button>
        )}
      </form>
      <div className="join-build-commit">commit {buildInfo.commit}</div>
    </div>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
    fontFamily: 'sans-serif',
  },
  dialog: {
    backgroundColor: '#1a1a2e',
    padding: '40px',
    borderRadius: '12px',
    border: '1px solid #333',
    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.5)',
    color: '#fff',
    width: '320px',
    textAlign: 'center',
  },
  inputGroup: {
    marginBottom: '24px',
    textAlign: 'left',
  },
  label: {
    display: 'block',
    marginBottom: '10px',
    color: '#888',
    fontSize: '12px',
    textTransform: 'uppercase',
    letterSpacing: '1px',
  },
  input: {
    width: '100%',
    padding: '12px',
    border: '1px solid #333',
    borderRadius: '6px',
    backgroundColor: '#0f0f1a',
    color: '#fff',
    fontSize: '16px',
    boxSizing: 'border-box',
  },
  classGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '10px',
  },
  classButton: {
    padding: '12px',
    border: '1px solid #333',
    borderRadius: '6px',
    backgroundColor: '#0f0f1a',
    color: '#fff',
    fontSize: '14px',
    cursor: 'pointer',
  },
  classButtonActive: {
    borderColor: '#4ecca3',
    backgroundColor: '#243b3b',
    color: '#8ff5d2',
  },
  button: {
    width: '100%',
    padding: '14px',
    border: 'none',
    borderRadius: '6px',
    backgroundColor: '#4ecca3',
    color: '#1a1a2e',
    fontSize: '16px',
    fontWeight: 'bold',
    cursor: 'pointer',
    transition: 'transform 0.1s ease',
  },
  secondaryButton: {
    width: '100%',
    marginTop: '12px',
    padding: '12px',
    border: '1px solid #555',
    borderRadius: '6px',
    backgroundColor: 'transparent',
    color: '#ddd',
    fontSize: '14px',
    cursor: 'pointer',
  },
};
