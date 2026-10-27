import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserConnection, BrowserControlError } from '../core/browser-control/cdp';

describe('审计 #90/#93：sendCommand 超时守卫（覆盖 evaluateScript/AXTree）', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it('sendCommand 永不 resolve → 超时错误', async () => {
    let callCount = 0;
    const debuggerApi = {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => {
        // 前 5 次是 attach 里的 enable 命令，正常 resolve；第 6 次开始永远挂起
        callCount++;
        if (callCount <= 5) return {};
        return new Promise<Record<string, unknown>>(() => {});
      }),
      onDetach: { addListener: vi.fn() },
      onEvent: { addListener: vi.fn() },
    };
    const chromeStub = { debugger: debuggerApi } as unknown as typeof chrome;
    const conn = new BrowserConnection(chromeStub);
    await conn.attach(1);
    // attach 调了 Runtime.enable/Page.enable/DOM.enable/Accessibility.enable/Target.setAutoAttach = 5 次
    expect(callCount).toBe(5);

    const t0 = Date.now();
    await expect(
      conn.sendCommand('Runtime.evaluate', undefined, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'browser_control_command_timeout' });
    // 超时后应该大约 100ms 就 reject，不能 > 2s
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(debuggerApi.sendCommand).toHaveBeenCalledTimes(6); // attach 5 + 本次 1
  }, 5000);

  it('正常 resolve → 不触发超时（正向不回归）', async () => {
    let callCount = 0;
    const debuggerApi = {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => {
        callCount++;
        if (callCount <= 5) return {}; // attach 的 enable 命令
        return { nodes: [{}, {}, {}] }; // AXTree 形状
      }),
      onDetach: { addListener: vi.fn() },
      onEvent: { addListener: vi.fn() },
    };
    const chromeStub = { debugger: debuggerApi } as unknown as typeof chrome;
    const conn = new BrowserConnection(chromeStub);
    await conn.attach(1);

    const result = await conn.sendCommand('Accessibility.getFullAXTree', undefined, { timeoutMs: 500 });
    expect((result as { nodes?: unknown[] }).nodes).toHaveLength(3);
  }, 5000);
});
