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
  // 审计 #2（2026-10-24 报告 P1）：原来没有「探针在途」的概念 —— 一旦进入 halfOpen，
  // `allow()` 就永久返回 true。若那个探针悬挂（既不成功也不失败），两个 recorder
  // 都不会被调用，state 永远停在 halfOpen，之后**所有请求都穿透熔断器**。
  // 现在 halfOpen 只放**一个**探针出去；探针未回之前其余请求一律拒绝。
  let probeInFlight = false;
  return {
    allow(now = Date.now()): boolean {
      if (state === 'closed') return true;
      if (state === 'open' && now - openedAt >= opts.cooldownMs) {
        state = 'halfOpen';
        probeInFlight = true;
        return true;
      }
      if (state === 'halfOpen') {
        // 已有探针在途：拒绝新请求，避免半开态退化成「全放行」
        if (probeInFlight) return false;
        probeInFlight = true;
        return true;
      }
      return false;
    },
    recordSuccess(): void {
      state = 'closed';
      failures = 0;
      probeInFlight = false;
    },
    recordFailure(now = Date.now()): void {
      failures += 1;
      probeInFlight = false;
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
