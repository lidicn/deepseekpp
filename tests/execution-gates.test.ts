/**
 * W18/W19 接线：provider 维度熔断器 + 速率限制闸门。
 * 用假 now() 注入，不依赖真实计时窗口。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkExecutionGate,
  resetExecutionGatesForTests,
} from '../core/tool/execution-gates';
import type { ToolDescriptor } from '../core/tool/types';

function desc(kind: string, id: string): ToolDescriptor {
  return {
    provider: { kind: kind as never, id: id as never, displayName: id, transport: 'local' as never },
    name: 't',
    invocationName: 't',
    title: 't',
    description: 't',
    inputSchema: { type: 'object', properties: {} },
    execution: { timeoutMs: 1000 },
  };
}

describe('execution-gates · W19 熔断器', () => {
  beforeEach(() => resetExecutionGatesForTests());

  it('连续 3 次失败后第 4 次被熔断，不再发起真实调用', () => {
    const d = desc('mcp', 'serverA');
    for (let i = 0; i < 3; i++) {
      const g = checkExecutionGate(d, 'en');
      expect(g.allowed).toBe(true);
      g.breaker.recordFailure();
    }
    const g = checkExecutionGate(d, 'en');
    expect(g.allowed).toBe(false);
    expect(g.blockedResult?.error?.code).toBe('TOOL_CIRCUIT_OPEN');
  });

  it('serverA 熔断不影响 serverB（负控）', () => {
    const a = desc('mcp', 'serverA');
    const b = desc('mcp', 'serverB');
    for (let i = 0; i < 3; i++) {
      const ga = checkExecutionGate(a, 'en');
      ga.breaker.recordFailure();
    }
    expect(checkExecutionGate(a, 'en').allowed).toBe(false);
    expect(checkExecutionGate(b, 'en').allowed).toBe(true);
  });

  it('冷却后放行恰好一个探针', () => {
    const d = desc('mcp', 'serverA');
    for (let i = 0; i < 3; i++) {
      const g = checkExecutionGate(d, 'en');
      g.breaker.recordFailure();
    }
    expect(checkExecutionGate(d, 'en').allowed).toBe(false);
    // 直接用 breaker 的 allow(now) 验证冷却后半开只放一个探针
    const after = Date.now() + 30_001;
    const g = checkExecutionGate(d, 'en');
    expect(g.breaker.allow(after)).toBe(true);
    expect(g.breaker.allow(after)).toBe(false);
  });
});

describe('execution-gates · W18 限流', () => {
  beforeEach(() => resetExecutionGatesForTests());

  it('maxCalls=60 内放行，第 61 次被拒', () => {
    const d = desc('mcp', 'serverA');
    for (let i = 0; i < 60; i++) {
      expect(checkExecutionGate(d, 'en').allowed).toBe(true);
    }
    const g = checkExecutionGate(d, 'en');
    expect(g.allowed).toBe(false);
    expect(g.blockedResult?.error?.code).toBe('TOOL_RATE_LIMITED');
  });

  it('窗口滑动后恢复', () => {
    const d = desc('mcp', 'serverA');
    const now = 1_000_000;
    for (let i = 0; i < 60; i++) {
      const g = checkExecutionGate(d, 'en');
      // 直接操作 limiter 注入 now
      g.limiter.tryAcquire(now);
    }
    // 窗内仍拒
    expect(checkExecutionGate(d, 'en').allowed).toBe(false);
    // 不直接测滑动恢复——limiter 的窗口逻辑已在 rate-limiter.test.ts 覆盖
  });

  it('两个 provider 互不影响', () => {
    const a = desc('mcp', 'serverA');
    const b = desc('mcp', 'serverB');
    for (let i = 0; i < 60; i++) checkExecutionGate(a, 'en');
    expect(checkExecutionGate(a, 'en').allowed).toBe(false);
    expect(checkExecutionGate(b, 'en').allowed).toBe(true);
  });
});
