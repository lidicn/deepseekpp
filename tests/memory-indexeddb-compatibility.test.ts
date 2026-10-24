import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MEMORY_DATABASE_NAME,
  MEMORY_TABLE_NAME,
  MEMORY_TABLE_SCHEMAS,
  ANCHOR_TABLE_NAME,
  INDEX_TABLE_NAME,
  INDEX_TABLE_SCHEMA,
} from '../core/memory/schema';
import {
  MEMORY_V1_ADDITIVE_RECORD,
  MEMORY_IMPORT_PREVIEW_RECORD,
  MEMORY_V2_ADDITIVE_RECORD,
  MEMORY_V2_RECORD,
  MEMORY_V3_PROJECT_ADDITIVE_RECORD,
  MEMORY_V3_PROJECT_RECORD,
  MEMORY_V3_RECORD,
} from './fixtures/persistence-contract/memory';
import {
  addIndexedDbRecords,
  createIndexedDbAtVersion,
  createStore,
  deleteIndexedDb,
  readIndexedDbRecords,
} from './helpers/indexeddb';

const indexedDbFactory = new IDBFactory();

// v1 records have no syncId; the v1→v2 migration assigns a fresh random one.
// That value is intentionally non-deterministic, so compare every field except
// syncId and only assert the assigned value is a well-formed UUID (the locked
// fixed uuid from the old globalThis.crypto.randomUUID mock no longer applies).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function expectRowWithoutRandomSync(
  rows: unknown[],
  expected: Record<string, unknown>,
): void {
  expect(rows).toHaveLength(1);
  const { syncId: _gotSyncId, ...rest } = rows[0] as Record<string, unknown>;
  expect(typeof _gotSyncId === 'string' && UUID_RE.test(_gotSyncId)).toBe(true);
  const { syncId: _expectedSyncId, ...expectedRest } = expected;
  expect(rest).toEqual(expectedRest);
}

beforeAll(() => {
  vi.stubGlobal('indexedDB', indexedDbFactory);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(MEMORY_V2_RECORD.syncId);
});

