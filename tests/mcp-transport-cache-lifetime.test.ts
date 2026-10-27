/**
 * 审计 #73：热连接不能永不过期。
 *
 * `getCachedMcpTransport` 每次命中都 `entry.lastUsed = Date.now()`（滑动过期），
 * 所以一个"每 4 分钟被用一次"的连接**永远不会被 TTL 淘汰** ——
 * 而底层连接（native Port / SSE 流）可能早已半死（对端重启、会话失效），
 * 表现为"偶发超时"而不是立刻报错。
 *
 * 修法：加绝对存活上限 `MAX_CONNECTION_LIFETIME_MS`（30 分钟 = 6 × TTL），
 * 到点即淘汰，不受滑动续期影响。
 *
 * 变异方式：把 `Date.now() - entry.createdAt > MAX_CONNECTION_LIFETIME_MS` 这段删掉
 * ⇒ 第一条用例必须红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMcpTransportCache,
  getCachedMcpTransport,
  setCachedMcpTransport,
} from '../core/mcp/client-cache';
import type { McpProtocolTransport, McpServerConfig } from '../core/mcp/types';

const MINUTE = 60 * 1000;

function makeServer(): McpServerConfig {
  return {
    version: 1,
    id: 'srv-73',
    displayName: 'srv-73',
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
  } as unknown as McpServerConfig;
}

function makeTransport(): { transport: McpProtocolTransport; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  return {
    close,
    transport: { request: vi.fn(), close } as unknown as McpProtocolTransport,
  };
}

describe('审计 #73：热连接有绝对存活上限', () => {
  beforeEach(() => {
    clearMcpTransportCache();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    clearMcpTransportCache();
  });

  it('★ 持续命中（每次都在 5 分钟 TTL 内）也不能超过 30 分钟绝对寿命', () => {
    const { transport } = makeTransport();
    setCachedMcpTransport(makeServer(), transport);

    // 每 4 分钟用一次（< 5 分钟 TTL），直到 28 分钟 —— 都应该命中
    for (let elapsed = 4; elapsed <= 28; elapsed += 4) {
      vi.setSystemTime(elapsed * MINUTE);
      expect(getCachedMcpTransport(makeServer())).toBe(transport);
    }

    // 31 分钟时：绝对寿命（30 分钟）已到 ⇒ 必须失效，哪怕 3 分钟前刚用过
    vi.setSystemTime(31 * MINUTE);
    expect(getCachedMcpTransport(makeServer())).toBeUndefined();
  });

  it('★ 绝对寿命到期时关闭底层连接', () => {
    const { transport, close } = makeTransport();
    setCachedMcpTransport(makeServer(), transport);

    vi.setSystemTime(31 * MINUTE);
    expect(getCachedMcpTransport(makeServer())).toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('负控：30 分钟以内、且每次都在 TTL 内，持续命中不受影响', () => {
    const { transport } = makeTransport();
    setCachedMcpTransport(makeServer(), transport);

    // 每 4 分钟命中一次（< 5 分钟 TTL），一直到 28 分钟：距创建 28 < 30 ⇒ 全程应命中
    for (let elapsed = 4; elapsed <= 28; elapsed += 4) {
      vi.setSystemTime(elapsed * MINUTE);
      expect(getCachedMcpTransport(makeServer())).toBe(transport);
    }
  });

  it('负控：超过 5 分钟没用过，仍按滑动 TTL 淘汰（原行为不变）', () => {
    const { transport } = makeTransport();
    setCachedMcpTransport(makeServer(), transport);

    vi.setSystemTime(6 * MINUTE);
    expect(getCachedMcpTransport(makeServer())).toBeUndefined();
  });
});
