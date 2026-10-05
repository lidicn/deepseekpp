import type { SyncProvider } from '../types';

/**
 * DPP-03 ruling A: the credential half of a sync configuration lives in the
 * session bucket, which the browser clears on exit, so a lost or imaged machine
 * yields no plaintext password. The price is one re-authorization per browser
 * session, which the owner accepted. This module owns the secret shape; the
 * configuration store must not name the session bucket itself.
 */
export const SYNC_CREDENTIAL_STORAGE_KEY = 'deepseek_pp_sync_credentials';

export type SyncCredentialField = 'password' | 'clientSecret' | 'refreshToken';

export type SyncCredentialRecord = Partial<Record<SyncCredentialField, string>>;

export interface SyncCredentialStore {
  read(): Promise<SyncCredentialRecord>;
  write(record: SyncCredentialRecord): Promise<void>;
}

const SYNC_CREDENTIAL_FIELDS: readonly SyncCredentialField[] = [
  'password',
  'clientSecret',
  'refreshToken',
];

/** Fields a provider can use; a leftover from another provider is not merged back. */
const PROVIDER_CREDENTIAL_FIELDS: Record<SyncProvider, readonly SyncCredentialField[]> = {
  webdav: ['password'],
  gdrive: ['clientSecret', 'refreshToken'],
  onedrive: ['clientSecret', 'refreshToken'],
};

/** Fields without which the stored configuration cannot talk to its provider. */
const REQUIRED_PROVIDER_CREDENTIAL_FIELDS: Record<SyncProvider, readonly SyncCredentialField[]> = {
  webdav: ['password'],
  gdrive: ['clientSecret'],
  onedrive: ['clientSecret'],
};

export function createBrowserSyncCredentialStore(): SyncCredentialStore {
  const store: SyncCredentialStore = {
    async read() {
      const data = await chrome.storage.session.get(SYNC_CREDENTIAL_STORAGE_KEY) as Record<string, unknown>;
      return decodeStoredSyncCredentials(data[SYNC_CREDENTIAL_STORAGE_KEY]);
    },
    async write(record: SyncCredentialRecord) {
      await chrome.storage.session.set({ [SYNC_CREDENTIAL_STORAGE_KEY]: record });
    },
  };
  return Object.freeze(store);
}

/**
 * Split a stored record into the half that may sit on disk and the half that
 * may not. Credential keys are removed whatever their type: a malformed value
 * becomes a missing credential rather than a value written to disk.
 */
export function splitSyncConfigCredentials(value: Record<string, unknown>): {
  publicValue: Record<string, unknown>;
  credentials: SyncCredentialRecord;
} {
  const publicValue: Record<string, unknown> = {};
  const credentials: SyncCredentialRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isSyncCredentialField(key)) {
      publicValue[key] = item;
      continue;
    }
    if (typeof item === 'string' && item.length > 0) credentials[key] = item;
  }
  return { publicValue, credentials };
}

export function pickSyncConfigCredentials(
  provider: SyncProvider,
  record: SyncCredentialRecord,
): SyncCredentialRecord {
  const picked: SyncCredentialRecord = {};
  for (const field of PROVIDER_CREDENTIAL_FIELDS[provider]) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) picked[field] = value;
  }
  return picked;
}

export function missingSyncCredentialFields(
  provider: SyncProvider,
  record: SyncCredentialRecord,
): SyncCredentialField[] {
  return REQUIRED_PROVIDER_CREDENTIAL_FIELDS[provider].filter((field) => {
    const value = record[field];
    return typeof value !== 'string' || value.length === 0;
  });
}

function decodeStoredSyncCredentials(value: unknown): SyncCredentialRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record: SyncCredentialRecord = {};
  for (const field of SYNC_CREDENTIAL_FIELDS) {
    const item = (value as Record<string, unknown>)[field];
    if (typeof item === 'string' && item.length > 0) record[field] = item;
  }
  return record;
}

function isSyncCredentialField(key: string): key is SyncCredentialField {
  return (SYNC_CREDENTIAL_FIELDS as readonly string[]).includes(key);
}