afterEach(async () => {
  const { db } = await import('../core/memory/store');
  db.close();
  await deleteIndexedDb(MEMORY_DATABASE_NAME);
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Memory historical IndexedDB compatibility', () => {
  it('executes v1→v3 and v2→v3 upgrades while preserving additive fields across reopen', async () => {
    await seedMemoryDatabase(1, MEMORY_V1_ADDITIVE_RECORD);
    const {
      captureRawMemoryRecordsForSyncRecovery,
      db,
      replaceAllMemories,
      restoreRawMemoryRecordsForSyncRecovery,
    } = await import('../core/memory/store');
    const memories = db.table(MEMORY_TABLE_NAME);

    await db.open();
    expectRowWithoutRandomSync(await memories.toArray(), {
      ...MEMORY_V3_RECORD,
      archived: false,
      futureRecordField: MEMORY_V1_ADDITIVE_RECORD.futureRecordField,
    });
    db.close();
    await db.open();
    expectRowWithoutRandomSync(await memories.toArray(), {
      ...MEMORY_V3_RECORD,
      archived: false,
      futureRecordField: MEMORY_V1_ADDITIVE_RECORD.futureRecordField,
    });

    db.close();
    await deleteIndexedDb(MEMORY_DATABASE_NAME);
    await seedMemoryDatabase(2, MEMORY_V2_ADDITIVE_RECORD);

    await db.open();
    expect(await memories.toArray()).toEqual([{
      ...MEMORY_V3_RECORD,
      archived: false,
      futureRecordField: MEMORY_V2_ADDITIVE_RECORD.futureRecordField,
    }]);
    await memories.add({
      ...MEMORY_V3_PROJECT_ADDITIVE_RECORD,
      tags: [...MEMORY_V3_PROJECT_ADDITIVE_RECORD.tags],
    });
    db.close();

    await db.open();
    expect(await memories.orderBy('id').toArray()).toEqual([
      {
        ...MEMORY_V3_RECORD,
        archived: false,
        futureRecordField: MEMORY_V2_ADDITIVE_RECORD.futureRecordField,
      },
      MEMORY_V3_PROJECT_ADDITIVE_RECORD,
    ]);
    expect(db.name).toBe(MEMORY_DATABASE_NAME);
    expect(memories.schema.primKey).toMatchObject({ name: 'id', auto: true });

    await memories.update(MEMORY_V3_RECORD.id, { recoveryFutureField: { preserve: true } } as never);
    const rawBefore = await captureRawMemoryRecordsForSyncRecovery();
    await replaceAllMemories([{ ...MEMORY_V3_RECORD, id: 99, tags: [...MEMORY_V3_RECORD.tags] }]);
    await restoreRawMemoryRecordsForSyncRecovery(rawBefore);
    expect(await memories.orderBy('id').toArray()).toEqual(rawBefore);
    const { id: _id, ...newMemory } = MEMORY_V3_PROJECT_RECORD;
    const nextIdAfterRollback = await memories.add({
      ...newMemory,
      syncId: '00000000-0000-4000-8000-000000000009',
      tags: [...newMemory.tags],
    });
    expect(nextIdAfterRollback).toBe(100);
  });

  it('rejects a future database version without overwriting its raw rows', async () => {
    const futureRecord = {
      ...MEMORY_V3_RECORD,
      futureDatabaseField: { preserve: true },
    };
    // 现在线上库是 v7（backendDB().version === 70）；比它更高的 80 才是「未来版本」。
    await createIndexedDbAtVersion(MEMORY_DATABASE_NAME, 80, (db) => {
      createStore(db, MEMORY_TABLE_NAME, memorySeedSpec(3));
    });
    await addIndexedDbRecords(MEMORY_DATABASE_NAME, MEMORY_TABLE_NAME, [futureRecord]);

    const {
      db,
      getAllMemories,
      importMemoriesAtomically,
    } = await import('../core/memory/store');
    await expect(getAllMemories()).rejects.toBeInstanceOf(Error);
    await expect(importMemoriesAtomically([{
      ...MEMORY_IMPORT_PREVIEW_RECORD,
      tags: [...MEMORY_IMPORT_PREVIEW_RECORD.tags],
    }])).rejects.toBeInstanceOf(Error);
    db.close();

    expect(await readIndexedDbRecords(MEMORY_DATABASE_NAME, MEMORY_TABLE_NAME))
      .toEqual([futureRecord]);
  });

  it('B1: a fresh v7 database has no memory_index table', async () => {
    const { db } = await import('../core/memory/store');
    await db.open();
    const names = db.backendDB().objectStoreNames;
    expect(names.contains(MEMORY_TABLE_NAME)).toBe(true);
    expect(names.contains(ANCHOR_TABLE_NAME)).toBe(true);
    expect(names.contains(INDEX_TABLE_NAME)).toBe(false);
    db.close();
  });

  it('B1: upgrades a v6(=60) db by deleting memory_index while preserving memories/anchors', async () => {
    // 造一个 v6（=60）老库：memories(v4) + chain_anchors + memory_index，各塞一行。
    await createIndexedDbAtVersion(MEMORY_DATABASE_NAME, 60, (db, tx) => {
      const memSpec = memorySeedSpec(4);
      createStore(db, MEMORY_TABLE_NAME, memSpec);
      createStore(db, ANCHOR_TABLE_NAME, { keyPath: 'sessionId', autoIncrement: false });
      // memory_index: '++id, term, memoryId'
      createStore(db, INDEX_TABLE_NAME, {
        keyPath: 'id',
        autoIncrement: true,
        indexes: ['term', 'memoryId'],
      });
      void tx;
    });
    await addIndexedDbRecords(MEMORY_DATABASE_NAME, MEMORY_TABLE_NAME, [{ ...MEMORY_V3_RECORD }]);
    await addIndexedDbRecords(MEMORY_DATABASE_NAME, ANCHOR_TABLE_NAME, [{
      sessionId: 'anchor-1', mode: 'chat', updatedAt: 1,
    }]);
    await addIndexedDbRecords(MEMORY_DATABASE_NAME, INDEX_TABLE_NAME, [{
      term: 'truncate', memoryId: MEMORY_V3_RECORD.id,
    }]);

    const { db, getAllMemories } = await import('../core/memory/store');
    await db.open(); // 触发 60→70 升级
    const names = db.backendDB().objectStoreNames;
    expect(names.contains(INDEX_TABLE_NAME)).toBe(false);
    expect(names.contains(MEMORY_TABLE_NAME)).toBe(true);
    expect(names.contains(ANCHOR_TABLE_NAME)).toBe(true);

    // memories 数据完好
    const mems = await getAllMemories();
    expect(mems.map((m) => m.id)).toContain(MEMORY_V3_RECORD.id);
    db.close();

    // chain_anchors 行仍在（直接读原始库）
    expect(await readIndexedDbRecords(MEMORY_DATABASE_NAME, ANCHOR_TABLE_NAME))
      .toEqual([{ sessionId: 'anchor-1', mode: 'chat', updatedAt: 1 }]);
  });
});

async function seedMemoryDatabase(version: 1 | 2, record: Record<string, unknown>): Promise<void> {
  await createIndexedDbAtVersion(MEMORY_DATABASE_NAME, version * 10, (db) => {
    createStore(db, MEMORY_TABLE_NAME, memorySeedSpec(version));
  });
  await addIndexedDbRecords(MEMORY_DATABASE_NAME, MEMORY_TABLE_NAME, [{ ...record }]);
}

function memorySeedSpec(version: 1 | 2 | 3 | 4): {
  keyPath: string;
  autoIncrement: boolean;
  indexes: readonly string[];
} {
  const schema = MEMORY_TABLE_SCHEMAS[version];
  const [primaryKey, ...indexes] = schema.split(',').map((token) => token.trim());
  if (!primaryKey?.startsWith('++')) {
    throw new Error(`Memory seed schema must declare an auto-increment key: ${schema}`);
  }
  return {
    keyPath: primaryKey.slice(2),
    autoIncrement: true,
    indexes,
  };
}
