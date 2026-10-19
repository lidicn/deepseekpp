import { describe, it, expect } from 'vitest';
import { estimateUsage } from '../core/diagnostics/storage-usage';

describe('storage-usage', () => {
  it('空 entries', () => {
    expect(estimateUsage({}, ['a']).bytes).toBe(0);
  });
  it('计算字节数', () => {
    const r = estimateUsage({ a: 'x'.repeat(100) }, ['a']);
    expect(r.bytes).toBeGreaterThan(0);
  });
  it('阈值判断', () => {
    const small = estimateUsage({ a: 'x'.repeat(10000) }, ['a'], 1000);
    expect(small.overThreshold).toBe(true);
  });
  it('缺失 key 跳过', () => {
    expect(estimateUsage({ a: 1 }, ['b']).bytes).toBe(0);
  });
});
