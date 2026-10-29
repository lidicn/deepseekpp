/**
 * 工具限流闸门守卫（2026-10-30 真机发现）。
 *
 * 真机事实：审计类任务的 agent loop 在 ~11 秒内打满 60 次 `shell_exec`，
 * 之后每次都被本机限流器拦下，**把错误当工具结果交给模型** ⇒ 模型立刻重试
 * ⇒ 一步一个"工具调用过于频繁"，直到步数烧完，最终答复全是限流文案。
 *
 * 修法：窗口 60 → 180，且闸门层"等够再放行"（`acquireExecutionGate`）。
 *
 * 变异（可判红）：
 *   - `planRateLimitWait` 恒返回 null ⇒ 用例 1 红
 *   - 去掉 `retryAfterMs > maxWaitMs` 上限 ⇒ 用例 2 红（会挂住 48 秒）
 *   - 窗口改回 60 ⇒ 用例 5 红
 */
import { describe, expect, it } from 'vitest';
import {
  RATE_LIMIT_WAIT_POLICY,
  checkExecutionGate,
  planRateLimitWait,
} from '../core/tool/execution-gates';
import type { ToolDescriptor, ToolResult } from '../core/types';

function rateLimited(retryAfterMs: number): ToolResult {
  return {
    ok: false,
    name: 'shell_exec',
    provider: { kind: 'local', id: 'local' },
    summary: '工具调用过于频繁',
    detail: '稍后再试',
    error: {
      code: 'TOOL_RATE_LIMITED',
      message: `retry after ${retryAfterMs}ms`,
      retryable: true,
      details: { retryAfterMs },
    },
  } as unknown as ToolResult;
}

function makeDescriptor(): ToolDescriptor {
  return {
    id: 'local:shell_exec',
    name: 'shell_exec',
    invocationName: 'shell_exec',
    title: 'Run shell',
    description: 'run a command',
    inputSchema: { type: 'object', properties: {} },
    provider: { kind: 'local', id: 'local' },
  } as unknown as ToolDescriptor;
}

describe('planRateLimitWait · 等够再放行', () => {
  it('★ 限流 + 可等的 retryAfter ⇒ 返回等待毫秒（含 250ms 余量）', () => {
    expect(planRateLimitWait(rateLimited(5_000), 0)).toBe(5_250);
  });

  it('★ 超过 maxWaitMs（如真机实测 48s）⇒ 不等，把错误交上去', () => {
    expect(planRateLimitWait(rateLimited(48_648), 0)).toBeNull();
    expect(RATE_LIMIT_WAIT_POLICY.maxWaitMs).toBeLessThan(48_648);
  });

  it('★ 重试次数用尽 ⇒ 不等', () => {
    expect(planRateLimitWait(rateLimited(1_000), RATE_LIMIT_WAIT_POLICY.maxAttempts)).toBeNull();
  });

  it('负控：非限流错误 / 成功结果 ⇒ 不等', () => {
    const other = { ...rateLimited(1_000) } as unknown as ToolResult;
    (other as { error: { code: string } }).error.code = 'TOOL_TIMEOUT';
    expect(planRateLimitWait(other, 0)).toBeNull();
    expect(planRateLimitWait({ ok: true } as ToolResult, 0)).toBeNull();
    expect(planRateLimitWait(undefined, 0)).toBeNull();
  });

  it('负控：retryAfterMs 缺失或非法 ⇒ 不等（不能凭空空等）', () => {
    const broken = { ...rateLimited(0) } as unknown as ToolResult;
    expect(planRateLimitWait(broken, 0)).toBeNull();
  });
});

describe('限流窗口（真机 60 次/分钟太窄）', () => {
  it('★ 同一工具连续 180 次放行，第 181 次才被拦（旧窗口 60 次就拦）', () => {
    const descriptor = makeDescriptor();
    let blockedAt = -1;
    for (let i = 0; i < 200; i += 1) {
      const gate = checkExecutionGate(descriptor, 'zh-CN');
      if (!gate.allowed) {
        blockedAt = i + 1;
        expect(gate.blockedResult?.error?.code).toBe('TOOL_RATE_LIMITED');
        expect(Number(gate.blockedResult?.error?.details?.retryAfterMs ?? 0)).toBeGreaterThan(0);
        break;
      }
    }
    expect(blockedAt).toBe(181);
  });
});
