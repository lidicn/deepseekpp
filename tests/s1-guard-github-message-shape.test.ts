/**
 * S1 守护用例（审计 P2-57，core/skill/github-importer.ts fetchGitHubJson）。
 *
 * 修复前：HTTP 200 但 body 是 {message:'Not Found'}（仓库被重命名/权限变更）时
 * 直接 as T 返回，undefined 字段静默流到下游。修复后：识别「带 message 且缺常见数据
 * 字段」的 200 响应并显式抛 `GitHub 返回错误信息: ...`。
 *
 * 经 previewGitHubSkillSource 驱动：它第一次 fetch 就是 /repos/:owner/:repo。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/mcp/store', () => ({
  getAllMcpServers: vi.fn(),
  getMcpToolCache: vi.fn(),
  updateMcpServer: vi.fn(),
}));
vi.mock('../core/mcp/discovery', () => ({
  executeMcpToolCall: vi.fn(),
  getMcpToolDescriptors: vi.fn(),
  refreshMcpServerDiscovery: vi.fn(),
}));

import { previewGitHubSkillSource } from '../core/skill/github-importer';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('S1 P2-57: 200 但 {message} 错误形状必须抛错', () => {
  it('body={message:"Not Found"} 且无 content/sha/tree/entries ⇒ 抛 GitHub 返回错误信息', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Not Found' })));
    await expect(previewGitHubSkillSource('https://github.com/owner/repo'))
      .rejects.toThrow(/GitHub 返回错误信息: Not Found/);
  });

  it('对照：正常仓库形状（带 default_branch、无 message）不在此守卫处抛错', async () => {
    // 只验「不被误判为错误形状」：它会继续去拉 tree/packageInfo 并因我们只桩了一次而
    // 在后续调用报错，但绝不能是 "GitHub 返回错误信息"。
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/repos/owner/repo')) {
        return jsonResponse({ default_branch: 'main', full_name: 'owner/repo' });
      }
      throw new Error('network: stop here');
    }));
    const err = await previewGitHubSkillSource('https://github.com/owner/repo').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('GitHub 返回错误信息');
  });
});
