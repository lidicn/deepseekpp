// W19: 熔断器
// 纯函数，无外部依赖

export type BreakerState = 'closed' | 'open' | 'halfOpen';

export interface BreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
}

export interface CircuitBreaker {
  allow(now?: number): boolean;
  recordSuccess(): void;
  recordFailure(now?: number): void;
  getState(): BreakerState;
}

export function createCircuitBreaker(opts: BreakerOptions): CircuitBreaker {
  let state: BreakerState = 'closed';
  let failures = 0;
  let openedAt = 0;
  return {
    allow(now = Date.now()): boolean {
      if (state === 'closed') return true;
      if (state === 'open' && now - openedAt >= opts.cooldownMs) {
        state = 'halfOpen';
        return true;
      }
      return state === 'halfOpen';
    },
    recordSuccess(): void {
      state = 'closed';
      failures = 0;
    },
    recordFailure(now = Date.now()): void {
      failures += 1;
      if (failures >= opts.failureThreshold) {
        state = 'open';
        openedAt = now;
      }
    },
    getState(): BreakerState {
      return state;
    },
  };
}
