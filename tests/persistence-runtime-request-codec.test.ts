import { describe, expect, it } from 'vitest';
import { decodePersistenceRuntimePayload } from '../core/messaging/persistence-runtime-request-codec';

// T19: 聚焦纯字段 decoder 的合法往返、大载荷、损坏输入（null/非对象/缺字段/类型错）。
// 依赖深层 memory/skill/preset codec 的命令不在此重复，由各自 codec 测试覆盖。

describe('decodePersistenceRuntimePayload · valid round-trip', () => {
  it('passes a positive integer id through GET_MEMORY_BY_ID', () => {
    expect(decodePersistenceRuntimePayload('GET_MEMORY_BY_ID', { id: 7 })).toEqual({ id: 7 });
  });

  it('passes a positive integer id through DELETE_MEMORY', () => {
    expect(decodePersistenceRuntimePayload('DELETE_MEMORY', { id: 3 })).toEqual({ id: 3 });
  });

  it('passes name + enabled through SET_SKILL_ENABLED', () => {
    expect(decodePersistenceRuntimePayload('SET_SKILL_ENABLED', { name: 'demo', enabled: true }))
      .toMatchObject({ name: 'demo', enabled: true });
  });

  it('passes a draft object + confirmed flag through APPLY_MEMORY_ORGANIZE_DRAFT', () => {
    const draft = { keep: [1, 2], archive: [3] };
    expect(decodePersistenceRuntimePayload('APPLY_MEMORY_ORGANIZE_DRAFT', { draft, confirmed: false }))
      .toMatchObject({ draft, confirmed: false });
  });

  it('accepts a large ids array for TOUCH_MEMORIES without truncating', () => {
    const ids = Array.from({ length: 5_000 }, (_, index) => index + 1);
    const decoded = decodePersistenceRuntimePayload('TOUCH_MEMORIES', { ids });
    expect(decoded.ids).toHaveLength(5_000);
    expect(decoded.ids[0]).toBe(1);
    expect(decoded.ids[4_999]).toBe(5_000);
  });

  it('allows a null id for SET_ACTIVE_PRESET (clear active preset)', () => {
    expect(decodePersistenceRuntimePayload('SET_ACTIVE_PRESET', { id: null })).toEqual({ id: null });
  });
});

describe('decodePersistenceRuntimePayload · corrupt top-level input', () => {
  it.each([
    ['null', null],
    ['an array', ['x']],
    ['a string', 'oops'],
    ['a number', 42],
    ['undefined', undefined],
  ])('rejects %s for GET_MEMORY_BY_ID', (_label, raw) => {
    expect(() => decodePersistenceRuntimePayload('GET_MEMORY_BY_ID', raw)).toThrow();
  });
});

describe('decodePersistenceRuntimePayload · field-type damage', () => {
  it('rejects a missing / zero / negative / fractional / string id', () => {
    expect(() => decodePersistenceRuntimePayload('GET_MEMORY_BY_ID', {})).toThrow();
    expect(() => decodePersistenceRuntimePayload('GET_MEMORY_BY_ID', { id: 0 })).toThrow();
    expect(() => decodePersistenceRuntimePayload('GET_MEMORY_BY_ID', { id: -1 })).toThrow();
    expect(() => decodePersistenceRuntimePayload('GET_MEMORY_BY_ID', { id: 1.5 })).toThrow();
    expect(() => decodePersistenceRuntimePayload('GET_MEMORY_BY_ID', { id: '7' })).toThrow();
  });

  it('rejects SET_SKILL_ENABLED with a non-boolean enabled or blank name', () => {
    expect(() => decodePersistenceRuntimePayload('SET_SKILL_ENABLED', { name: 'x', enabled: 'yes' })).toThrow();
    expect(() => decodePersistenceRuntimePayload('SET_SKILL_ENABLED', { name: '  ', enabled: true })).toThrow();
  });

  it('rejects APPLY_MEMORY_ORGANIZE_DRAFT with a missing/non-object draft or non-boolean confirmed', () => {
    expect(() => decodePersistenceRuntimePayload('APPLY_MEMORY_ORGANIZE_DRAFT', { confirmed: true })).toThrow();
    expect(() => decodePersistenceRuntimePayload('APPLY_MEMORY_ORGANIZE_DRAFT', { draft: null, confirmed: true })).toThrow();
    expect(() => decodePersistenceRuntimePayload('APPLY_MEMORY_ORGANIZE_DRAFT', { draft: {}, confirmed: 'yes' })).toThrow();
  });

  it('rejects TOUCH_MEMORIES with a non-array ids or a non-positive member', () => {
    expect(() => decodePersistenceRuntimePayload('TOUCH_MEMORIES', { ids: '1,2,3' })).toThrow();
    expect(() => decodePersistenceRuntimePayload('TOUCH_MEMORIES', { ids: [1, 0, 3] })).toThrow();
    expect(() => decodePersistenceRuntimePayload('TOUCH_MEMORIES', { ids: [1, '2'] })).toThrow();
  });

  it('rejects DELETE_SKILL with a blank name', () => {
    expect(() => decodePersistenceRuntimePayload('DELETE_SKILL', { name: '' })).toThrow();
  });
});
