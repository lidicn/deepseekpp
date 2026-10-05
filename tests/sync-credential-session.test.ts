import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SYNC_CONFIG_STORAGE_KEY,
  SyncConfigConflictError,
  SyncConfigReauthorizationRequiredError,
  createBrowserSyncConfigStoragePort,
  createSyncCommandTarget,
  createSyncConfigStore,
  decodeStoredSyncConfig,
} from '../core/sync/config';
import { SYNC_CREDENTIAL_STORAGE_KEY } from '../core/sync/credentials';
import type { WebdavSyncConfig } from '../core/types';
import type { VersionedSyncConfig } from '../core/sync/config';

// DPP-03 ruling A: password/clientSecret/refreshToken must never be written to
// chrome.storage.local. They live in the session bucket, which the browser clears
// on restart, so a lost or forensically imaged machine yields no plaintext
// credential. Everything else about the record keeps its current shape.

type StoredWebdavConfig = Extract<VersionedSyncConfig, { provider: 'webdav' }>;
type StoredGdriveConfig = Extract<VersionedSyncConfig, { provider: 'gdrive' }>;

const WEBDAV_CONFIG = {
  provider: 'webdav',
  url: 'https://nas.example/dav',
  username: 'architect',
  password: 'plaintext-secret',
  remotePath: '/deepseek-pp',
  lastSyncAt: null,
  schemaVersion: 1,
  revision: 1,
} as unknown as StoredWebdavConfig;

const GDRIVE_CONFIG = {
  provider: 'gdrive',
  clientId: 'oauth-client-id',
  clientSecret: 'oauth-client-secret',
  refreshToken: 'oauth-refresh-token',
  lastSyncAt: null,
  schemaVersion: 1,
  revision: 1,
} as unknown as StoredGdriveConfig;

const SECRET_FIELDS = ['password', 'clientSecret', 'refreshToken'];

// A configuration as the page sends it: without the schema metadata the store adds.
const WEBDAV_FIELDS = {
  provider: 'webdav',
  url: 'https://nas.example/dav',
  username: 'architect',
  password: 'plaintext-secret',
  remotePath: '/deepseek-pp',
  lastSyncAt: null,
} as unknown as WebdavSyncConfig;

function installMemoryStorage() {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const pick = (store: Map<string, unknown>, keys: unknown) => {
    if (keys === undefined || keys === null) return Object.fromEntries(store);
    const names = typeof keys === 'string'
      ? [keys]
      : Array.isArray(keys)
        ? keys
        : Object.keys(keys as Record<string, unknown>);
    return Object.fromEntries(
      names.filter((name) => store.has(name)).map((name) => [name, store.get(name)]),
    );
  };
  const write = (store: Map<string, unknown>, value: Record<string, unknown>) => {
    for (const [key, entry] of Object.entries(value)) store.set(key, entry);
  };

  const localGet = vi.fn(async (keys: unknown) => pick(local, keys));
  const localSet = vi.fn(async (value: Record<string, unknown>) => write(local, value));
  const sessionGet = vi.fn(async (keys: unknown) => pick(session, keys));
  const sessionSet = vi.fn(async (value: Record<string, unknown>) => write(session, value));

  vi.stubGlobal('chrome', {
    storage: {
      local: { get: localGet, set: localSet },
      session: { get: sessionGet, set: sessionSet },
    },
  });

  return { local, session, localGet, localSet, sessionGet, sessionSet };
}

function storedLocalRecord(local: Map<string, unknown>): Record<string, unknown> {
  return local.get(SYNC_CONFIG_STORAGE_KEY) as Record<string, unknown>;
}

function storedCredentials(session: Map<string, unknown>): Record<string, unknown> {
  return session.get(SYNC_CREDENTIAL_STORAGE_KEY) as Record<string, unknown>;
}

function decodedWebdavPassword(value: unknown): string {
  return (decodeStoredSyncConfig(value).config as StoredWebdavConfig).password;
}

