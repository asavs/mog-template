import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { DbConnection } from '../generated';
import type { CharacterClass } from '../components/JoinGameDialog';
import { normalizeCharacterClass } from '../components/characterConfig';
import {
  clearSavedCharacter,
  loadJoinPreferences,
  saveJoinPreferences,
} from '../authStorage';

type UseJoinSessionOptions = {
  connRef: MutableRefObject<DbConnection | null>;
  forgetSavedConnection: () => void;
  setIsJoined: Dispatch<SetStateAction<boolean>>;
};

export function useJoinSession({
  connRef,
  forgetSavedConnection,
  setIsJoined,
}: UseJoinSessionOptions) {
  const [joinPreferences, setJoinPreferences] = useState(() => loadJoinPreferences());

  const handleJoin = useCallback((username: string, characterClass: CharacterClass) => {
    const connection = connRef.current;
    if (connection) {
      const presetId = normalizeCharacterClass(characterClass);
      saveJoinPreferences({ username, characterClass: presetId });
      setJoinPreferences({ username, characterClass: presetId });
      connection.reducers.joinGameAs({ username, characterClass: presetId });
      setIsJoined(true);
    }
  }, [connRef, setIsJoined]);

  const handleClearSavedCharacter = useCallback(() => {
    clearSavedCharacter();
    forgetSavedConnection();
    window.location.reload();
  }, [forgetSavedConnection]);

  const handleLeave = useCallback(() => {
    const connection = connRef.current;
    if (connection) {
      connection.reducers.leaveGame({});
      setIsJoined(false);
    }
  }, [connRef, setIsJoined]);

  return {
    handleClearSavedCharacter,
    handleJoin,
    handleLeave,
    joinPreferences,
  };
}
