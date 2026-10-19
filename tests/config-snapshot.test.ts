import { describe, it, expect } from 'vitest';
import { buildSnapshot, validateSnapshot } from '../core/config/snapshot';

describe('config-snapshot', () => {
  it('基本构建', () => {
    const s = buildSnapshot({ a: 1, b: 2 }, ['a']);
    expect(s.entries.a).toBe(1);
    expect(s.entries.b).toBeUndefined();
  });
  it('版本号', () => {
    const s = buildSnapshot({}, []);
    expect(s.version).toBe(1);
  });
  it('合法快照', () => {
    const s = buildSnapshot({ a: 1 }, ['a']);
    expect(validateSnapshot(s).ok).toBe(true);
  });
  it('损坏输入拒绝', () => {
    expect(validateSnapshot(null).ok).toBe(false);
    expect(validateSnapshot({}).ok).toBe(false);
  });
  it('时间戳', () => {
    const s = buildSnapshot({}, []);
    expect(typeof s.exportedAt).toBe('number');
  });
});
