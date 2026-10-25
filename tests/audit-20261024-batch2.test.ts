// 审计报告《deepseek-pp-审计报告.md》（2026-10-24，100 条）第二批修复的守护用例。
//
// 本批修 4 条 + 半条：
//   #9  fork-detector 超时 abort 不带 TimeoutError reason ⇒ 超时分支是死代码
//   #2  circuit-breaker 半开态探针在途时仍全放行 ⇒ 悬挂探针让熔断失效
//   #19 native 通知路径不检查 alive ⇒ 静默丢消息
//   #22 发现指纹含 secrets.value ⇒ 换密钥即清工具缓存
//   #25/#78 EXTRACT_MEMORY_FROM_CONVERSATION 无 sender/payload 校验 + 调试日志泄漏正文
//
// 另记录两条**假阳性**（本席核实后决定不改，见用例名）：
//   #16 broadcast 的 excludeTabId 会被直接发送 —— 是**有测试覆盖的设计**：
//       「不进批量列表、单独发一次」，保证发送方 tab 即使不匹配 URL pattern 也能收到
//   #12 withUnifiedTimeout 的 providerCall 不会被 classified as unhandled
//       —— Promise.race 已给双方挂 handler（实测 unhandledRejection 次数为 0）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCircuitBreaker } from '../core/resilience/circuit-breaker';
import { evaluateFork, probeForkWithTimeout } from '../core/chat/fork-detector';
import { mcpDiscoveryFingerprint } from '../core/mcp/store';

function readSource(relative: string): string {
  return readFileSync(join(process.cwd(), relative), 'utf8');
}

describe('审计 #9：fork 探针超时必须标成 TimeoutError', () => {
  it('超时后 evaluateFork 收到的是 TimeoutError，reason 为 probe_timeout 而不是 probe_failed', async () => {
    const probe = {
      // 真实 probe 会监听 signal；假 probe 也必须监听，否则 abort 后 await 永不结束
      readSessionChainTail(_input: unknown, signal: AbortSignal): Promise<never> {
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    };
    const result = await probeForkWithTimeout(
      probe as never,
      { chatSessionId: 's', expectedParentMessageId: 1 } as never,
      20,
    );
    expect(result.reason).toBe('probe_timeout');
  });

  it('evaluateFork 对 TimeoutError 的判定分支确实存在', () => {
    const timeoutError = new DOMException('timed out', 'TimeoutError');
    expect(evaluateFork(1, null, timeoutError).reason).toBe('probe_timeout');
    // 普通错误仍走 probe_failed（负控：别把两者混掉）
    expect(evaluateFork(1, null, new Error('boom')).reason).toBe('probe_failed');
  });
});

describe('审计 #2：半开态只能放一个探针', () => {
  function openBreaker() {
    const breaker = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 100 });
    breaker.recordFailure(0);
    breaker.recordFailure(0); // 达到阈值 ⇒ open
    expect(breaker.getState()).toBe('open');
    return breaker;
  }

  it('冷却后第一个请求放行（探针），第二个立即拒绝', () => {
    const breaker = openBreaker();
    expect(breaker.allow(200)).toBe(true); // 冷却已过 ⇒ halfOpen + 放探针
    expect(breaker.getState()).toBe('halfOpen');
    // 关键：探针还没回，再来请求必须被拒
    expect(breaker.allow(200)).toBe(false);
    expect(breaker.allow(201)).toBe(false);
  });

  it('悬挂探针不会退化成「全放行」（回归：修复前这里恒为 true）', () => {
    const breaker = openBreaker();
    expect(breaker.allow(200)).toBe(true);
    // 模拟探针悬挂：既不 recordSuccess 也不 recordFailure
    let allowed = 0;
    for (let i = 0; i < 50; i += 1) {
      if (breaker.allow(300 + i)) allowed += 1;
    }
    expect(allowed).toBe(0);
  });

  it('探针成功后恢复正常放行（负控）', () => {
    const breaker = openBreaker();
    expect(breaker.allow(200)).toBe(true);
    breaker.recordSuccess();
    expect(breaker.getState()).toBe('closed');
    expect(breaker.allow(200)).toBe(true);
    expect(breaker.allow(200)).toBe(true);
  });

  it('探针失败后重新 open，且冷却结束能再放新探针（负控）', () => {
    const breaker = openBreaker();
    expect(breaker.allow(200)).toBe(true);
    breaker.recordFailure(200);
    expect(breaker.getState()).toBe('open');
    expect(breaker.allow(250)).toBe(false); // 冷却未到
    expect(breaker.allow(400)).toBe(true);  // 冷却已过 ⇒ 新探针
  });
});

