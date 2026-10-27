/**
 * 审计 #52：setWebToolEnabled 并发写不再 lost update。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWebToolSettings, setWebToolEnabled } from '../core/tool/web-settings';

function createChromeStub() {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(value)) storage.set(k, v);
        }),
      },
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('setWebToolEnabled 串行化', () => {
  it('并发两次写不同 key，最终态包含两次修改（不 lost update）', async () => {
    vi.stubGlobal('chrome', createChromeStub());
    await Promise.all([
      setWebToolEnabled('web_search', false),
      setWebToolEnabled('web_fetch', false),
    ]);
    const final = await getWebToolSettings();
    expect(final.web_search).toBe(false);
    expect(final.web_fetch).toBe(false);
  });
});
