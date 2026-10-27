/**
 * 审计 #74：`transport.url` 必须在**保存期**校验，而不是等到使用期。
 *
 * 之前只有 `getMcpEndpointUrl`（transports/transport-endpoint.ts）在真正发请求时校验协议，
 * 于是 `javascript:` / `file:` / 空串这类 URL 可以**先落库**，直到第一次调用才失败 ——
 * 而探测、展示、导出等路径根本不经过那层校验。
 *
 * 变异方式：把 `createMcpServer` 里的 `assertTransportUrlOrThrow(input.transport ?? {})`
 * 和 `normalizeServerForMutation` 里的调用删掉 ⇒ 前四条必须红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../core/mcp/store';

function stubStorage(): void {
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in store) out[k] = store[k];
          return out;
        }),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          Object.assign(store, patch);
        }),
        remove: vi.fn(async () => undefined),
      },
    },
  });
}

describe('审计 #74：MCP server URL 保存期校验', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('★ javascript: 协议必须被拒绝（XSS 面）', async () => {
    await expect(
      createMcpServer({ displayName: 'x', transport: { kind: 'http', url: 'javascript:alert(1)' } } as never),
    ).rejects.toThrowError(/Unsupported MCP server URL protocol: javascript:/);
  });

  it('★ file: 协议必须被拒绝（本地文件面）', async () => {
    await expect(
      createMcpServer({ displayName: 'x', transport: { kind: 'http', url: 'file:///etc/passwd' } } as never),
    ).rejects.toThrowError(/Unsupported MCP server URL protocol: file:/);
  });

  it('★ URL 型传输缺 url 必须被拒绝', async () => {
    await expect(
      createMcpServer({ displayName: 'x', transport: { kind: 'sse', url: '' } } as never),
    ).rejects.toThrowError(/requires a URL/);
  });

  it('★ 无法解析的 url 必须被拒绝', async () => {
    await expect(
      createMcpServer({ displayName: 'x', transport: { kind: 'streamable_http', url: 'not a url' } } as never),
    ).rejects.toThrowError(/Invalid MCP server URL/);
  });

  it('负控：合法 https URL 可以创建（校验不能误伤）', async () => {
    stubStorage();
    const created = await createMcpServer({
      displayName: 'ok',
      transport: { kind: 'http', url: 'https://ok.example/mcp' },
    } as never);
    expect(created.transport.url).toBe('https://ok.example/mcp');
  });

  it('负控：非 URL 型传输（stdio_bridge）不要求 url', async () => {
    stubStorage();
    const created = await createMcpServer({
      displayName: 'bridge',
      transport: { kind: 'stdio_bridge', command: 'node' },
    } as never);
    expect(created.transport.kind).toBe('stdio_bridge');
  });
});