describe('sync configuration storage split (DPP-03)', () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps every secret field out of the local record when writing a WebDAV config', async () => {
    const { local, session } = installMemoryStorage();
    const port = createBrowserSyncConfigStoragePort();

    await port.write(WEBDAV_CONFIG);

    const stored = storedLocalRecord(local);
    for (const field of SECRET_FIELDS) expect(stored).not.toHaveProperty(field);
    expect(stored).toMatchObject({ provider: 'webdav', url: WEBDAV_CONFIG.url, username: WEBDAV_CONFIG.username });
    expect(storedCredentials(session)).toMatchObject({ password: WEBDAV_CONFIG.password });
  });

  it('keeps the OAuth secrets out of the local record and leaves clientId in place', async () => {
    const { local, session } = installMemoryStorage();
    const port = createBrowserSyncConfigStoragePort();

    await port.write(GDRIVE_CONFIG);

    const stored = storedLocalRecord(local);
    expect(stored).not.toHaveProperty('clientSecret');
    expect(stored).not.toHaveProperty('refreshToken');
    expect(stored).toMatchObject({ provider: 'gdrive', clientId: GDRIVE_CONFIG.clientId });
    expect(storedCredentials(session)).toMatchObject({
      clientSecret: GDRIVE_CONFIG.clientSecret,
      refreshToken: GDRIVE_CONFIG.refreshToken,
    });
  });

  it('hands the decoder the merged record so a stored configuration still round-trips', async () => {
    const { local } = installMemoryStorage();
    const port = createBrowserSyncConfigStoragePort();
    await port.write(WEBDAV_CONFIG);

    const stored = await port.read();

    expect(stored.present).toBe(true);
    expect(decodedWebdavPassword(stored.value)).toBe(WEBDAV_CONFIG.password);
    expect(storedLocalRecord(local)).not.toHaveProperty('password');
  });

  it('reports an absent record as absent', async () => {
    installMemoryStorage();
    const port = createBrowserSyncConfigStoragePort();

    expect(await port.read()).toEqual({ present: false });
  });

  it('moves a released plaintext record into the session bucket on first read', async () => {
    const { local, session } = installMemoryStorage();
    local.set(SYNC_CONFIG_STORAGE_KEY, { ...WEBDAV_CONFIG });

    const stored = await createBrowserSyncConfigStoragePort().read();

    expect(decodedWebdavPassword(stored.value)).toBe(WEBDAV_CONFIG.password);
    expect(storedLocalRecord(local)).not.toHaveProperty('password');
    expect(storedCredentials(session)).toMatchObject({ password: WEBDAV_CONFIG.password });
  });

  it('drops the plaintext and requires re-authorization when the migration write fails', async () => {
    const { local, sessionSet } = installMemoryStorage();
    local.set(SYNC_CONFIG_STORAGE_KEY, { ...WEBDAV_CONFIG });
    sessionSet.mockRejectedValueOnce(new Error('session unavailable'));

    const read = createBrowserSyncConfigStoragePort().read();

    await expect(read).rejects.toBeInstanceOf(SyncConfigReauthorizationRequiredError);
    expect(storedLocalRecord(local)).not.toHaveProperty('password');
    expect(sessionSet).toHaveBeenCalledTimes(1);
  });

  it('requires re-authorization after the browser cleared the session bucket', async () => {
    const { local, session } = installMemoryStorage();
    const port = createBrowserSyncConfigStoragePort();
    await port.write(WEBDAV_CONFIG);
    session.delete(SYNC_CREDENTIAL_STORAGE_KEY);

    await expect(port.read()).rejects.toBeInstanceOf(SyncConfigReauthorizationRequiredError);
    expect(storedLocalRecord(local)).not.toHaveProperty('password');
  });

  it('names the missing credential so the page can ask for exactly that field', async () => {
    const { local } = installMemoryStorage();
    local.set(SYNC_CONFIG_STORAGE_KEY, {
      provider: 'webdav',
      url: 'https://nas.example/dav',
      username: 'architect',
      remotePath: '/deepseek-pp',
      schemaVersion: 1,
      revision: 4,
    });

    const error = await createBrowserSyncConfigStoragePort().read().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SyncConfigReauthorizationRequiredError);
    expect((error as SyncConfigReauthorizationRequiredError).missingFields).toEqual(['password']);
    expect((error as SyncConfigReauthorizationRequiredError).code).toBe('sync_reauthorization_required');
    expect((error as SyncConfigReauthorizationRequiredError).storedRevision).toBe(4);
  });

  it('routes the session bucket through core/sync/credentials so one module owns the secret shape', async () => {
    const configSource = await readFileSource('core/sync/config.ts');
    const credentialsSource = await readFileSource('core/sync/credentials.ts');

    expect(credentialsSource).toContain('chrome.storage.session');
    expect(credentialsSource).toContain(SYNC_CREDENTIAL_STORAGE_KEY);
    expect(configSource).toContain("from './credentials'");
    expect(configSource).not.toContain('chrome.storage.session');
  });
});

