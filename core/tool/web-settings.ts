/**
 * Per-tool enabled/disabled settings for built-in web tools.
 * Stored in chrome.storage.local so settings persist across sessions.
 */

import { WEB_SEARCH_TOOL_NAMES, type WebSearchToolName } from './web-search';

const STORAGE_KEY = 'deepseek_pp_web_tool_settings';

export type WebToolSettings = Record<WebSearchToolName, boolean>;

const DEFAULT_SETTINGS: WebToolSettings = {
  web_search: true,
  web_fetch: true,
};

export async function getWebToolSettings(): Promise<WebToolSettings> {
  const data = (await chrome.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
  const stored = data[STORAGE_KEY];
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    return {
      ...DEFAULT_SETTINGS,
      ...(stored as Partial<WebToolSettings>),
    };
  }
  return { ...DEFAULT_SETTINGS };
}

// 审计 #52：setWebToolEnabled 是 get→改→set 的 read-modify-write，无互斥。
// 并发切换两个工具时后写覆盖先写（lost update）。用模块内 promise 链串行化同 key 的写。
let writeChain: Promise<void> = Promise.resolve();

export async function setWebToolEnabled(name: WebSearchToolName, enabled: boolean): Promise<void> {
  const task = writeChain.then(async () => {
    const current = await getWebToolSettings();
    current[name] = enabled;
    await chrome.storage.local.set({ [STORAGE_KEY]: current });
  });
  // 链上挂住后续写，即使这次失败也不阻塞下一次（吞掉 rejection 让链继续）
  writeChain = task.catch(() => undefined);
  return task;
}

export async function isWebToolEnabled(name: WebSearchToolName): Promise<boolean> {
  const settings = await getWebToolSettings();
  return settings[name] ?? true;
}
