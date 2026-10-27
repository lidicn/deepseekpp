import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserConnection } from '../core/browser-control/cdp';
import { BrowserControlService } from '../core/browser-control/service';
import { DEFAULT_BROWSER_CONTROL_SETTINGS } from '../core/browser-control/settings';
import { BROWSER_CONTROL_STORAGE_KEY } from '../core/browser-control/types';

/**
 * 审计 #26 守卫：所有 resolveElement 获取的 objectId 必须 finally 释放。
 * 变异自证：删 service.ts 某方法的 finally { releaseObject } 块 → 对应用例红。
 */

const FAKE_SETTINGS = { ...DEFAULT_BROWSER_CONTROL_SETTINGS, enabled: true, targetTabId: 12 };

function createFakeChrome(): typeof chrome {
  return {
    debugger: {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async () => ({})),
      onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
      onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    storage: {
      local: {
        get: vi.fn(async (_keys) => ({ [BROWSER_CONTROL_STORAGE_KEY]: FAKE_SETTINGS })),
        set: vi.fn(async (_items) => undefined),
        remove: vi.fn(async (_keys) => undefined),
        clear: vi.fn(async () => undefined),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabs: {
      get: vi.fn(async (tid) => ({ id: tid, url: 'https://example.com/', active: true, windowId: 1, groupId: -1 })),
      query: vi.fn(async () => [{ id: 12, url: 'https://example.com/', active: true, windowId: 1 }]),
      update: vi.fn(async () => undefined),
      create: vi.fn(async (p) => ({ id: p?.url ? 99 : undefined, url: p?.url ?? '' })),
      remove: vi.fn(async () => undefined),
    },
    windows: {
      getCurrent: vi.fn(async () => ({ id: 1 })),
      getAll: vi.fn(async () => [{ id: 1 }]),
    },
    runtime: { lastError: undefined as unknown as undefined | { message: string } },
  } as unknown as typeof chrome;
}

describe('#26 objectId release guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('browser_click 成功后释放 objectId', async () => {
    vi.stubGlobal('chrome', createFakeChrome());

    vi.spyOn(BrowserConnection.prototype, 'sendCommand').mockImplementation(
      async (method: string, _params?: Record<string, unknown>) => {
        switch (method) {
          case 'Runtime.evaluate':
            return { result: { objectId: 'fake-obj-1', type: 'object', subtype: 'node' } };
          case 'Runtime.callFunctionOn':
            return { result: { value: { x: 50, y: 25, width: 100, height: 50, visible: true } } };
          default:
            return {};
        }
      },
    );
    const releaseSpy = vi.spyOn(BrowserConnection.prototype, 'releaseObject').mockResolvedValue(undefined);

    const service = new BrowserControlService();
    const result = await service.execute('browser_click', { selector: '#btn', action: 'click' });
    if (!result.ok) console.error('CLICK FAIL:', result.error?.message);

    expect(result.ok).toBe(true);
    expect(releaseSpy).toHaveBeenCalledOnce();
    expect(releaseSpy).toHaveBeenCalledWith('fake-obj-1');
  });

  it('browser_click 中间抛错时 finally 仍释放 objectId', async () => {
    vi.stubGlobal('chrome', createFakeChrome());

    vi.spyOn(BrowserConnection.prototype, 'sendCommand').mockImplementation(
      async (method: string, _params?: Record<string, unknown>) => {
        if (method === 'Input.dispatchMouseEvent') {
          throw new Error('CDP broken for test');
        }
        switch (method) {
          case 'Runtime.evaluate':
            return { result: { objectId: 'fake-obj-2', type: 'object', subtype: 'node' } };
          case 'Runtime.callFunctionOn':
            return { result: { value: { x: 50, y: 25, width: 100, height: 50, visible: true } } };
          default:
            return {};
        }
      },
    );
    const releaseSpy = vi.spyOn(BrowserConnection.prototype, 'releaseObject').mockResolvedValue(undefined);

    const service = new BrowserControlService();
    const result = await service.execute('browser_click', { selector: '#btn', action: 'click' });

    expect(result.ok).toBe(false);
    expect(releaseSpy).toHaveBeenCalledOnce();
    expect(releaseSpy).toHaveBeenCalledWith('fake-obj-2');
  });

  it('browser_fill 成功后释放 objectId', async () => {
    vi.stubGlobal('chrome', createFakeChrome());

    vi.spyOn(BrowserConnection.prototype, 'sendCommand').mockImplementation(
      async (method: string, _params?: Record<string, unknown>) => {
        switch (method) {
          case 'Runtime.evaluate':
            return { result: { objectId: 'fake-obj-3', type: 'object', subtype: 'node' } };
          default:
            return {};
        }
      },
    );
    const releaseSpy = vi.spyOn(BrowserConnection.prototype, 'releaseObject').mockResolvedValue(undefined);

    const service = new BrowserControlService();
    const result = await service.execute('browser_fill', { selector: '#input', value: 'hello' });
    if (!result.ok) console.error('FILL FAIL:', result.error?.message);

    expect(result.ok).toBe(true);
    expect(releaseSpy).toHaveBeenCalledOnce();
    expect(releaseSpy).toHaveBeenCalledWith('fake-obj-3');
  });
});
