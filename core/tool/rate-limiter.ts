// W18: 工具调用速率限制
// 纯函数，无外部依赖

export interface RateLimitPolicy {
  windowMs: number;
  maxCalls: number;
}

export const DEFAULT_TOOL_RATE: RateLimitPolicy = { windowMs: 60_000, maxCalls: 20 };

export interface RateLimiter {
  tryAcquire(now?: number): boolean;
  retryAfterMs(now?: number): number;
}

export function createRateLimiter(policy: RateLimitPolicy = DEFAULT_TOOL_RATE): RateLimiter {
  const hits: number[] = [];
  return {
    tryAcquire(now = Date.now()): boolean {
      while (hits.length > 0 && now - hits[0]! > policy.windowMs) hits.shift();
      if (hits.length >= policy.maxCalls) return false;
      hits.push(now);
      return true;
    },
    retryAfterMs(now = Date.now()): number {
      if (hits.length < policy.maxCalls) return 0;
      return Math.max(0, policy.windowMs - (now - hits[0]!));
    },
  };
}
