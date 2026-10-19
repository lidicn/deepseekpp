import { describe, it, expect } from 'vitest';
import { createCircuitBreaker } from '../core/resilience/circuit-breaker';

describe('circuit-breaker', () => {
  it('初始 closed', () => {
    const cb = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    expect(cb.getState()).toBe('closed');
    expect(cb.allow()).toBe(true);
  });

  it('连续失败转 open', () => {
    const cb = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    cb.recordFailure(100);
    cb.recordFailure(100);
    expect(cb.getState()).toBe('closed');
    cb.recordFailure(100);
    expect(cb.getState()).toBe('open');
  });

  it('open 期拒绝', () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    cb.recordFailure(100);
    cb.recordFailure(100);
    expect(cb.allow(200)).toBe(false);
  });

  it('冷却后 halfOpen', () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    cb.recordFailure(100);
    cb.recordFailure(100);
    expect(cb.allow(1200)).toBe(true);
    expect(cb.getState()).toBe('halfOpen');
  });

  it('halfOpen 成功后 closed', () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    cb.recordFailure(100);
    cb.recordFailure(100);
    cb.allow(1200);
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('halfOpen 失败回 open', () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    cb.recordFailure(100);
    cb.recordFailure(100);
    cb.allow(1200);
    cb.recordFailure(1300);
    expect(cb.getState()).toBe('open');
  });
});
