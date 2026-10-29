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
// 2026-10-30：60 → 180。
// 真机实测：审计类任务的 agent loop 会在 ~11 秒内打满 60 次 shell_exec，
// 随后每次调用都被本机限流器拦下并**把错误当工具结果交给模型**，
// 模型立刻重试 ⇒ 烧步数、烧 nudge，最终答复里全是"工具调用过于频繁"。
// 180/min（≈3/s）给足突发空间，同时仍能拦住真正失控的循环。
export const TOOL_RATE_POLICY = { windowMs: 60_000, maxCalls: 180 } as const;
const RATE_POLICY = TOOL_RATE_POLICY;
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

/**
 * 限流命中后的等待重试策略（纯逻辑，好测）。
 *
 * 为什么需要：模型不会"自己等"。旧行为是把 TOOL_RATE_LIMITED 当普通工具结果返回，
 * 模型立刻重发同一条命令 ⇒ 又一次命中 ⇒ 一步一个错误，直到步数烧完。
 * 与其把等待责任推给模型，不如在**闸门这一层**等够再放行。
 *
 * 返回需要等待的毫秒数；返回 null 表示"别等，直接把错误交上去"。
 */
export const RATE_LIMIT_WAIT_POLICY = {
  /** 单次最长等待（超过就别等了，交回错误让模型换策略）。 */
  maxWaitMs: 20_000,
  /** 最多重试几次（每次都会重新判闸门）。 */
  maxAttempts: 2,
} as const;

export function planRateLimitWait(
  blocked: ToolResult | undefined,
  attempt: number,
): number | null {
  if (!blocked || blocked.ok) return null;
  const error = (blocked as { error?: { code?: string; details?: { retryAfterMs?: number } } }).error;
  if (error?.code !== 'TOOL_RATE_LIMITED') return null;
  if (attempt >= RATE_LIMIT_WAIT_POLICY.maxAttempts) return null;
  const retryAfterMs = Number(error.details?.retryAfterMs ?? 0);
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return null;
  if (retryAfterMs > RATE_LIMIT_WAIT_POLICY.maxWaitMs) return null;
  // 多等 250ms 避免贴着窗口边界再次命中
  return Math.min(retryAfterMs + 250, RATE_LIMIT_WAIT_POLICY.maxWaitMs + 250);
}

/**
 * 取闸门（带等待重试）。两个调用点都必须用它，否则限流仍会被当错误丢给模型。
 */
export async function acquireExecutionGate(
  descriptor: ToolDescriptor,
  locale: SupportedLocale,
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<GateCheck> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let gate = checkExecutionGate(descriptor, locale);
  let attempt = 0;
  while (!gate.allowed) {
    const waitMs = planRateLimitWait(gate.blockedResult, attempt);
    if (waitMs === null) return gate;
    await sleep(waitMs);
    attempt += 1;
    gate = checkExecutionGate(descriptor, locale);
  }
  return gate;
}

