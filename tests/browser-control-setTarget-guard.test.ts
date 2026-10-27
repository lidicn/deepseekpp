/**
 * Guard: BrowserControlService.setTarget — save BEFORE detach ordering (审计 #82)
 *
 * 原代码先 detach 再 save：save 抛错时 debugger 已摘，但持久化 targetTabId
 * 仍指旧 tab ⇒ 状态不一致。修复后先 save，成功才 detach。
 *
 * 本测试守护这个顺序：
 *   - 消极：save 抛错（如 quota exceeded）时，detach MUST NOT 被调用
 *   - 积极：save 正常成功时，detach MUST 被调用（当 target 变化且已 attached）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserControlService } from '../core/browser-control/service';
import { BrowserConnection } from '../core/browser-control/cdp';
import {
  DEFAULT_BROWSER_CONTROL_SETTINGS,
} from '../core/browser-control/settings';
import { BROWSER_CONTROL_STORAGE_KEY } from '../core/browser-control/types';

describe('BrowserControlService.setTarget: save BEFORE detach (审计 #82)', () => {
  let storage: Map<string, unknown>;
  let chromeStub: ReturnType<typeof createChromeStub>;

  beforeEach(() => {
    storage = new Map();
    chromeStub = createChromeStub(storage, [
      createTab({ id: 5, active: true, title: 'Old', url: 'https://old.example.com/' }),
      createTab({ id: 12, active: false, title: 'New', url: 'https://new.example.com/' }),
    ]);
    vi.stubGlobal('chrome', chromeStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('消极：save 抛 quota 错误时，detach 不应被调用（旧顺序会提前 detach）', async () => {
    // 设置初始状态：旧 target = 5
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      targetTabId: 5,
    });

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });

    // 让 connection attached 到旧 tab 5（通过类型断言访问 private 属性）
    const conn = (service as unknown as { connection: BrowserConnection | null }).connection;
    expect(conn).not.toBeNull();
    await conn!.attach(5);
    expect(conn!.attached).toBe(true);

    // 关键：让 storage.local.set throw — 模拟 quota exceeded
    // saveBrowserControlSettings 内部就是调 chrome.storage.local.set
    chromeStub.storage.local.set.mockRejectedValueOnce(new Error('Quota exceeded'));

    // 调用 setTarget 切换到 tab 12 — 应在 save 处抛错
    await expect(service.setTarget(12)).rejects.toThrow('Quota exceeded');

    // ★ 核心守卫断言：detach 绝对不能被调用！
    // 如果 detach 被调了 ⇒ 代码顺序就是错的（先 detach 再 save）
    // save 失败意味着新 target 还没持久化，debugger 绝不能先摘
    expect(chromeStub.debugger.detach).not.toHaveBeenCalled();
    expect(conn!.attached).toBe(true);  // connection 保持 attached
  });

  it('积极：save 成功时，detach 应被调用（target 变化且已 attached）', async () => {
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      targetTabId: 5,
    });

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });

    const conn = (service as unknown as { connection: BrowserConnection | null }).connection;
    expect(conn).not.toBeNull();
    await conn!.attach(5);
    expect(conn!.attached).toBe(true);

    // save 正常成功 — 不 mock rejection
    const result = await service.setTarget(12);

    expect(result.id).toBe(12);
    // save 成功后 detach 被调用一次
    expect(chromeStub.debugger.detach).toHaveBeenCalledOnce();
    expect(chromeStub.debugger.detach).toHaveBeenCalledWith({ tabId: 5 });
    // BrowserConnection 内部状态也更新了
    expect(conn!.attached).toBe(false);
    // storage 已持久化新 target
    expect(storage.get(BROWSER_CONTROL_STORAGE_KEY)).toMatchObject({ targetTabId: 12 });
  });

  it('同 tabId 切换：即使已 attached 也不调 detach（current.targetTabId === tabId）', async () => {
    storage.set(BROWSER_CONTROL_STORAGE_KEY, {
      ...DEFAULT_BROWSER_CONTROL_SETTINGS,
      targetTabId: 5,
    });

    const service = new BrowserControlService({ chromeApi: chromeStub as unknown as typeof chrome });

    const conn = (service as unknown as { connection: BrowserConnection | null }).connection;
    expect(conn).not.toBeNull();
    await conn!.attach(5);
    expect(conn!.attached).toBe(true);

    // 切到同一个 tabId 5
    const result = await service.setTarget(5);

    expect(result.id).toBe(5);
    expect(chromeStub.debugger.detach).not.toHaveBeenCalled();
    expect(conn!.attached).toBe(true);
  });
});

// --- helpers (复用 browser-control.test.ts 的模式) ---

function createTab(overrides: Partial<chrome.tabs.Tab> & { id: number }): chrome.tabs.Tab {
  return {
    id: overrides.id,
    windowId: overrides.windowId ?? 1,
    groupId: overrides.groupId ?? -1,
    active: overrides.active ?? false,
    title: overrides.title ?? '',
    url: overrides.url ?? 'about:blank',
    pendingUrl: overrides.pendingUrl,
    highlighted: false,
    incognito: false,
    index: 0,
    pinned: false,
    selected: false,
    discarded: false,
    frozen: false,
    autoDiscardable: true,
  };
}

function createChromeStub(
  storage: Map<string, unknown>,
  initialTabs: chrome.tabs.Tab[] = [],
) {
  let nextTabId = 100;
  let attachedTabId: number | null = null;
  const tabs = new Map<number, chrome.tabs.Tab>(
    initialTabs.map((tab) => [tab.id!, { ...tab }]),
  );

  return {
    runtime: {
      id: 'extension-id',
      sendMessage: vi.fn(),
      getURL: vi.fn(),
      connectNative: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          for (const [key, storedValue] of Object.entries(value)) storage.set(key, storedValue);
        }),
      },
    },
    debugger: {
      attach: vi.fn(async (source: chrome.debugger.Debuggee) => {
        attachedTabId = source.tabId ?? null;
      }),
      detach: vi.fn(async (source: chrome.debugger.Debuggee) => {
        if (source.tabId === attachedTabId) attachedTabId = null;
      }),
      sendCommand: vi.fn(async (
        source: chrome.debugger.Debuggee,
        method: string,
        params?: Record<string, unknown>,
      ) => {
        if (source.tabId !== attachedTabId) throw new Error('No tab is attached.');
        if (method === 'Page.navigate' && typeof params?.url === 'string') {
          const tab = tabs.get(source.tabId);
          if (tab) tab.url = params.url;
        }
        return {};
      }),
      onDetach: { addListener: vi.fn() },
      onEvent: { addListener: vi.fn() },
    },
    tabs: {
      query: vi.fn(async (queryInfo: chrome.tabs.QueryInfo = {}) => {
        let result = Array.from(tabs.values());
        if (queryInfo.active === true) {
          result = result.filter((tab) => tab.active);
        }
        if (queryInfo.currentWindow === true) {
          result = result.filter((tab) => tab.windowId === 1);
        }
        return result.map((tab) => ({ ...tab }));
      }),
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        return { ...tab };
      }),
      create: vi.fn(async (options: chrome.tabs.CreateProperties) => {
        const tab = createTab({
          id: nextTabId++,
          active: options.active === true,
          url: options.url ?? 'about:blank',
        });
        if (tab.active) {
          for (const existing of tabs.values()) {
            existing.active = false;
          }
        }
        tabs.set(tab.id!, tab);
        return { ...tab };
      }),
      update: vi.fn(async (tabId: number, properties: chrome.tabs.UpdateProperties) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id ${tabId}`);
        if (properties.active === true) {
          for (const existing of tabs.values()) {
            existing.active = false;
          }
          tab.active = true;
        }
        if (typeof properties.url === 'string') {
          tab.url = properties.url;
        }
        return { ...tab };
      }),
      remove: vi.fn(async (tabId: number) => {
        tabs.delete(tabId);
      }),
    },
    tabGroups: {
      query: vi.fn(),
    },
  };
}
