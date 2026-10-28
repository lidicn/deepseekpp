/**
 * 审计 #64：native 响应的**关联 id 只能取顶层 `id`**。
 *
 * 原实现：`const id = response?.id ?? response?.result?.id`
 * 顶层缺 id 时会把**载荷里的 `result.id`** 当成关联 id —— 而工具结果天然可能带自己的 id
 * （memory id / 文件 id / 记录 id），于是一条**无主响应**会被投递给"恰好同 id"的在飞请求，
 * 调用方静默拿到别人的结果（比超时更难查）。
 *
 * 变异方式：把 `const rpcId = response?.id;` 改回 `response?.id ?? response?.result?.id`
 * ⇒ 第一条 ★ 用例必须红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpNativeMessagingTransport } from '../core/mcp/transports/native';
import type { McpProtocolTransport, McpServerConfig } from '../core/mcp/types';

type Listener = (message: unknown) => void;

function makeServer(nativeHost: string): McpServerConfig {
  return {
    version: 1,
    id: 'native-64',
    displayName: 'native-64',
    enabled: true,
    transport: { kind: 'native_messaging', nativeHost },
    headers: [],
    secrets: [],
    timeouts: { connectMs: 5000, requestMs: 5000, discoveryMs: 5000 },
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

interface FakePort {
  transport: McpProtocolTransport;
  emit(message: unknown): void;
  lastPostedId(): unknown;
  disconnectSpy: ReturnType<typeof vi.fn>;
}

function makePort(nativeHost: string): FakePort {
  const messageListeners: Listener[] = [];
  const disconnectSpy = vi.fn();
  const postMessage = vi.fn();
  const port = {
    onMessage: { addListener: (fn: Listener) => messageListeners.push(fn) },
    onDisconnect: { addListener: () => undefined },
    postMessage,
    disconnect: disconnectSpy,
  };
  vi.stubGlobal('chrome', {
    runtime: {
      connectNative: vi.fn(() => port),
      lastError: undefined,
    },
  });
  return {
    transport: createMcpNativeMessagingTransport(makeServer(nativeHost)),
    emit: (message: unknown) => {
      for (const listener of messageListeners) listener(message);
    },
    lastPostedId: () => {
      const calls = postMessage.mock.calls;
      // envelope 形如 { protocol, version, server, message: { jsonrpc, id, ... } }
      const envelope = calls.length > 0
        ? (calls[calls.length - 1]![0] as { id?: unknown; message?: { id?: unknown } })
        : undefined;
      return envelope?.message?.id ?? envelope?.id;
    },
    disconnectSpy,
  };
}

/** 让出事件循环，确保 request 内部已把 port 监听器注册好 */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** 等一个 tick，用来判断 promise 是否仍挂起 */
async function settledWithin(promise: Promise<unknown>, ms = 30): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(() => 'settled' as const, () => 'settled' as const),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);
}

describe('审计 #64：native 关联 id 只认顶层 id', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('★ 载荷里的 result.id 不得被当成关联 id（无主响应不能被投递）', async () => {
    const fake = makePort('host-64-a');
    const pendingRequest = fake.transport.request(
      { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'x', arguments: {} } },
      { timeoutMs: 800 },
    );

    // 顶层没有 id，只有载荷里的 result.id === 42（正是"别人的结果"的形态）
    await tick(); // 等 request 内部注册好 port 监听器再投递
    fake.emit({ result: { id: 42, value: 'someone-else' } });

    expect(await settledWithin(pendingRequest)).toBe('pending');
    expect(console.warn).toHaveBeenCalled();
  });

  it('负控：顶层 id 匹配时正常返回（不能把正常路径也堵死）', async () => {
    const fake = makePort('host-64-b');
    const pendingRequest = fake.transport.request(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x', arguments: {} } },
      { timeoutMs: 800 },
    );

    await tick();
    const realId = fake.lastPostedId();
    fake.emit({ jsonrpc: '2.0', id: realId, result: { ok: true } });

    await expect(pendingRequest).resolves.toMatchObject({ id: realId, result: { ok: true } });
  });

  it('负控：顶层 id 不匹配的响应不会被投递', async () => {
    const fake = makePort('host-64-c');
    const pendingRequest = fake.transport.request(
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'x', arguments: {} } },
      { timeoutMs: 800 },
    );

    await tick();
    const realId = fake.lastPostedId();
    fake.emit({ jsonrpc: '2.0', id: String(realId) + '-other', result: { ok: false } });

    expect(await settledWithin(pendingRequest)).toBe('pending');
  });
});
