import { normalizeCharacterClass } from './components/characterConfig';

/** Loadout preset id stored for re-join (wizard, paladin, acolyte, …). */
export type StoredCharacterClass = string;

export type JoinPreferences = {
  username: string;
  characterClass: StoredCharacterClass;
};

type TokenStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const AUTH_TOKEN_KEY = 'mog.authToken';
const JOIN_USERNAME_KEY = 'mog.join.username';
const JOIN_CHARACTER_CLASS_KEY = 'mog.join.characterClass';
const DEFAULT_JOIN_PREFERENCES: JoinPreferences = {
  username: 'Adventurer',
  characterClass: 'wizard',
};

function browserStorage(): TokenStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function normalizeStoredCharacterClass(value: string | null): StoredCharacterClass {
  return normalizeCharacterClass(value);
}

export function loadSavedAuthToken(storage = browserStorage()): string | undefined {
  const token = storage?.getItem(AUTH_TOKEN_KEY)?.trim();
  return token ? token : undefined;
}

export function saveAuthToken(token: string, storage = browserStorage()) {
  if (!token) return;
  storage?.setItem(AUTH_TOKEN_KEY, token);
}

export function clearSavedAuthToken(storage = browserStorage()) {
  storage?.removeItem(AUTH_TOKEN_KEY);
}

export function loadJoinPreferences(storage = browserStorage()): JoinPreferences {
  const username = storage?.getItem(JOIN_USERNAME_KEY)?.trim();
  return {
    username: username || DEFAULT_JOIN_PREFERENCES.username,
    characterClass: normalizeStoredCharacterClass(storage?.getItem(JOIN_CHARACTER_CLASS_KEY) ?? null),
  };
}

export function saveJoinPreferences(preferences: JoinPreferences, storage = browserStorage()) {
  const username = preferences.username.trim() || DEFAULT_JOIN_PREFERENCES.username;
  storage?.setItem(JOIN_USERNAME_KEY, username);
  storage?.setItem(JOIN_CHARACTER_CLASS_KEY, preferences.characterClass);
}

export function clearSavedCharacter(storage = browserStorage()) {
  clearSavedAuthToken(storage);
  storage?.removeItem(JOIN_USERNAME_KEY);
  storage?.removeItem(JOIN_CHARACTER_CLASS_KEY);
}
