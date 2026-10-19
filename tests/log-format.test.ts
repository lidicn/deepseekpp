import { describe, it, expect } from 'vitest';
import { fmtFields } from '../core/diagnostics/log-format';

describe('log-format', () => {
  it('基本格式化', () => {
    expect(fmtFields({ a: 1, b: 'x' })).toBe('a=1 b=x');
  });
  it('跳过 null/undefined', () => {
    expect(fmtFields({ a: 1, b: null, c: undefined })).toBe('a=1');
  });
  it('空对象', () => {
    expect(fmtFields({})).toBe('');
  });
  it('布尔值', () => {
    expect(fmtFields({ ok: true })).toBe('ok=true');
  });
});
