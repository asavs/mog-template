import { shouldEnableQaGameDebug } from './qaGate';

// VITE_STDB_DB_NAME lets the build pin the client to a specific database
// (e.g. the preview-VM factory's PREVIEW_DB_NAME knob) without touching
// source. Unset in prod/dev builds, so the default is unchanged.
const PROD_DB_NAME = import.meta.env.VITE_STDB_DB_NAME || 'mog-game-v1';
const BETA_DB_NAME = 'mog-game-beta';

export function selectStdbDatabaseName(baseUrl: string, pathname: string) {
  const normalizedBaseUrl = normalizePathPrefix(baseUrl);
  const normalizedPathname = normalizePathPrefix(pathname);

  if (normalizedBaseUrl === '/beta/' || normalizedPathname.startsWith('/beta/')) {
    return BETA_DB_NAME;
  }

  return PROD_DB_NAME;
}

export function getStdbDatabaseName() {
  return selectStdbDatabaseName(import.meta.env.BASE_URL, window.location.pathname);
}

export function selectStdbUrl(pageProtocol: string, host: string) {
  const websocketProtocol = pageProtocol === 'https:' ? 'wss:' : 'ws:';
  return `${websocketProtocol}//${host}`;
}

export function getStdbUrl() {
  const override = new URLSearchParams(window.location.search).get('stdb');
  if (override && shouldEnableQaGameDebug()) {
    return override;
  }

  return selectStdbUrl(window.location.protocol, window.location.host);
}

function normalizePathPrefix(path: string) {
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }

  if (!path.endsWith('/')) {
    path = `${path}/`;
  }

  return path;
}
