import { describe, it, expect } from 'vitest';
import { createRateLimiter, DEFAULT_TOOL_RATE } from '../core/tool/rate-limiter';

describe('rate-limiter', () => {
  it('窗口内放行', () => {
    const rl = createRateLimiter({ windowMs: 60_000, maxCalls: 5 });
    for (let i = 0; i < 5; i++) expect(rl.tryAcquire(1000)).toBe(true);
  });

  it('超限拒绝', () => {
    const rl = createRateLimiter({ windowMs: 60_000, maxCalls: 3 });
    rl.tryAcquire(1000);
    rl.tryAcquire(1000);
    rl.tryAcquire(1000);
    expect(rl.tryAcquire(1000)).toBe(false);
  });

  it('窗口滑动后恢复', () => {
    const rl = createRateLimiter({ windowMs: 1000, maxCalls: 2 });
    rl.tryAcquire(0);
    rl.tryAcquire(0);
    expect(rl.tryAcquire(500)).toBe(false);
    expect(rl.tryAcquire(1500)).toBe(true);
  });

  it('retryAfterMs 计算', () => {
    const rl = createRateLimiter({ windowMs: 1000, maxCalls: 2 });
    rl.tryAcquire(0);
    rl.tryAcquire(0);
    expect(rl.retryAfterMs(500)).toBe(500);
  });

  it('边界值', () => {
    const rl = createRateLimiter(DEFAULT_TOOL_RATE);
    expect(rl.retryAfterMs()).toBe(0);
  });
});
