export const MEMORY_DATABASE_NAME = 'DeepSeekPP';
export const MEMORY_DATABASE_VERSION = 5 as const;
export const MEMORY_TABLE_NAME = 'memories';
export const ANCHOR_TABLE_NAME = 'chain_anchors';
export const INDEX_TABLE_NAME = 'memory_index';

export const MEMORY_TABLE_SCHEMAS = {
  1: '++id, type, name, pinned, createdAt, updatedAt, lastAccessedAt',
  2: '++id, type, name, pinned, createdAt, updatedAt, lastAccessedAt, syncId',
  3: '++id, type, name, pinned, createdAt, updatedAt, lastAccessedAt, syncId, scope, projectId',
} as const;

export const ANCHOR_TABLE_SCHEMA = 'sessionId, mode, updatedAt';
export const INDEX_TABLE_SCHEMA = '++id, term, memoryId';

export type PersistedMemoryRecord = Record<string, unknown>;

export function migrateMemoryV1RecordToV2(
  memory: PersistedMemoryRecord,
  syncId: string,
): PersistedMemoryRecord {
  return { ...memory, syncId };
}

export function migrateMemoryV2RecordToV3(memory: PersistedMemoryRecord): PersistedMemoryRecord {
  const { projectId: _projectId, ...rest } = memory;
  return { ...rest, scope: 'global' };
}
