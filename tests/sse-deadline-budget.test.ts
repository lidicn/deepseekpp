/**
 * 审计 #63：SSE 传输必须共用**一个总超时预算**。
 *
 * 原实现里 GET 连接、endpoint 解析、POST、读响应四个阶段，各自都以
 * `Date.now() + timeoutMs` 起算 ⇒ 串起来最坏可达 4× timeoutMs，
 * 调用方按 `timeouts.requestMs` 设的预算形同虚设。
 *
 * 本用例是**行为级**的（不是结构断言）：
 *   · 让 GET 阶段消耗掉预算的一部分（200ms / 总预算 500ms）
 *   · 让 endpoint 阶段永远不吐 `endpoint` 事件（卡住）
 *   · 断言整体在**总预算**附近失败（< 640ms），而不是 200ms + 500ms ≈ 700ms
 * 若把 GET 阶段的预算改回 `timeoutMs`（复现旧行为），本用例必须变红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpSseTransport } from '../core/mcp/transports/sse';
import type { McpServerConfig } from '../core/mcp/types';

const TOTAL_BUDGET_MS = 500;
const getPhaseDelayMs = 200;
/** 修好后的上界：总预算 + 调度抖动。旧行为约 700ms，会越过这条线。 */
const EXPECTED_UPPER_BOUND_MS = 640;

function makeServer(): McpServerConfig {
  return {
    version: 1,
    id: 'sse-budget-probe',
    displayName: 'SSE budget probe',
    enabled: true,
    transport: { kind: 'sse', url: 'https://example.test/sse' },
    headers: [],
    secrets: [],
    timeouts: { connectMs: TOTAL_BUDGET_MS, requestMs: TOTAL_BUDGET_MS, discoveryMs: TOTAL_BUDGET_MS },
    limits: { maxResultBytes: 1_000_000, maxToolCount: 10 },
    allowlist: { mode: 'all', toolNames: [] },
    execution: { mode: 'auto', enabled: true },
    status: 'ready',
    lastConnectedAt: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as McpServerConfig;
}

/**
 * 永不 resolve 的 SSE reader：把 endpoint 阶段精确卡到 deadline。
 *
 * 不用真 `ReadableStream`：jsdom 的 `Response` 会把空流当成"已结束"，
 * 于是走的是 `mcp_sse_endpoint_missing` 而不是超时，测不到预算行为。
 * 这里只提供 transport 真正用到的那两个成员（read / cancel）。
 */
function stallingResponse(): Response {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => new Promise<never>(() => {}),
        cancel: async () => undefined,
      }),
    },
  } as unknown as Response;
}

describe('审计 #63：SSE 四阶段共用总超时预算', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      permissions: { contains: vi.fn(async () => true) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('★ 连接阶段消耗一部分预算后，endpoint 阶段只能花剩下的时间', async () => {
    const fetchMock = vi.fn(async () => {
      // 模拟"连接慢但成功"：吃掉 200ms 预算
      await new Promise((resolve) => setTimeout(resolve, getPhaseDelayMs));
      return stallingResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    const transport = createMcpSseTransport(makeServer());
    const startedAt = Date.now();

    await expect(
      transport.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { timeoutMs: TOTAL_BUDGET_MS }),
    ).rejects.toMatchObject({ code: 'mcp_transport_timeout' });

    const elapsed = Date.now() - startedAt;
    // 必须按总预算收口：200（GET）+ 500（若各阶段独立计时）≈ 700 会越过上界。
    expect(elapsed).toBeLessThan(EXPECTED_UPPER_BOUND_MS);
  }, 10_000);
});
