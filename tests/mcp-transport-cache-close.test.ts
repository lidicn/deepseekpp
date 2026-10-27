/**
 * 审计 #65：淘汰/失效缓存 transport 时必须**关闭底层连接**。
 *
 * 之前所有失效路径都只做 `cache.delete()`：native messaging 的 Port 会一直挂在
 * 模块级 `nativePortStates` 里（直到宿主断开或 GC）⇒ 高频切换 server 或配置反复变更时稳定泄漏连接。
 *
 * 变异方式：把 `evict()` 里的 `entry.transport.close?.()` 删掉 ⇒ 本文件前四条必须红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMcpTransportCache,
  getCachedMcpTransport,
  invalidateMcpTransportCache,
  setCachedMcpTransport,
} from '../core/mcp/client-cache';
import type { McpProtocolTransport, McpServerConfig } from '../core/mcp/types';

function makeServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    version: 1,
    id: 'srv-65',
    displayName: 'srv-65',
    enabled: true,
    transport: { kind: 'http', url: 'https://example.test/mcp' },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 1000, requestMs: 1000, discoveryMs: 1000 },
    limits: { maxResultBytes: 1000, maxToolCount: 10 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { mode: 'auto', enabled: true },
    status: 'ready',
    lastConnectedAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as unknown as McpServerConfig;
}

function makeTransport(): { transport: McpProtocolTransport; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  return {
    close,
    transport: {
      request: vi.fn(async () => ({ jsonrpc: '2.0', id: 1, result: {} })),
      close,
    } as unknown as McpProtocolTransport,
  };
}

describe('审计 #65：缓存淘汰必须关闭底层连接', () => {
  beforeEach(() => clearMcpTransportCache());
  afterEach(() => {
    clearMcpTransportCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('★ 显式 invalidate 时关闭连接', () => {
    const { transport, close } = makeTransport();
    setCachedMcpTransport(makeServer(), transport);

    invalidateMcpTransportCache('srv-65');

    expect(close).toHaveBeenCalledTimes(1);
    expect(getCachedMcpTransport(makeServer())).toBeUndefined();
  });

  it('★ 配置变更导致失效时关闭连接', () => {
    const { transport, close } = makeTransport();
    setCachedMcpTransport(makeServer(), transport);

    // 只改 displayName 不算配置变更（不进 hash）；要改 transport 才能触发失效
    const changed = makeServer({ transport: { kind: 'http', url: 'https://other.test/mcp' } });
    expect(getCachedMcpTransport(changed)).toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('★ TTL 过期时关闭连接', () => {
    const { transport, close } = makeTransport();
    setCachedMcpTransport(makeServer(), transport);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60 * 60 * 1000); // 远超任何 TTL
    expect(getCachedMcpTransport(makeServer())).toBeUndefined();
    vi.useRealTimers();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('★ 清空缓存时逐个关闭连接', () => {
    const first = makeTransport();
    const second = makeTransport();
    setCachedMcpTransport(makeServer({ id: 'a' }), first.transport);
    setCachedMcpTransport(makeServer({ id: 'b' }), second.transport);

    clearMcpTransportCache();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('负控：命中缓存时不得关闭连接', () => {
    const { transport, close } = makeTransport();
    setCachedMcpTransport(makeServer(), transport);

    expect(getCachedMcpTransport(makeServer())).toBe(transport);
    expect(close).not.toHaveBeenCalled();
  });

  it('负控：close 抛错不能阻止缓存淘汰', () => {
    const transport = {
      request: vi.fn(async () => ({ jsonrpc: '2.0', id: 1, result: {} })),
      close: vi.fn(() => {
        throw new Error('close boom');
      }),
    } as unknown as McpProtocolTransport;
    setCachedMcpTransport(makeServer(), transport);

    expect(() => invalidateMcpTransportCache('srv-65')).not.toThrow();
    expect(getCachedMcpTransport(makeServer())).toBeUndefined();
  });
});