describe('审计 #19：native 通知路径必须检查 alive', () => {
  it('通知分支在 postMessage 前检查 state.alive', () => {
    const source = readSource('core/mcp/transports/native.ts');
    // 找通知分支（else 块）里的 alive 检查
    const idx = source.indexOf('state.port.postMessage(envelope);');
    expect(idx).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, idx - 900), idx);
    expect(before).toContain('if (!state.alive)');
    expect(before).toContain('mcp_native_host_disconnected');
  });
});

describe('审计 #22：轮换密钥不得清空工具缓存', () => {
  const base = {
    version: 1 as const,
    id: 'server-1',
    displayName: 'X',
    enabled: true,
    transport: { kind: 'http' as const, url: 'https://a.example/mcp' },
    headers: [],
    secrets: [{ kind: 'bearer' as const, value: 'old-key' }],
    timeouts: { connectMs: 1, requestMs: 2, discoveryMs: 3 },
    limits: { maxResultBytes: 1, maxToolCount: 1 },
    allowlist: { mode: 'all' as const, toolNames: [] },
    execution: { mode: 'auto' as const, enabled: true },
    status: 'ready' as const,
  };

  it('只换密钥值 ⇒ 指纹不变（修复前会变 ⇒ 工具列表被清空）', () => {
    const rotated = {
      ...base,
      secrets: [{ kind: 'bearer' as const, value: 'new-key' }],
    };
    expect(mcpDiscoveryFingerprint(base as never))
      .toBe(mcpDiscoveryFingerprint(rotated as never));
  });

  it('新增/移除密钥（空 ↔ 非空）⇒ 指纹变（负控：不能把这件事也吞掉）', () => {
    const withEmpty = { ...base, secrets: [{ kind: 'bearer' as const, value: '' }] };
    expect(mcpDiscoveryFingerprint(base as never))
      .not.toBe(mcpDiscoveryFingerprint(withEmpty as never));
  });
});

describe('审计 #25 / #78：EXTRACT 旁路必须有 sender 与 payload 校验', () => {
  const source = readSource('entrypoints/background.ts');
  const block = (() => {
    const start = source.indexOf("message.type === 'EXTRACT_MEMORY_FROM_CONVERSATION'");
    return source.slice(start, start + 2600);
  })();

  it('先校验发送方是 DeepSeek 页面，再处理', () => {
    expect(block).toContain('isDeepSeekPageUrl(sender?.url)');
    expect(block).toContain('unauthorized_sender');
    // 校验必须早于**实际调用** runExtractionHook(（注释里也提到了这个名字，所以按调用形状匹配）
    expect(block.indexOf('unauthorized_sender')).toBeLessThan(block.indexOf('await runExtractionHook('));
  });

  it('payload 三个字段必须是非空字符串', () => {
    expect(block).toContain('invalid_payload');
    expect(block).toContain("typeof rawPayload.chatSessionId === 'string'");
    expect(block).toContain("typeof rawPayload.userMessage === 'string'");
    expect(block).toContain("typeof rawPayload.assistantMessage === 'string'");
  });

  it('不再把消息正文打进 console（审计 #78）', () => {
    expect(block).not.toContain("console.log('[memory-extractor] 收到");
    expect(block).not.toContain("console.log('[memory-extractor] background 收到消息'");
  });
});
