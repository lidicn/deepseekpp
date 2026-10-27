// W18 + W19 接线：按 provider 维度的熔断器 + 速率限制闸门。
// 纯函数模块，持有 providerKey → breaker/limiter 的 Map。
// 一个 server 熔断不连累其它 server；多 provider 任务互不挤占限流。
import { translate, type SupportedLocale } from '../i18n/background';
import { createCircuitBreaker, type CircuitBreaker } from '../resilience/circuit-breaker';
import { createRateLimiter, DEFAULT_TOOL_RATE, type RateLimiter } from './rate-limiter';
import type { ToolDescriptor, ToolResult } from './types';

// W18 限流维度：按 provider 维度（不是全局，也不是按工具名）。
// 理由（PM 提示词要求二选一）：正常多工具任务 10 步 × 2 工具 = 20 次/60s 正好卡
// 默认 20 的边界，会误伤。按 provider 维度限流后，不同 provider 互不挤占；同一
// provider 内把 maxCalls 提到 60，给一个 server 的正常工具密度留足余量，又仍能挡住
// 真正的高频风暴（一个 server 一秒钟连打几十个工具）。
const RATE_POLICY = { windowMs: 60_000, maxCalls: 60 } as const;
const BREAKER_OPTS = { failureThreshold: 3, cooldownMs: 30_000 } as const;

const breakers = new Map<string, CircuitBreaker>();
const limiters = new Map<string, RateLimiter>();

function providerKey(descriptor: ToolDescriptor): string {
  const p = descriptor.provider;
  if (!p) return 'builtin:local';
  return `${p.kind}:${p.id}`;
}

function getBreaker(descriptor: ToolDescriptor): CircuitBreaker {
  const key = providerKey(descriptor);
  let b = breakers.get(key);
  if (!b) {
    b = createCircuitBreaker({ ...BREAKER_OPTS });
    breakers.set(key, b);
  }
  return b;
}

function getLimiter(descriptor: ToolDescriptor): RateLimiter {
  const key = providerKey(descriptor);
  let l = limiters.get(key);
  if (!l) {
    l = createRateLimiter({ ...RATE_POLICY });
    limiters.set(key, l);
  }
  return l;
}

export interface GateCheck {
  allowed: boolean;
  blockedResult?: ToolResult;
  breaker: CircuitBreaker;
  limiter: RateLimiter;
}

export function checkExecutionGate(
  descriptor: ToolDescriptor,
  locale: SupportedLocale,
): GateCheck {
  const breaker = getBreaker(descriptor);
  const limiter = getLimiter(descriptor);

  if (!breaker.allow()) {
    return {
      allowed: false,
      breaker,
      limiter,
      blockedResult: {
        ok: false,
        name: descriptor.name,
        provider: descriptor.provider,
        summary: translate(locale, 'tool.web.circuitOpenSummary'),
        detail: translate(locale, 'tool.web.circuitOpenDetail', { provider: descriptor.provider?.displayName ?? descriptor.name }),
        error: {
          code: 'TOOL_CIRCUIT_OPEN',
          message: 'Provider circuit breaker is open; provider is temporarily unavailable.',
          retryable: true,
        },
      },
    };
  }

  if (!limiter.tryAcquire()) {
    const retryMs = limiter.retryAfterMs();
    return {
      allowed: false,
      breaker,
      limiter,
      blockedResult: {
        ok: false,
        name: descriptor.name,
        provider: descriptor.provider,
        summary: translate(locale, 'tool.web.rateLimitedSummary'),
        detail: translate(locale, 'tool.web.rateLimitedDetail', { ms: String(retryMs) }),
        error: {
          code: 'TOOL_RATE_LIMITED',
          message: `Tool call rate limit exceeded; retry after ${retryMs}ms.`,
          retryable: true,
          details: { retryAfterMs: retryMs },
        },
      },
    };
  }

  return { allowed: true, breaker, limiter };
}

/** 测试钩子：清空 provider 维度的 breaker/limiter（避免用例间串状态）。 */
export function resetExecutionGatesForTests(): void {
  breakers.clear();
  limiters.clear();
}
