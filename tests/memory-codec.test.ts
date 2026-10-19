import { describe, expect, it } from 'vitest';
import {
  decodeImportedMemory,
  decodePersistedMemoryRecord,
  decodeStoredMemory,
  decodeSyncMemory,
} from '../core/memory/codec';

// T20: memory/codec 四条 decoder 的合法往返、scope/projectId 缺省默认、枚举与类型错损坏。

function storedBase(overrides: Record<string, unknown> = {}) {
  return {
    syncId: 'sync-1',
    scope: 'global',
    type: 'user',
    name: 'Note',
    content: 'Remember this.',
    description: 'short',
    tags: ['a', 'b'],
    pinned: false,
    createdAt: 1_000,
    updatedAt: 2_000,
    accessCount: 0,
    lastAccessedAt: 0,
    ...overrides,
  };
}

describe('decodePersistedMemoryRecord', () => {
  it('preserves a positive integer id and global fields, strips projectId', () => {
    const decoded = decodePersistedMemoryRecord({ id: 5, ...storedBase(), projectId: 'p-x' });
    expect(decoded.id).toBe(5);
    expect(decoded.syncId).toBe('sync-1');
    expect(decoded.name).toBe('Note');
    expect('projectId' in decoded).toBe(false);
  });

  it('rejects a missing / zero / negative / non-integer / string id', () => {
    expect(() => decodePersistedMemoryRecord(storedBase())).toThrow();
    expect(() => decodePersistedMemoryRecord({ id: 0, ...storedBase() })).toThrow();
    expect(() => decodePersistedMemoryRecord({ id: -3, ...storedBase() })).toThrow();
    expect(() => decodePersistedMemoryRecord({ id: 2.5, ...storedBase() })).toThrow();
    expect(() => decodePersistedMemoryRecord({ id: '5', ...storedBase() })).toThrow();
  });

  it('rejects non-object input (null / array / string)', () => {
    expect(() => decodePersistedMemoryRecord(null)).toThrow();
    expect(() => decodePersistedMemoryRecord([storedBase()])).toThrow();
    expect(() => decodePersistedMemoryRecord('nope')).toThrow();
  });
});

describe('decodeStoredMemory · scope and enum validation', () => {
  it('keeps projectId for a project-scope record', () => {
    const decoded = decodeStoredMemory(storedBase({ scope: 'project', projectId: 'proj-1' }));
    expect(decoded.scope).toBe('project');
    expect(decoded.projectId).toBe('proj-1');
  });

  it('rejects project scope without projectId', () => {
    expect(() => decodeStoredMemory(storedBase({ scope: 'project' }))).toThrow();
  });

  it('rejects an invalid scope and an invalid type enum', () => {
    expect(() => decodeStoredMemory(storedBase({ scope: 'team' }))).toThrow();
    expect(() => decodeStoredMemory(storedBase({ type: 'factoid' }))).toThrow();
  });

  it('rejects wrong field types: tags array, pinned boolean, createdAt finite number', () => {
    expect(() => decodeStoredMemory(storedBase({ tags: 'a,b' }))).toThrow();
    expect(() => decodeStoredMemory(storedBase({ pinned: 'yes' }))).toThrow();
    expect(() => decodeStoredMemory(storedBase({ createdAt: 'today' }))).toThrow();
  });
});

describe('decodeImportedMemory · missing-field defaults', () => {
  const importedBase = {
    type: 'topic',
    name: 'Idea',
    content: 'draft body',
    description: '',
    tags: [],
    pinned: false,
  };

  it('defaults scope to global and leaves syncId/projectId undefined when omitted', () => {
    const decoded = decodeImportedMemory(importedBase);
    expect(decoded.scope).toBe('global');
    expect(decoded.syncId).toBeUndefined();
    expect(decoded.projectId).toBeUndefined();
  });

  it('keeps an explicit syncId and requires projectId for project scope', () => {
    const ok = decodeImportedMemory({ ...importedBase, syncId: 'synced', scope: 'project', projectId: 'p-9' });
    expect(ok.syncId).toBe('synced');
    expect(ok.projectId).toBe('p-9');
    expect(() => decodeImportedMemory({ ...importedBase, scope: 'project' })).toThrow();
  });

  it('rejects a blank syncId and a blank name', () => {
    expect(() => decodeImportedMemory({ ...importedBase, syncId: '  ' })).toThrow();
    expect(() => decodeImportedMemory({ ...importedBase, name: '' })).toThrow();
  });
});

describe('decodeSyncMemory', () => {
  it('fills a missing scope with global and strips the id field', () => {
    const decoded = decodeSyncMemory({ id: 42, ...storedBase() });
    expect(decoded.scope).toBe('global');
    expect('id' in decoded).toBe(false);
  });
});
