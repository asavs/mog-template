import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStdbUrl, selectStdbDatabaseName, selectStdbUrl } from './environment';

describe('SpacetimeDB environment selection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubLocation(search: string) {
    vi.stubGlobal('window', {
      location: {
        protocol: 'http:',
        host: 'localhost:5173',
        pathname: '/',
        search,
      },
    });
  }

  it('uses a gated QA stdb URL override', () => {
    stubLocation('?qa&stdb=ws%3A%2F%2F127.0.0.1%3A34001');

    expect(getStdbUrl()).toBe('ws://127.0.0.1:34001');
  });

  it('ignores the stdb URL override when the QA gate is off', () => {
    stubLocation('?stdb=ws%3A%2F%2F127.0.0.1%3A34001');

    expect(getStdbUrl()).toBe('ws://localhost:5173');
  });
  it('uses prod for the root app', () => {
    expect(selectStdbDatabaseName('/', '/')).toBe('mog-game-v1');
  });

  it('uses beta when the app is served from the beta path', () => {
    expect(selectStdbDatabaseName('/', '/beta')).toBe('mog-game-beta');
    expect(selectStdbDatabaseName('/', '/beta/')).toBe('mog-game-beta');
    expect(selectStdbDatabaseName('/', '/beta/play')).toBe('mog-game-beta');
  });

  it('uses beta when the Vite base URL is beta', () => {
    expect(selectStdbDatabaseName('/beta/', '/')).toBe('mog-game-beta');
  });

  it('does not treat beta-like sibling paths as beta', () => {
    expect(selectStdbDatabaseName('/', '/beta-preview/')).toBe('mog-game-v1');
  });

  it('uses ws for local HTTP pages', () => {
    expect(selectStdbUrl('http:', 'localhost:5173')).toBe('ws://localhost:5173');
  });

  it('uses wss for HTTPS pages', () => {
    expect(selectStdbUrl('https:', 'example.test')).toBe('wss://example.test');
  });
});
