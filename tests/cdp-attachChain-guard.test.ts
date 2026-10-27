/**
 * Guard: BrowserConnection.attach — attachChain 串行化 (审计 #87)
 *
 * 原代码 attach 没有锁,并发 attach(A)/attach(B) 交错时 attachedTabId 会被后者
 * 提前改写,导致 sendCommand 用错 tab。修复后用 attachChain Promise 链把整个
 * attachInner(含内部 detach)串行化。
 *
 * 本测试守护:
 *   1. 并发 attach 不会交错改写 attachedTabId — attach(1) resolve 后 tabId 仍为 1,
 *      等 attach(2) 跑完才变 2
 *   2. attach(1) 挂起期间,没有"并发 attach"报错 (fake debuggerApi.attach 会在
 *      pendingAttach 非空时抛错,用来证明 attach(2) 确实被排队了)
 *   3. sendCommand 命中当前 attachedTabId
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserConnection } from '../core/browser-control/cdp';

function createDeferrableDebuggerApi() {
  const attached: Map<number, boolean> = new Map();
  let pendingAttach: { tabId: number; resolve: () => void } | null = null;

  const debuggerApi = {
    attach: vi.fn(async ({ tabId }: { tabId: number }) => {
      attached.set(tabId, true);
      if (pendingAttach) {
        throw new Error('concurrent attach detected — attachChain is broken');
      }
      return new Promise<void>((resolve) => {
        pendingAttach = { tabId, resolve };
      });
    }),
    detach: vi.fn(async ({ tabId }: { tabId: number }) => {
      attached.delete(tabId);
    }),
    sendCommand: vi.fn(
      async (_source: any, _method: string, _params?: Record<string, unknown>) => ({}),
    ),
    onDetach: { addListener: vi.fn() },
    onEvent: { addListener: vi.fn() },
  };

  function resolvePending() {
    if (pendingAttach) {
      const r = pendingAttach.resolve;
      pendingAttach = null;
      r();
    }
  }

  function hasPending() {
    return pendingAttach !== null;
  }

  function pendingTabId() {
    return pendingAttach?.tabId ?? null;
  }

  return { debuggerApi, resolvePending, hasPending, pendingTabId, attached };
}

describe('BrowserConnection.attach — attachChain 串行化 (审计 #87)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('并发 attach(1)/attach(2) 通过 attachChain 排队,不交错改写 attachedTabId', async () => {
    const { debuggerApi, resolvePending, hasPending, pendingTabId, attached } =
      createDeferrableDebuggerApi();

    const chromeStub = { debugger: debuggerApi } as unknown as typeof chrome;
    const conn = new BrowserConnection(chromeStub);

    // --- 第一轮:fire attach(1) → 挂起 ---
    const p1 = conn.attach(1);
    await Promise.resolve(); // 排空微任务,让 attachInner(1) 跑起来

    // attach(1) 应已调 debugger.attach(1) 并挂起
    expect(hasPending()).toBe(true);
    expect(pendingTabId()).toBe(1);
    // tabId 还没被设置(attach 还没 resolve)
    expect(conn.tabId).toBeNull();

    // --- 第二轮:fire attach(2) → 应被 attachChain 排队,不会立刻调 debugger.attach(2) ---
    const p2 = conn.attach(2);
    await Promise.resolve(); // 让 attachChain 链推进,但 attachInner(2) 还在排队

    // 关键:debugger.attach 只应该被调了 1 次(attach 调用数)
    // 如果 attachChain 坏了,attach(2) 会立刻调 debugger.attach(2),
    // 但 pendingAttach 还非空,会抛 'concurrent attach'
    expect(debuggerApi.attach).toHaveBeenCalledTimes(1);
    expect(hasPending()).toBe(true);
    expect(pendingTabId()).toBe(1); // 还是 1,没被 attach(2) 抢占

    // --- resolve 第一次 attach ---
    resolvePending();
    await Promise.resolve();
    await Promise.resolve();
    // 此时 attachInner(1) 应已完成,但 attachInner(2) 还没跑
    expect(conn.tabId).toBe(1);

    // await p1 也应该 resolve 了
    await p1;

    // 再等两拍让 attachInner(2) 的 detach+attach 跑起来
    await Promise.resolve();
    await Promise.resolve();

    // 此时 debugger.attach 应该又被调了一次 —— attachInner(2) 先 detach(1) 再 attach(2)
    // detach(1) 立即 resolve,然后 attach(2) 挂起
    expect(debuggerApi.attach).toHaveBeenCalledTimes(2);
    expect(debuggerApi.detach).toHaveBeenCalledTimes(1);
    expect(hasPending()).toBe(true);
    expect(pendingTabId()).toBe(2);
    // attached set 里 1 被 detach 删除,2 被 attach 设置
    expect(attached.has(1)).toBe(false);
    expect(attached.has(2)).toBe(true);

    // --- resolve 第二次 attach ---
    resolvePending();
    await p2;
    expect(conn.tabId).toBe(2);

    // 最终 debugger.attach 总共被调了 2 次
    expect(debuggerApi.attach).toHaveBeenCalledTimes(2);
    // sendCommand 被调了:attach(1) 5次 + attach(2) 5次 = 10次
    expect(debuggerApi.sendCommand).toHaveBeenCalledTimes(10);
  });

  it('attach(1) 挂起期间 sendCommand 应被拦截(not attached 错误),而不是打到错误 tab', async () => {
    const { debuggerApi, resolvePending, hasPending } = createDeferrableDebuggerApi();
    const chromeStub = { debugger: debuggerApi } as unknown as typeof chrome;
    const conn = new BrowserConnection(chromeStub);

    const p1 = conn.attach(1);
    await Promise.resolve(); // 让 attachInner 跑完 debugger.attach 调用
    expect(hasPending()).toBe(true);

    // attach 还在挂起,attachedTabId 仍是 null,sendCommand 应抛 not_attached
    await expect(conn.sendCommand('Runtime.enable')).rejects.toThrow(
      /No browser tab is attached/,
    );

    // resolve attach(1) 后 sendCommand 正常
    resolvePending();
    await p1;

    // 验证 sendCommand 命中 tab 1 的 session
    await conn.sendCommand('Foo.bar');
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Foo.bar',
      undefined,
    );
  });

  it('attachChain 正常排队:两个 attach 都能完成,最终 tabId = 2', async () => {
    const { debuggerApi, resolvePending, hasPending } = createDeferrableDebuggerApi();
    const chromeStub = { debugger: debuggerApi } as unknown as typeof chrome;
    const conn = new BrowserConnection(chromeStub);

    const p1 = conn.attach(1);
    await Promise.resolve(); // 让 attachInner(1) 调 debugger.attach
    expect(hasPending()).toBe(true);
    expect(debuggerApi.attach).toHaveBeenCalledTimes(1);

    // attach(2) 被 attachChain 排队,不会立刻调 debugger.attach
    const p2 = conn.attach(2);
    await Promise.resolve();
    expect(debuggerApi.attach).toHaveBeenCalledTimes(1); // 还是 1,证明排队了

    // resolve attach(1)
    resolvePending();
    await p1;
    await Promise.resolve();
    await Promise.resolve(); // 让 attachInner(2) 的 detach+attach 跑起来

    expect(debuggerApi.detach).toHaveBeenCalledTimes(1);
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 1 });
    expect(hasPending()).toBe(true);

    // resolve attach(2)
    resolvePending();
    await p2;
    expect(conn.tabId).toBe(2);
  });
});