describe('sync re-authorization after the browser cleared the session (DPP-03)', () => {
  beforeEach(() => {
    installMemoryStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lets a page that lost its credential re-authorize the record and keeps the revision counting forward', async () => {
    const { session } = installMemoryStorage();
    const store = createSyncConfigStore(createBrowserSyncConfigStoragePort());
    const saved = await store.replace(createSyncCommandTarget(WEBDAV_FIELDS, null));
    session.delete(SYNC_CREDENTIAL_STORAGE_KEY);

    await expect(store.read()).rejects.toBeInstanceOf(SyncConfigReauthorizationRequiredError);

    const renewed = await store.replace(
      createSyncCommandTarget({ ...WEBDAV_FIELDS, password: 're-entered-secret' }, null),
    );

    expect(saved.revision).toBe(1);
    expect(renewed.revision).toBe(2);
    expect(storedCredentials(session)).toMatchObject({ password: 're-entered-secret' });
    expect((await store.read())?.config).toMatchObject({ password: 're-entered-secret' });
  });

  it('still refuses a page that holds a different revision of the credential-less record', async () => {
    const { session } = installMemoryStorage();
    const store = createSyncConfigStore(createBrowserSyncConfigStoragePort());
    await store.replace(createSyncCommandTarget(WEBDAV_FIELDS, null));
    session.delete(SYNC_CREDENTIAL_STORAGE_KEY);

    await expect(store.replace(
      createSyncCommandTarget({ ...WEBDAV_FIELDS, password: 'guessed' }, 99),
    )).rejects.toBeInstanceOf(SyncConfigConflictError);
  });

  it('does not let a page overwrite a configuration that still holds its credential', async () => {
    installMemoryStorage();
    const store = createSyncConfigStore(createBrowserSyncConfigStoragePort());
    await store.replace(createSyncCommandTarget(WEBDAV_FIELDS, null));

    await expect(store.replace(
      createSyncCommandTarget({ ...WEBDAV_FIELDS, password: 'stomp' }, null),
    )).rejects.toBeInstanceOf(SyncConfigConflictError);
  });

  it('gates a recorded sync on the credential instead of advancing a keyless record', async () => {
    const { local, session } = installMemoryStorage();
    const store = createSyncConfigStore(createBrowserSyncConfigStoragePort());
    await store.replace(createSyncCommandTarget(WEBDAV_FIELDS, null));
    session.delete(SYNC_CREDENTIAL_STORAGE_KEY);

    await expect(store.updateLastSyncAt(1, 1_700_000_000_000))
      .rejects.toBeInstanceOf(SyncConfigReauthorizationRequiredError);

    expect(storedLocalRecord(local)).toMatchObject({ revision: 1 });
    expect(storedLocalRecord(local)).not.toHaveProperty('password');
  });
});

async function readFileSource(relativePath: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}
