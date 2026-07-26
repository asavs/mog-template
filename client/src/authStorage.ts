type TokenStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const AUTH_TOKEN_KEY = 'mog.authToken';

function browserStorage(): TokenStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
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
