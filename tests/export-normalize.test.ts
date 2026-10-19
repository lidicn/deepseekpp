import { describe, it, expect } from 'vitest';
import { normalizeDeepSeekSessionSummary, extractBizData } from '../core/export/normalize';

describe('normalizeDeepSeekSessionSummary', () => {
  it('空输入抛错', () => {
    expect(() => normalizeDeepSeekSessionSummary(null, 0, false)).toThrow();
  });
  it('正常输入提取 id', () => {
    const s = normalizeDeepSeekSessionSummary({ id: 'abc', title: 'test' }, 1, false);
    expect(s.id).toBe('abc');
  });
});

describe('extractBizData', () => {
  it('空对象', () => {
    expect(extractBizData({})).toEqual({});
  });
  it('提取 bizData', () => {
    const raw = { data: { biz_data: { key: 'val' } }, other: 1 };
    const result = extractBizData(raw);
    expect(result.key).toBe('val');
  });
  it('非对象返回空', () => {
    expect(extractBizData('str')).toEqual({});
  });
  it('null 返回空', () => {
    expect(extractBizData(null)).toEqual({});
  });
});
