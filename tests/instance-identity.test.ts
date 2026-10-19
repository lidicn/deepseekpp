import { describe, it, expect } from 'vitest';
import { createInstanceIdentity, CONTEXT_NAMES } from '../core/instance/identity';

describe('createInstanceIdentity (W36)', () => {
  it('注入 now：context/startedAt 精确回传，instanceId 非空', () => {
    const id = createInstanceIdentity('background', 1_700_000_000_000);
    expect(id.context).toBe('background');
    expect(id.startedAt).toBe(1_700_000_000_000);
    expect(typeof id.instanceId).toBe('string');
    expect(id.instanceId.length).toBeGreaterThan(0);
  });

  it('两次调用生成不同 instanceId', () => {
    const a = createInstanceIdentity('sidepanel', 1);
    const b = createInstanceIdentity('sidepanel', 1);
    expect(a.instanceId).not.toBe(b.instanceId);
  });

  it('非法 context 抛错，不静默落默认', () => {
    expect(() => createInstanceIdentity('worker' as never, 1)).toThrow(/未知上下文/);
  });

  it('缺省 now 取当前 epoch ms，且四个合法上下文均可创建', () => {
    const before = Date.now();
    const ids = CONTEXT_NAMES.map((c) => createInstanceIdentity(c));
    const after = Date.now();
    for (const id of ids) {
      expect(id.startedAt).toBeGreaterThanOrEqual(before);
      expect(id.startedAt).toBeLessThanOrEqual(after);
    }
    expect(ids.map((i) => i.context)).toEqual([...CONTEXT_NAMES]);
  });
});
